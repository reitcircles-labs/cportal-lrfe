import { ConflictError } from '@lrfe/common';

const clone = (v) => (v === undefined ? v : structuredClone(v));

/**
 * In-memory land-records repository (tests, RECORDS_STORE=memory). Behaviour must match
 * ./sequelize.js: unique record number and parcel key, gap-free per-year numbering, revision
 * checks on draft edits, commits that supersede the previous current version in one step.
 */
export function createMemoryRepo() {
    const records = new Map();
    const versions = [];
    const counters = new Map();
    const comments = [];
    const findVersion = (recordId, n) => versions.find(v => v.recordId === recordId && v.versionNumber === n);

    return {
        async createRecord({ year, build }) {
            const seq = (counters.get(year) || 0) + 1;
            const { record, version } = await build(seq);
            for (const field of ['recordNo', 'parcelKey']) {
                const clash = [...records.values()].find(r => r[field] === record[field]);
                if (clash) throw new ConflictError(`A land record with this ${field} already exists`, { field, recordId: clash.id, recordNo: clash.recordNo });
            }
            counters.set(year, seq);
            records.set(record.id, clone(record));
            versions.push(clone(version));
            return clone(record);
        },
        async getRecord(id) { return clone(records.get(id)) ?? null; },
        async findRecord(where) {
            const [k, v] = Object.entries(where)[0];
            return clone([...records.values()].find(r => r[k] === v)) ?? null;
        },
        async listRecords({ q, status, limit = 50, offset = 0 } = {}) {
            const needle = q?.toLowerCase();
            const all = [...records.values()]
                .filter(r => !status || r.status === status)
                .filter(r => !needle || [r.recordNo, r.label, r.searchText].some(s => String(s ?? '').toLowerCase().includes(needle)))
                .sort((a, b) => (a.recordNo < b.recordNo ? 1 : -1));
            return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
        },
        async updateRecord(id, patch) {
            const r = records.get(id);
            if (!r) return null;
            Object.assign(r, clone(patch));
            return clone(r);
        },

        async getVersion(recordId, n) { return clone(findVersion(recordId, n)) ?? null; },
        async listVersions(recordId) {
            return versions.filter(v => v.recordId === recordId).sort((a, b) => a.versionNumber - b.versionNumber).map(clone);
        },
        async addVersion(version) {
            if (findVersion(version.recordId, version.versionNumber)) throw new ConflictError(`Version ${version.versionNumber} already exists`);
            versions.push(clone(version));
            return clone(version);
        },
        /** Update a version; with `expectedRevision`, only if it still has that revision (else null). */
        async updateVersion(recordId, n, patch, { expectedRevision } = {}) {
            const v = findVersion(recordId, n);
            if (!v || (expectedRevision !== undefined && v.revision !== expectedRevision)) return null;
            Object.assign(v, clone(patch));
            return clone(v);
        },
        /**
         * Which records pin these EDRMS documents in a live version (draft, in review or current):
         * Map documentId → [{ recordId, recordNo, label, versionNumber, state }].
         */
        async findRecordsPinning(documentIds) {
            const wanted = new Set(documentIds), out = new Map();
            for (const v of versions.filter(x => x.state !== 'superseded')) {
                for (const d of v.data?.documents || []) {
                    if (!wanted.has(d.edrmsDocumentId)) continue;
                    const r = records.get(v.recordId);
                    const list = out.get(d.edrmsDocumentId) || [];
                    list.push({ recordId: r.id, recordNo: r.recordNo, label: r.label, versionNumber: v.versionNumber, state: v.state });
                    out.set(d.edrmsDocumentId, list);
                }
            }
            return out;
        },
        /** Commit a version: it becomes committed, the previous current one superseded, the record updated. */
        async commit({ recordId, versionNumber, versionPatch, recordPatch, supersede }) {
            const v = findVersion(recordId, versionNumber);
            if (!v || v.state !== 'in_review') throw new ConflictError('The version is not in review');
            Object.assign(v, clone(versionPatch), { state: 'committed' });
            if (supersede) Object.assign(findVersion(recordId, supersede), { state: 'superseded' });
            Object.assign(records.get(recordId), clone(recordPatch));
            return { record: clone(records.get(recordId)), version: clone(v) };
        },

        async addComment(comment) { comments.push(clone(comment)); return clone(comment); },
        async listComments(recordId) {
            return comments.filter(c => c.recordId === recordId).sort((a, b) => a.createdAt - b.createdAt).map(clone);
        }
    };
}
