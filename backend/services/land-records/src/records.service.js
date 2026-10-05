import { randomUUID } from 'node:crypto';
import { BadRequestError, ConflictError, NotFoundError } from '@lrfe/common';
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
    constructor({ repo, events, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.events = events;
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
