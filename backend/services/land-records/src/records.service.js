import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, NotFoundError, normalizeSearch } from '@lrfe/common';
import { PARCEL_KINDS, formatRecordNo, kindOf, parcelKey, parcelLabel, schemaFor, validateVersion } from './catalogue.js';
import { verifyChain } from './seal.js';
import { parcelFromProperty, propertyMatches } from './parcel-match.js';
import { checksFor, sameName, suggestFromDocuments } from './derive.js';

export { propertyMatches };

/** Core fields an officer edits in a draft (README.md section 2); `documents` change by link and unlink. */
const EDITABLE = ['parcel', 'extent', 'tenure', 'owners', 'encumbrances', 'attributes'];
/** Core fields that can be taken over from the documents' suggestions. */
const SUGGESTED = ['owners', 'extent', 'encumbrances'];

const SYSTEM = { id: 'system', name: 'System' };

/** Text a record is found by: record number, parcel, owners' names and ID numbers. */
export function searchTextOf(record, ...datas) {
    const parts = [record.recordNo, record.label, record.parcelKey];
    for (const data of datas.filter(Boolean)) {
        for (const o of data.owners || []) parts.push(o.name, o.idNo);
        for (const d of data.documents || []) parts.push(d.ref, d.edrmsNo);
    }
    return parts.filter(Boolean).join(' · ');
}

/**
 * Land records (README.md): creating a record with its first draft, editing the draft (core fields,
 * pinned documents, suggestions and checks, comments), and reading records, versions and the seal
 * chain. Review and commit follow in API-647 and API-648.
 */
