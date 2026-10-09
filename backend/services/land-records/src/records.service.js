import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError, normalizeSearch } from '@lrfe/common';
import { PARCEL_KINDS, formatRecordNo, kindOf, parcelKey, parcelLabel, schemaFor, validateVersion } from './catalogue.js';
import { parcelFromProperty, propertyMatches } from './parcel-match.js';
import { blocking, checksFor, sameName, suggestFromDocuments } from './derive.js';
import { diffVersions } from './diff.js';
import { sealOf, verifyChain } from './seal.js';

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
 * chain; review and commit through bpm (API-647); changes after a commit, flags when edrms corrects
 * a linked document, and the history (API-648).
 */
export class RecordsService {
    constructor({ repo, events, edrms = null, bpm = null, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.events = events;
        this.edrms = edrms;
        this.bpm = bpm;
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

    /**
     * Change a committed record: a new draft vN+1, a copy of the current version. The current
     * version stays current until the new one is approved. One open draft per record.
     */
    async openDraft(recordId, actor = SYSTEM) {
        const record = await this.requireRecord(recordId);
        if (record.draftVersion) throw new ConflictError(`The record already has an open draft (version ${record.draftVersion})`, { versionNumber: record.draftVersion });
        if (!record.currentVersion) throw new ConflictError('The record has no committed version yet');
        const current = await this.repo.getVersion(recordId, record.currentVersion);
        const n = Math.max(...(await this.repo.listVersions(recordId)).map(v => v.versionNumber)) + 1;
        const now = this.clock();
        const data = structuredClone(current.data);
        const derived = suggestFromDocuments(data.documents);
        const change = this.entry(actor, { action: 'open', from: current.versionNumber });
        await this.repo.addVersion({
            id: randomUUID(), recordId, versionNumber: n, state: 'draft', revision: 1, schemaVersion: current.schemaVersion, data,
            derived, checks: checksFor(data, { flags: record.flags, suggested: derived }), changes: [change],
            createdAt: now, createdById: actor.id, createdByName: actor.name ?? null, updatedAt: now
        }).catch((err) => {                                    // a concurrent open fails here (unique version number)
            throw err instanceof ConflictError ? new ConflictError('The record already has an open draft') : err;
        });
        await this.repo.updateRecord(recordId, { draftVersion: n, draftState: 'draft', updatedAt: now });
        await this.events?.publish('records.draft.changed', { recordId, recordNo: record.recordNo, versionNumber: n, revision: 1, change }, { actor });
        return this.getRecord(recordId);
    }

    /** The document's current version in edrms, as it is pinned into a version. */
    pinOf(doc, actor) {
        const v = (doc.versions || []).find(x => x.versionNumber === doc.currentVersion);
        if (!v?.seal) throw new ConflictError(`${doc.edrmsNo} has no sealed current version`);
        const fields = Object.fromEntries(Object.entries(doc.props || {}).filter(([, val]) => val !== null && val !== undefined && val !== '').map(([k, val]) => [k, String(val)]));
        return {
            edrmsDocumentId: doc.id, edrmsNo: doc.edrmsNo, version: v.versionNumber, seal: v.seal, docType: doc.docType, ref: doc.instrumentRef ?? null,
            addedBy: actor.id, addedAt: this.clock().toISOString(), fields
        };
    }

    /**
     * Adopt a document's newer EDRMS version (after a correction): its pinned version, seal and
     * fields are updated in the draft; suggestions and checks follow, and the change is reviewed.
     */
    async refreshDocument(recordId, edrmsDocumentId, { revision }, actor = SYSTEM) {
        const draft = await this.requireDraft(recordId);
        const data = structuredClone(draft.version.data);
        const i = (data.documents || []).findIndex(d => d.edrmsDocumentId === edrmsDocumentId);
        if (i < 0) throw new NotFoundError('The document is not in this record');
        const old = data.documents[i];
        const doc = await this.requireDocument(edrmsDocumentId);
        if (doc.currentVersion === old.version) throw new ConflictError(`${old.edrmsNo} is already at its current version (${old.version})`);
        data.documents[i] = this.pinOf(doc, actor);
        return this.saveDraft(draft, revision, data, { action: 'update', edrmsNo: old.edrmsNo, ref: data.documents[i].ref, fromVersion: old.version, toVersion: doc.currentVersion }, actor);
    }

    /** Pin a filed document into the draft, at its current EDRMS version and seal. */
    async addDocument(recordId, { revision, edrmsDocumentId }, actor = SYSTEM) {
        const draft = await this.requireDraft(recordId);
        const data = structuredClone(draft.version.data);
        data.documents = data.documents || [];
        if (data.documents.some(d => d.edrmsDocumentId === edrmsDocumentId)) throw new ConflictError('The document is already in this record');
        const doc = await this.requireDocument(edrmsDocumentId);
        const pin = this.pinOf(doc, actor);
        data.documents.push(pin);
        return this.saveDraft(draft, revision, data, { action: 'link', edrmsNo: doc.edrmsNo, ref: pin.ref, version: pin.version }, actor);
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

    // ---------------------------------------------------------------- review and commit (API-647)

    requireBpm() {
        if (!this.bpm) throw new AppError(503, 'The review process is not configured');
        return this.bpm;
    }

    /** A change-log entry. */
    entry(actor, change) {
        return { at: this.clock().toISOString(), byId: actor.id, byName: actor.name ?? null, ...change };
    }

    /**
     * Submit the draft for review: refused while the data is incomplete or an error check fails
     * (the list is returned). The draft is frozen and a bpm "land-record-review" starts, whose
     * approval task goes to holders of record.finalize other than the submitter.
     */
    async submit(recordId, { revision }, actor = SYSTEM) {
        const { record, version } = await this.requireDraft(recordId);
        if (revision !== version.revision) throw new ConflictError('The draft was changed by someone else: reload it and try again', { revision: version.revision });
        const problems = validateVersion(version.data, { complete: true });
        if (problems.length) throw new BadRequestError('The record is not complete yet', { problems });
        const checks = checksFor(version.data, { flags: record.flags });
        const failing = blocking(checks);
        if (failing.length) throw new BadRequestError(`${failing.length} check${failing.length > 1 ? 's' : ''} must pass before review: ${failing.map(c => c.message).join('; ')}`, { failing });

        const bpm = this.requireBpm();
        const now = this.clock();
        const frozen = await this.repo.updateVersion(recordId, version.versionNumber, {
            state: 'in_review', revision: revision + 1, checks, reviewComment: null,
            submittedAt: now, submittedById: actor.id, submittedByName: actor.name ?? null,
            changes: [...(version.changes || []), this.entry(actor, { action: 'submit' })], updatedAt: now
        }, { expectedRevision: revision });
        if (!frozen) throw new ConflictError('The draft was changed by someone else: reload it and try again');
        await this.repo.updateRecord(recordId, { draftState: 'in_review', updatedAt: now });

        let instance;
        try {
            instance = await bpm.startReview({
                record: { id: recordId, recordNo: record.recordNo, label: record.label, versionNumber: version.versionNumber },
                submittedBy: { id: actor.id, name: actor.name ?? actor.id }
            });
        } catch (err) {
            // the review did not start: the draft is editable again, as before
            await this.repo.updateVersion(recordId, version.versionNumber, {
                state: 'draft', revision, submittedAt: null, submittedById: null, submittedByName: null, changes: version.changes || [], updatedAt: now
            });
            await this.repo.updateRecord(recordId, { draftState: 'draft' });
            throw err;
        }
        await this.repo.updateVersion(recordId, version.versionNumber, { reviewInstanceId: instance.id });
        await this.events?.publish('records.draft.submitted', {
            recordId, recordNo: record.recordNo, versionNumber: version.versionNumber, reviewInstanceId: instance.id
        }, { actor });
        return this.getRecord(recordId);
    }

    /** The submitter takes the version back before a decision: the review task disappears. */
    async withdraw(recordId, actor = SYSTEM) {
        const record = await this.requireRecord(recordId);
        if (record.draftState !== 'in_review') throw new ConflictError('The record has no version in review');
        const version = await this.repo.getVersion(recordId, record.draftVersion);
        if (version.submittedById !== actor.id) throw new ForbiddenError('Only the person who submitted the version can withdraw it');
        if (version.reviewInstanceId) await this.requireBpm().cancel(version.reviewInstanceId, 'Withdrawn by the submitter');
        await this.backToDraft(record, version, this.entry(actor, { action: 'withdraw' }));
        await this.events?.publish('records.draft.withdrawn', { recordId, recordNo: record.recordNo, versionNumber: version.versionNumber }, { actor });
        return this.getRecord(recordId);
    }

    async backToDraft(record, version, change, patch = {}) {
        const now = this.clock();
        const saved = await this.repo.updateVersion(record.id, version.versionNumber, {
            state: 'draft', revision: version.revision + 1, reviewInstanceId: null,
            checks: checksFor(version.data, { flags: (await this.repo.getRecord(record.id)).flags }),
            changes: [...(version.changes || []), change], updatedAt: now, ...patch
        }, { expectedRevision: version.revision });
        if (!saved) throw new ConflictError('The version was changed at the same time: try again');
        await this.repo.updateRecord(record.id, { draftState: 'draft', updatedAt: now });
    }

    /** The version in review, for a decision from bpm. */
    async requireInReview(recordId, versionNumber) {
        const record = await this.requireRecord(recordId);
        const version = await this.repo.getVersion(recordId, versionNumber);
        if (!version) throw new NotFoundError('Version not found');
        return { record, version };
    }

    /**
     * Approved (from bpm): the version is committed, sealed and chained to the previous current
     * version, which is superseded. The approver must not be the submitter. A repeated call for
     * a version already committed by the same approver returns it unchanged.
     */
    async commitFromReview(recordId, versionNumber, { by, comment }, service = 'bpm') {
        const { record, version } = await this.requireInReview(recordId, versionNumber);
        if (version.state === 'committed' && version.approvedById === by.id) return this.getRecord(recordId);
        if (version.state !== 'in_review') throw new ConflictError(`Version ${versionNumber} is not in review (${version.state})`);
        if (by.id === version.submittedById) throw new ForbiddenError('The submitter cannot approve their own version (four-eyes)');

        const previous = record.currentVersion ? await this.repo.getVersion(recordId, record.currentVersion) : null;
        const committedAt = this.clock();
        const sealed = { ...version, approvedById: by.id, approvedByName: by.name ?? null, committedAt, previousSeal: previous?.seal ?? null };
        const seal = sealOf(record, sealed);
        const actor = { id: by.id, name: by.name };
        // flags this version settles; read again just before the commit so a flag raised meanwhile is kept
        const flagsNow = (await this.repo.getRecord(recordId)).flags || [];
        const remaining = openFlags(flagsNow, version.data);
        const settledFlags = remaining.length !== flagsNow.length ? { flags: remaining } : {};
        await this.repo.commit({
            recordId, versionNumber,
            versionPatch: {
                approvedById: by.id, approvedByName: by.name ?? null, committedAt, previousSeal: sealed.previousSeal, seal,
                reviewComment: comment || null, updatedAt: committedAt,
                changes: [...(version.changes || []), this.entry(actor, { action: 'commit', via: service, ...(comment ? { comment } : {}) })]
            },
            recordPatch: {
                status: 'committed', currentVersion: versionNumber, draftVersion: null, draftState: null, updatedAt: committedAt,
                searchText: searchTextOf(record, version.data), ...settledFlags
            },
            supersede: previous?.versionNumber
        });
        await this.events?.publish('records.record.committed', {
            recordId, recordNo: record.recordNo, versionNumber, seal, previousSeal: sealed.previousSeal,
            submittedBy: { id: version.submittedById, name: version.submittedByName }, approvedBy: actor
        }, { actor });
        return this.getRecord(recordId);
    }

    /** Rejected (from bpm): the version returns to the submitter as a draft, with the comment. */
    async rejectFromReview(recordId, versionNumber, { by, comment }, service = 'bpm') {
        const { record, version } = await this.requireInReview(recordId, versionNumber);
        if (version.state === 'draft' && version.reviewComment === comment) return this.getRecord(recordId);
        if (version.state !== 'in_review') throw new ConflictError(`Version ${versionNumber} is not in review (${version.state})`);
        if (!String(comment || '').trim()) throw new BadRequestError('A rejection needs a comment');
        const actor = { id: by.id, name: by.name };
        await this.backToDraft(record, version, this.entry(actor, { action: 'reject', via: service, comment }), { reviewComment: comment });
        await this.events?.publish('records.draft.rejected', {
            recordId, recordNo: record.recordNo, versionNumber, comment, submittedBy: { id: version.submittedById, name: version.submittedByName }
        }, { actor });
        return this.getRecord(recordId);
    }

    /**
     * What the reviewer sees: the version (draft or in review), its checks and the difference
     * from the current committed version.
     */
    async review(recordId) {
        const record = await this.requireRecord(recordId);
        if (!record.draftVersion) throw new NotFoundError('The record has no version waiting for review');
        const version = await this.repo.getVersion(recordId, record.draftVersion);
        const current = record.currentVersion ? await this.repo.getVersion(recordId, record.currentVersion) : null;
        const checks = version.state === 'in_review' && version.checks?.length ? version.checks : checksFor(version.data, { flags: record.flags });
        return {
            record: this.summary(record), version, checks, blocking: blocking(checks).map(c => c.id),
            overrides: [...(version.data.owners || []).filter(o => o.source?.from === 'manual').map(o => ({ what: `owner ${o.name}`, by: o.source.by ?? null, reason: o.source.reason ?? null })),
                ...(version.data.extent?.source?.from === 'manual' ? [{ what: 'extent', by: version.data.extent.source.by ?? null, reason: version.data.extent.source.reason ?? null }] : [])],
            diff: diffVersions(current?.data ?? null, version.data),
            currentVersion: current ? { versionNumber: current.versionNumber, seal: current.seal, committedAt: current.committedAt } : null
        };
    }

    // ---------------------------------------------------------------- edrms corrections (API-648)

    /**
     * edrms filed a new version of a document (`edrms.document.amended`). Every record whose
     * current version or open draft pins an older version is flagged "needs review"; nothing in
     * the record changes by itself. Repeated or late events only move the flag forward.
     */
    async onDocumentAmended({ documentId, edrmsNo, version, reason }) {
        if (!documentId || !version) return [];
        const pinning = (await this.repo.findRecordsPinning([documentId])).get(documentId) || [];
        const flagged = [];
        for (const recordId of new Set(pinning.map(p => p.recordId))) {
            const record = await this.repo.getRecord(recordId);
            const live = [record.currentVersion, record.draftVersion].filter(Boolean);
            const versions = await Promise.all(live.map(n => this.repo.getVersion(recordId, n)));
            const pinned = versions.flatMap(v => (v.data.documents || []).filter(d => d.edrmsDocumentId === documentId));
            const from = Math.min(...pinned.map(d => d.version));
            if (!pinned.length || from >= version) continue;
            const existing = (record.flags || []).find(f => f.type === 'document_updated' && f.edrmsDocumentId === documentId);
            if (existing && existing.to >= version) continue;
            const flag = {
                type: 'document_updated', edrmsDocumentId: documentId, edrmsNo: edrmsNo ?? pinned[0].edrmsNo, ref: pinned[0].ref ?? null,
                from, to: version, ...(reason ? { reason } : {}), at: this.clock().toISOString(),
                message: `Document updated: ${edrmsNo ?? pinned[0].edrmsNo} v${from} → v${version}. Review needed.`
            };
            const flags = [...(record.flags || []).filter(f => f !== existing), flag];
            await this.repo.updateRecord(recordId, { flags });
            // the open draft's checks show it at once (documents_current); its data is unchanged
            const draft = versions.find(v => v.versionNumber === record.draftVersion && v.state === 'draft');
            if (draft) await this.repo.updateVersion(recordId, draft.versionNumber, { checks: checksFor(draft.data, { flags }) });
            await this.events?.publish('records.record.flagged', { recordId, recordNo: record.recordNo, flag });
            flagged.push(recordId);
        }
        return flagged;
    }

    // ---------------------------------------------------------------- history (API-648)

    /**
     * Every committed version, newest first: who submitted and approved it, when, what it changed
     * against the version before, and whether its seal and chain verify.
     */
    async history(recordId) {
        const record = await this.requireRecord(recordId);
        const committed = (await this.repo.listVersions(recordId)).filter(v => ['committed', 'superseded'].includes(v.state));
        const seals = verifyChain(record, committed);
        const versions = committed.map((v, i) => ({
            versionNumber: v.versionNumber, state: v.state, current: v.versionNumber === record.currentVersion,
            submittedAt: v.submittedAt ?? null, submittedById: v.submittedById ?? null, submittedByName: v.submittedByName ?? null,
            approvedById: v.approvedById ?? null, approvedByName: v.approvedByName ?? null, committedAt: v.committedAt, reviewComment: v.reviewComment ?? null,
            seal: v.seal, previousSeal: v.previousSeal ?? null, intact: seals[i].intact, linked: seals[i].linked,
            diff: diffVersions(i ? committed[i - 1].data : null, v.data)
        }));
        return { recordId, recordNo: record.recordNo, label: record.label, intact: seals.every(x => x.intact && x.linked), flags: record.flags || [], versions: versions.reverse() };
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
        // a change in progress: what it changes against the current committed version
        return { ...this.summary(r), current, draft, draftDiff: draft && current ? diffVersions(current.data, draft.data) : null };
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

/**
 * The flags still open once `data` is committed: a "document updated" flag stays while that
 * document is in the record at an older version than the corrected one.
 */
function openFlags(flags = [], data) {
    return flags.filter(f => f.type !== 'document_updated'
        || (data.documents || []).some(d => d.edrmsDocumentId === f.edrmsDocumentId && d.version < f.to));
}

/** The words that identify a parcel in a document's text (for a first, broad search). */
function parcelWords(parcel) {
    if (parcel.kind === 'erf') return [parcel.number, parcel.township].filter(Boolean).join(' ');
    if (parcel.kind === 'farm_portion') return [parcel.farmName, parcel.farmNumber].filter(Boolean).join(' ');
    if (parcel.kind === 'sectional_unit') return [parcel.schemeName, parcel.unit].filter(Boolean).join(' ');
    return '';
}
