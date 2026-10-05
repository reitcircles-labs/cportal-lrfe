import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, NotFoundError, normalizeSearch } from '@lrfe/common';
import { PARCEL_KINDS, formatRecordNo, kindOf, parcelKey, parcelLabel, schemaFor, validateVersion } from './catalogue.js';
import { verifyChain } from './seal.js';

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
 * Land records (README.md). This part: creating a record with its first draft, and reading records,
 * versions and the seal chain. Editing drafts, review and commit follow in API-646 to API-648.
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

    /** A new record for a parcel, with an empty draft v1. One record per parcel. */
    async createRecord({ parcel, attributes }, actor = SYSTEM) {
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
                    derived: null, checks: [], changes: [], createdAt: now, createdById: actor.id, createdByName: actor.name ?? null, updatedAt: now
                };
                return { record: r, version };
            }
        });
        await this.events?.publish('records.record.created', { recordId: id, recordNo: record.recordNo, parcelKey: key }, { actor });
        return this.getRecord(id);
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

/**
 * Does a document's property field describe this parcel? Every identifying word must be there as
 * a whole word ("Erf 1873, Klein Windhoek" matches; "Erf 18730" or "Erf 1873, Eros" does not).
 */
export function propertyMatches(parcel, property) {
    if (!property) return false;
    const words = new Set(normalizeSearch(property).split(' '));
    const need = (...vals) => vals.filter(Boolean).flatMap(v => normalizeSearch(v).split(' ')).filter(Boolean);
    let required = [];
    if (parcel.kind === 'erf') required = need('erf', parcel.number, parcel.township, parcel.portion ? `portion ${parcel.portion}` : null);
    else if (parcel.kind === 'farm_portion') required = need('farm', parcel.farmName, parcel.farmNumber, parcel.portion ? `portion ${parcel.portion}` : null);
    else if (parcel.kind === 'sectional_unit') required = need(parcel.schemeName, 'unit', parcel.unit);
    if (!required.length || !required.every(w => words.has(w))) return false;
    // no other portion than the parcel's own
    if (!parcel.portion && words.has('portion')) return false;
    return true;
}