export class RecordsService {
    constructor({ repo, events, edrms = null, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.events = events;
        this.edrms = edrms;
        this.clock = clock;
        this.config = { country: 'NA', ...config };
    }

    catalogue() {
        return { parcelKinds: PARCEL_KINDS.map(k => ({ ...k, schema: schemaFor(k.schemaVersion), draftSchema: schemaFor(k.schemaVersion, { complete: false }) })) };
    }

    async requireRecord(id) {
        const r = await this.repo.getRecord(id);
        if (!r) throw new NotFoundError('Land record not found');
        return r;
    }

    // ---------------------------------------------------------------- create

    /**
     * A new record for a parcel, with an empty draft v1. One record per parcel. With
     * `edrmsDocumentId` (and no parcel): the parcel is read from that filed document's property
     * field, and the document is linked to the new draft.
     */
    async createRecord({ parcel, attributes, edrmsDocumentId }, actor = SYSTEM) {
        if (edrmsDocumentId && !parcel) {
            const doc = await this.requireDocument(edrmsDocumentId);
            parcel = parcelFromProperty(doc.props?.property, doc.props);
            if (!parcel) throw new BadRequestError(`The parcel cannot be read from ${doc.edrmsNo} ("${doc.props?.property ?? ''}"): give the parcel`);
        }
        const kind = kindOf(parcel?.kind);
        if (!kind) throw new BadRequestError(`parcel.kind must be one of ${PARCEL_KINDS.map(k => k.id).join(', ')}`);
        const data = { schemaVersion: kind.schemaVersion, parcel, owners: [], encumbrances: [], documents: [], ...(attributes ? { attributes } : {}) };
        const problems = validateVersion(data);
        if (problems.length) throw new BadRequestError('The record data is not valid', { problems });
        const missing = kind.parcelRequired.filter(f => !String(parcel[f] ?? '').trim());
        if (missing.length) throw new BadRequestError(`The parcel needs: ${missing.join(', ')}`, { missing });
        const key = parcelKey(parcel);
        const existing = await this.repo.findRecord({ parcelKey: key });
        if (existing) throw new ConflictError(`${parcelLabel(parcel)} already has a land record (${existing.recordNo})`, { recordId: existing.id, recordNo: existing.recordNo });

        const id = randomUUID(), now = this.clock();
        const record = await this.repo.createRecord({
            year: now.getUTCFullYear(),
            build: (seq) => {
                const r = {
                    id, recordNo: formatRecordNo(this.config.country, now.getUTCFullYear(), seq), parcelKey: key, kind: kind.id, label: parcelLabel(parcel),
                    status: 'draft', currentVersion: null, draftVersion: 1, draftState: 'draft', flags: [],
                    createdAt: now, createdById: actor.id, createdByName: actor.name ?? null, updatedAt: now
                };
                r.searchText = searchTextOf(r, data);
                const version = {
                    id: randomUUID(), recordId: id, versionNumber: 1, state: 'draft', revision: 1, schemaVersion: kind.schemaVersion, data,
                    derived: suggestFromDocuments([]), checks: checksFor(data), changes: [{ at: now.toISOString(), byId: actor.id, byName: actor.name ?? null, action: 'create' }], createdAt: now, createdById: actor.id, createdByName: actor.name ?? null, updatedAt: now
                };
                return { record: r, version };
            }
        });
        await this.events?.publish('records.record.created', { recordId: id, recordNo: record.recordNo, parcelKey: key }, { actor });
        if (edrmsDocumentId) return this.addDocument(id, { revision: 1, edrmsDocumentId }, actor);
        return this.getRecord(id);
    }

    // ---------------------------------------------------------------- editing a draft (API-646)

    /** The record's open draft, which must not be in review. */
    async requireDraft(recordId) {
        const record = await this.requireRecord(recordId);
        if (!record.draftVersion) throw new ConflictError('The record has no open draft');
        if (record.draftState !== 'draft') throw new ConflictError('The draft is in review and cannot be changed');
        return { record, version: await this.repo.getVersion(recordId, record.draftVersion) };
    }

    async requireDocument(edrmsDocumentId) {
        const doc = await this.requireEdrms().getDocument(edrmsDocumentId);
        if (!doc) throw new NotFoundError('Document not found in the EDRMS');
        return doc;
    }

    /**
     * Store a changed draft: suggestions and checks recomputed, revision + 1 (only if nobody saved
     * in between), the change logged on the version and published.
     */
    async saveDraft({ record, version }, revision, data, change, actor) {
        const conflict = () => new ConflictError('The draft was changed by someone else: reload it and try again', { revision: version.revision });
        if (revision !== version.revision) throw conflict();
        const problems = validateVersion(data);
        if (problems.length) throw new BadRequestError('The record data is not valid', { problems });
        const derived = suggestFromDocuments(data.documents);
        const now = this.clock();
        const entry = { at: now.toISOString(), byId: actor.id, byName: actor.name ?? null, ...change };
        const saved = await this.repo.updateVersion(record.id, version.versionNumber, {
            data, derived, checks: checksFor(data, { flags: record.flags, suggested: derived }),
            revision: revision + 1, changes: [...(version.changes || []), entry], updatedAt: now
        }, { expectedRevision: revision });
        if (!saved) throw conflict();
        const current = record.currentVersion ? await this.repo.getVersion(record.id, record.currentVersion) : null;
        const label = parcelLabel(data.parcel), key = parcelKey(data.parcel);
        await this.repo.updateRecord(record.id, { label, parcelKey: key, updatedAt: now, searchText: searchTextOf({ ...record, label, parcelKey: key }, current?.data, data) });
        await this.events?.publish('records.draft.changed', {
            recordId: record.id, recordNo: record.recordNo, versionNumber: version.versionNumber, revision: revision + 1, change: entry
        }, { actor });
        return this.getRecord(record.id);
    }

    /**
     * Edit the draft's core fields and attributes (`changes`; null removes a field), and/or take over
     * the documents' suggestions (`accept`: owners, extent, encumbrances). Owners or an extent that
     * differ from the suggestions are marked as entered by hand and need a `reason`.
     */
    async updateDraft(recordId, { revision, changes = {}, accept = [], reason } = {}, actor = SYSTEM) {
        const draft = await this.requireDraft(recordId);
        const unknown = Object.keys(changes).filter(k => !EDITABLE.includes(k));
        if (unknown.length) throw new BadRequestError(`Cannot change: ${unknown.join(', ')} (editable: ${EDITABLE.join(', ')})`);
        const badAccept = accept.filter(k => !SUGGESTED.includes(k));
        if (badAccept.length) throw new BadRequestError(`No suggestions for: ${badAccept.join(', ')}`);
        if (!Object.keys(changes).length && !accept.length) throw new BadRequestError('Nothing to change');
        const overlap = accept.filter(k => k in changes);
        if (overlap.length) throw new BadRequestError(`Either accept or change: ${overlap.join(', ')}`);

        const old = draft.version.data;
        const data = structuredClone(old);
        const suggested = suggestFromDocuments(old.documents);

        if ('parcel' in changes) {
            const parcel = changes.parcel;
            if (!parcel || parcel.kind !== old.parcel.kind) throw new BadRequestError(`The parcel kind cannot change (${old.parcel.kind}): create a new record`);
            const missing = kindOf(parcel.kind).parcelRequired.filter(f => !String(parcel[f] ?? '').trim());
            if (missing.length) throw new BadRequestError(`The parcel needs: ${missing.join(', ')}`, { missing });
            const other = await this.repo.findRecord({ parcelKey: parcelKey(parcel) });
            if (other && other.id !== recordId) throw new ConflictError(`${parcelLabel(parcel)} already has a land record (${other.recordNo})`, { recordId: other.id, recordNo: other.recordNo });
        }
        for (const [k, v] of Object.entries(changes)) {
            if (v === null && k !== 'parcel') delete data[k];
            else data[k] = structuredClone(v);
        }
        for (const k of accept) {
            const value = suggested[k];
            if (!value || (Array.isArray(value) && !value.length && k !== 'encumbrances')) throw new BadRequestError(`The documents suggest no ${k} yet`);
            data[k] = structuredClone(value);
        }

        // values that are not what the documents say: entered by hand, with a reason
        const byHand = [];
        if (Array.isArray(changes.owners)) {
            data.owners = changes.owners.map(o => {
                const fromDocs = suggested.owners?.find(s => sameName(s.name, o.name) && s.share === o.share && (s.idNo ?? null) === (o.idNo ?? null));
                if (fromDocs) return { ...o, since: o.since ?? fromDocs.since, source: fromDocs.source };
                const why = reason || (o.source?.from === 'manual' ? o.source.reason : null);
                byHand.push({ what: `owner ${o.name}`, why });
                return { ...o, source: { from: 'manual', by: actor.name ?? actor.id, ...(why ? { reason: why } : {}) } };
            });
        }
        if (changes.extent) {
            const s = suggested.extent;
            if (s && s.value === changes.extent.value && s.unit === changes.extent.unit) data.extent = { ...changes.extent, source: s.source };
            else {
                const why = reason || (changes.extent.source?.from === 'manual' ? changes.extent.source.reason : null);
                byHand.push({ what: 'extent', why });
                data.extent = { ...changes.extent, source: { from: 'manual', by: actor.name ?? actor.id, ...(why ? { reason: why } : {}) } };
            }
        }
        const unexplained = byHand.filter(x => !x.why);
        if (unexplained.length) throw new BadRequestError(`Give a reason for the values entered by hand: ${unexplained.map(x => x.what).join(', ')}`, { byHand: unexplained.map(x => x.what) });

        const fields = [...Object.keys(changes), ...accept];
        return this.saveDraft(draft, revision, data, {
            action: 'edit', fields, ...(accept.length ? { accepted: accept } : {}), ...(byHand.length ? { byHand: byHand.map(x => x.what), reason } : {})
        }, actor);
    }

    /** Pin a filed document into the draft, at its current EDRMS version and seal. */
    async addDocument(recordId, { revision, edrmsDocumentId }, actor = SYSTEM) {
        const draft = await this.requireDraft(recordId);
        const data = structuredClone(draft.version.data);
        data.documents = data.documents || [];
        if (data.documents.some(d => d.edrmsDocumentId === edrmsDocumentId)) throw new ConflictError('The document is already in this record');
        const doc = await this.requireDocument(edrmsDocumentId);
        const v = (doc.versions || []).find(x => x.versionNumber === doc.currentVersion);
        if (!v?.seal) throw new ConflictError(`${doc.edrmsNo} has no sealed current version`);
        const fields = Object.fromEntries(Object.entries(doc.props || {}).filter(([, val]) => val !== null && val !== undefined && val !== '').map(([k, val]) => [k, String(val)]));
        data.documents.push({
            edrmsDocumentId: doc.id, edrmsNo: doc.edrmsNo, version: v.versionNumber, seal: v.seal, docType: doc.docType, ref: doc.instrumentRef ?? null,
            addedBy: actor.id, addedAt: this.clock().toISOString(), fields
        });
        return this.saveDraft(draft, revision, data, { action: 'link', edrmsNo: doc.edrmsNo, ref: doc.instrumentRef ?? null, version: v.versionNumber }, actor);
    }

    /** Remove a document from the draft. */
    async removeDocument(recordId, edrmsDocumentId, { revision }, actor = SYSTEM) {
        const draft = await this.requireDraft(recordId);
        const data = structuredClone(draft.version.data);
        const doc = (data.documents || []).find(d => d.edrmsDocumentId === edrmsDocumentId);
        if (!doc) throw new NotFoundError('The document is not in this record');
        data.documents = data.documents.filter(d => d !== doc);
        return this.saveDraft(draft, revision, data, { action: 'unlink', edrmsNo: doc.edrmsNo, ref: doc.ref ?? null }, actor);
    }

    // ---------------------------------------------------------------- comments

    async listComments(recordId) {
        await this.requireRecord(recordId);
        return { items: await this.repo.listComments(recordId) };
    }

    async addComment(recordId, { body }, actor = SYSTEM) {
        const record = await this.requireRecord(recordId);
        const text = String(body ?? '').trim();
        if (!text) throw new BadRequestError('The comment is empty');
        return this.repo.addComment({
            id: randomUUID(), recordId, versionNumber: record.draftVersion ?? record.currentVersion ?? null,
            body: text, authorId: actor.id, authorName: actor.name ?? null, createdAt: this.clock()
        });
    }

    // ---------------------------------------------------------------- finding documents (API-645)

    requireEdrms() {
        if (!this.edrms) throw new AppError(503, 'The document store is not configured');
        return this.edrms;
    }

    /** A filed document as land records show it, with the records that already hold it. */
    documentSummary(d, pinnedBy, recordId) {
        const linked = (pinnedBy.get(d.id) || []).filter(x => x.recordId !== recordId);
        const unique = [...new Map(linked.map(x => [x.recordId, { recordId: x.recordId, recordNo: x.recordNo, label: x.label }])).values()];
        return {
            edrmsDocumentId: d.id, edrmsNo: d.edrmsNo, docType: d.docType, title: d.title, ref: d.instrumentRef ?? null,
            property: d.props?.property ?? null, currentVersion: d.currentVersion, filedAt: d.filedAt,
            inThisRecord: !!recordId && (pinnedBy.get(d.id) || []).some(x => x.recordId === recordId),
            linkedTo: unique
        };
    }

    /**
     * Search filed documents by their verified metadata (edrms searchDocuments: words, word starts,
     * spelling variants of names, document type, field filters), marking those already in a record.
     */
    async searchDocuments({ q, docType, fields = {}, recordId, limit = 50 } = {}) {
        if (recordId) await this.requireRecord(recordId);
        const { items, total } = await this.requireEdrms().searchDocuments({ q, docType, fields, limit });
        const pinnedBy = await this.repo.findRecordsPinning(items.map(d => d.id));
        return { items: items.map(d => this.documentSummary(d, pinnedBy, recordId)), total };
    }

    /**
     * Documents that match this parcel, with the reasons: the property described is this parcel;
     * or the chain of the documents already in the record (their SG diagram, their prior title,
     * deeds and bonds that cite them as prior title).
     */
    async suggestions(recordId) {
        const record = await this.requireRecord(recordId);
        const version = await this.repo.getVersion(recordId, record.draftVersion ?? record.currentVersion);
        const parcel = version.data.parcel;
        const edrms = this.requireEdrms();
        const found = new Map();                     // edrms id → { doc, reasons }
        const add = (doc, reason) => {
            const entry = found.get(doc.id) || { doc, reasons: [] };
            if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
            found.set(doc.id, entry);
        };

        // 1. the property field describes this parcel
        const { items } = await edrms.searchDocuments({ q: parcelWords(parcel), limit: 200 });
        for (const d of items) if (propertyMatches(parcel, d.props?.property)) add(d, `Property: ${d.props.property}`);

        // 2. the chain of the documents already pinned
        for (const p of version.data.documents || []) {
            const f = p.fields || {}, ref = p.ref || f.deedNo || f.sgNo;
            if (f.sgRef) for (const d of (await edrms.searchDocuments({ fields: { sgNo: f.sgRef } })).items) add(d, `SG diagram cited by ${ref}`);
            if (f.priorTitle) for (const d of (await edrms.searchDocuments({ fields: { deedNo: f.priorTitle } })).items) add(d, `Prior title of ${ref}`);
            if (ref) for (const d of (await edrms.searchDocuments({ fields: { priorTitle: ref } })).items) add(d, `Cites ${ref} as prior title`);
        }

        const pinnedBy = await this.repo.findRecordsPinning([...found.keys()]);
        const items2 = [...found.values()].map(({ doc, reasons }) => ({ ...this.documentSummary(doc, pinnedBy, recordId), reasons }));
        // not yet in this record first, then by registration reference
        items2.sort((a, b) => (a.inThisRecord - b.inThisRecord) || String(a.ref).localeCompare(String(b.ref)));
        return { recordId, parcel: parcelLabel(parcel), items: items2 };
    }

    // ---------------------------------------------------------------- reading

    summary(r) {
        return {
            id: r.id, recordNo: r.recordNo, kind: r.kind, label: r.label, parcelKey: r.parcelKey, status: r.status,
            currentVersion: r.currentVersion ?? null, draftVersion: r.draftVersion ?? null, draftState: r.draftState ?? null,
            needsReview: (r.flags || []).length > 0, flags: r.flags || [], createdAt: r.createdAt, updatedAt: r.updatedAt
        };
    }

    async listRecords({ q, status, limit, offset } = {}) {
        if (status && !['draft', 'committed', 'in_review', 'needs_review'].includes(status)) throw new BadRequestError(`Unknown status "${status}"`);
        // in_review / needs_review filter in the service: small lists, simple repos
        const base = ['draft', 'committed'].includes(status) ? status : undefined;
        const res = await this.repo.listRecords({ q, status: base, limit: status && !base ? 1000 : limit, offset: status && !base ? 0 : offset });
        let items = res.items;
        if (status === 'in_review') items = items.filter(r => r.draftState === 'in_review');
        if (status === 'needs_review') items = items.filter(r => (r.flags || []).length);
        return { items: items.map(r => this.summary(r)), total: status && !base ? items.length : res.total };
    }

    async getRecord(id) {
        const r = await this.requireRecord(id);
        const current = r.currentVersion ? await this.repo.getVersion(id, r.currentVersion) : null;
        const draft = r.draftVersion ? await this.repo.getVersion(id, r.draftVersion) : null;
        return { ...this.summary(r), current, draft };
    }

    async listVersions(id) {
        await this.requireRecord(id);
        return (await this.repo.listVersions(id)).map(v => ({
            versionNumber: v.versionNumber, state: v.state, schemaVersion: v.schemaVersion,
            createdAt: v.createdAt, createdByName: v.createdByName ?? null,
            submittedAt: v.submittedAt ?? null, submittedByName: v.submittedByName ?? null,
            approvedByName: v.approvedByName ?? null, committedAt: v.committedAt ?? null, seal: v.seal ?? null,
            changes: v.changes || []
        }));
    }

    async getVersion(id, n) {
        await this.requireRecord(id);
        const v = await this.repo.getVersion(id, n);
        if (!v) throw new NotFoundError('Version not found');
        return v;
    }

    /** Recompute the seals of all committed versions and their chain. */
    async verify(id) {
        const r = await this.requireRecord(id);
        const committed = (await this.repo.listVersions(id)).filter(v => ['committed', 'superseded'].includes(v.state));
        const versions = verifyChain(r, committed);
        return { recordId: id, recordNo: r.recordNo, intact: versions.every(v => v.intact && v.linked), versions, checkedAt: this.clock() };
    }
}

/** The words that identify a parcel in a document's text (for a first, broad search). */
function parcelWords(parcel) {
    if (parcel.kind === 'erf') return [parcel.number, parcel.township].filter(Boolean).join(' ');
    if (parcel.kind === 'farm_portion') return [parcel.farmName, parcel.farmNumber].filter(Boolean).join(' ');
    if (parcel.kind === 'sectional_unit') return [parcel.schemeName, parcel.unit].filter(Boolean).join(' ');
    return '';
}
