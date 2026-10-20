import {ConflictError} from '@lrfe/common';

const clone = v => (v === undefined ? v : structuredClone(v));

/** The document versions a land record version pins: { id, version, edrmsNo, docType, ref }. */
const pinnedOf = v =>
  (v.data?.documents || []).map(d => ({
    id: d.edrmsDocumentId,
    version: d.version,
    edrmsNo: d.edrmsNo,
    docType: d.docType,
    ref: d.ref ?? null,
  }));

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
  const findVersion = (recordId, n) =>
    versions.find(v => v.recordId === recordId && v.versionNumber === n);

  return {
    async createRecord({year, build}) {
      const seq = (counters.get(year) || 0) + 1;
      const {record, version} = await build(seq);
      for (const field of ['recordNo', 'parcelKey']) {
        const clash = [...records.values()].find(
          r => r[field] === record[field],
        );
        if (clash) {
          throw new ConflictError(
            `A land record with this ${field} already exists`,
            {field, recordId: clash.id, recordNo: clash.recordNo},
          );
        }
      }
      counters.set(year, seq);
      records.set(record.id, clone(record));
      versions.push(clone(version));
      return clone(record);
    },
    async getRecord(id) {
      return clone(records.get(id)) ?? null;
    },
    async findRecord(where) {
      const [k, v] = Object.entries(where)[0];
      return clone([...records.values()].find(r => r[k] === v)) ?? null;
    },
    async listRecords({
      q,
      status,
      match,
      inBin = false,
      limit = 50,
      offset = 0,
    } = {}) {
      const needle = q?.toLowerCase();
      const fields = r =>
        match === 'parcel'
          ? [r.recordNo, r.label]
          : [r.recordNo, r.label, r.searchText];
      const all = [...records.values()]
        .filter(r => !!r.discardedAt === inBin)
        .filter(r => !status || r.status === status)
        .filter(
          r =>
            !needle ||
            fields(r).some(s =>
              String(s ?? '')
                .toLowerCase()
                .includes(needle),
            ),
        )
        .sort((a, b) => (a.recordNo < b.recordNo ? 1 : -1));
      return {
        items: all.slice(offset, offset + limit).map(clone),
        total: all.length,
      };
    },
    async updateRecord(id, patch) {
      const r = records.get(id);
      if (!r) return null;
      Object.assign(r, clone(patch));
      return clone(r);
    },

    async getVersion(recordId, n) {
      return clone(findVersion(recordId, n)) ?? null;
    },
    /** Every committed version's seal (superseded ones too), oldest first, after the cursor `after` (API-669). */
    async listSeals({after = null, limit = 500} = {}) {
      const key = v => [
        new Date(v.committedAt).getTime(),
        v.recordId,
        v.versionNumber,
      ];
      const cmp = (a, b) =>
        a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];
      const from = after && [
        new Date(after.at).getTime(),
        after.id,
        after.version,
      ];
      return versions
        .filter(v => v.seal)
        .sort((a, b) => cmp(key(a), key(b)))
        .filter(v => !from || cmp(key(v), from) > 0)
        .slice(0, limit)
        .map(v => ({
          recordId: v.recordId,
          version: v.versionNumber,
          seal: v.seal,
          at: v.committedAt,
        }));
    },
    async listVersions(recordId) {
      return versions
        .filter(v => v.recordId === recordId)
        .sort((a, b) => a.versionNumber - b.versionNumber)
        .map(clone);
    },
    /** Remove a version that is still a draft (a change discarded, API-767); false if it is not. */
    async deleteVersion(recordId, versionNumber) {
      const i = versions.findIndex(
        v =>
          v.recordId === recordId &&
          v.versionNumber === versionNumber &&
          v.state === 'draft',
      );
      if (i < 0) return false;
      versions.splice(i, 1);
      return true;
    },
    async addVersion(version) {
      if (findVersion(version.recordId, version.versionNumber)) {
        throw new ConflictError(
          `Version ${version.versionNumber} already exists`,
        );
      }
      versions.push(clone(version));
      return clone(version);
    },
    /** Update a version; with `expectedRevision`, only if it still has that revision (else null). */
    async updateVersion(recordId, n, patch, {expectedRevision} = {}) {
      const v = findVersion(recordId, n);
      if (
        !v ||
        (expectedRevision !== undefined && v.revision !== expectedRevision)
      ) {
        return null;
      }
      Object.assign(v, clone(patch));
      return clone(v);
    },
    /**
     * Which records pin these EDRMS documents in a live version (draft, in review or current):
     * Map documentId → [{ recordId, recordNo, label, versionNumber, state }].
     */
    async findRecordsPinning(documentIds) {
      const wanted = new Set(documentIds);
      const out = new Map();
      // not a record in the bin: its documents are free again (API-767)
      const live = versions.filter(
        x => x.state !== 'superseded' && !records.get(x.recordId)?.discardedAt,
      );
      for (const v of live) {
        for (const d of v.data?.documents || []) {
          if (!wanted.has(d.edrmsDocumentId)) continue;
          const r = records.get(v.recordId);
          const list = out.get(d.edrmsDocumentId) || [];
          list.push({
            recordId: r.id,
            recordNo: r.recordNo,
            label: r.label,
            versionNumber: v.versionNumber,
            state: v.state,
          });
          out.set(d.edrmsDocumentId, list);
        }
      }
      return out;
    },
    /** Number and label of each land record by id (the Anchorings screens, API-696). */
    async recordLabels(ids) {
      return ids
        .filter(id => records.has(id))
        .map(id => ({
          id,
          recordNo: records.get(id).recordNo,
          label: records.get(id).label,
        }));
    },
    /** The committed versions (current or superseded) that pin any version of these documents: [{ documentId, version, recordId, versionNumber }]. */
    async findCommittedPinning(documentIds) {
      const wanted = new Set(documentIds);
      const out = [];
      for (const v of versions.filter(
        x => x.state === 'committed' || x.state === 'superseded',
      )) {
        for (const d of pinnedOf(v)) {
          if (wanted.has(d.id)) {
            out.push({
              documentId: d.id,
              version: d.version,
              recordId: v.recordId,
              versionNumber: v.versionNumber,
            });
          }
        }
      }
      return out;
    },
    /** The documents each committed version (current or superseded) is made of: [{ recordId, versionNumber, documents: [{ id, version }] }]. */
    async versionDocuments(pairs) {
      const wanted = new Set(
        pairs.map(p => `${p.recordId}:${p.versionNumber}`),
      );
      return versions
        .filter(
          v =>
            (v.state === 'committed' || v.state === 'superseded') &&
            wanted.has(`${v.recordId}:${v.versionNumber}`),
        )
        .map(v => ({
          recordId: v.recordId,
          versionNumber: v.versionNumber,
          documents: pinnedOf(v),
        }));
    },
    /** Commit a version: it becomes committed, the previous current one superseded, the record updated. */
    async commit({
      recordId,
      versionNumber,
      versionPatch,
      recordPatch,
      supersede,
    }) {
      const v = findVersion(recordId, versionNumber);
      if (!v || v.state !== 'in_review') {
        throw new ConflictError('The version is not in review');
      }
      Object.assign(v, clone(versionPatch), {state: 'committed'});
      if (supersede) {
        Object.assign(findVersion(recordId, supersede), {state: 'superseded'});
      }
      Object.assign(records.get(recordId), clone(recordPatch));
      return {record: clone(records.get(recordId)), version: clone(v)};
    },

    async addComment(comment) {
      comments.push(clone(comment));
      return clone(comment);
    },
    async listComments(recordId) {
      return comments
        .filter(c => c.recordId === recordId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
    },
  };
}
