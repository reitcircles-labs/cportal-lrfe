import { ConflictError } from '@lrfe/common';
import { matchScore, normalizeSearch, searchTextOf } from '../search.js';
import { normalizeRef } from '../catalogue.js';

const clone = (v) => (v === undefined ? v : structuredClone(v));
const UNIQUE = ['edrmsNo', 'sourceId', 'instrumentRef'];

/**
 * In-memory edrms repository (tests, EDRMS_STORE=memory). Behaviour must match ./sequelize.js:
 * unique edrmsNo/sourceId/instrumentRef, gap-free per-year numbering, optimistic version check.
 */
export function createMemoryRepo() {
    const docs = new Map();
    const versions = [];
    const counters = new Map();

    function assertUnique(doc) {
        for (const field of UNIQUE) {
            if (doc[field] == null) continue;
            const clash = [...docs.values()].find(d => d.id !== doc.id && d[field] === doc[field]);
            if (clash) throw new ConflictError(`A document with this ${field} already exists`, { field, documentId: clash.id, edrmsNo: clash.edrmsNo });
        }
    }

    return {
        async createDocument({ year, build }) {
            const seq = (counters.get(year) || 0) + 1;
            const { document, version } = await build(seq);
            assertUnique(document);
            counters.set(year, seq);
            docs.set(document.id, clone(document));
            versions.push(clone(version));
            return clone(document);
        },
        async getDocument(id) { return clone(docs.get(id)) ?? null; },
        async findDocument(where) {
            const [k, v] = Object.entries(where)[0];
            return clone([...docs.values()].find(d => d[k] === v)) ?? null;
        },
        /** Same rules as PostgreSQL: words, word starts, spelling variants; best matches first. */
        async listDocuments({ q, docType, batchId, props = {}, limit = 50, offset = 0 } = {}) {
            const needle = q ? normalizeSearch(q) : null;
            const own = q ? normalizeRef(q) : null;      // the document's own reference or EDRMS number ranks first
            const all = [...docs.values()]
                .filter(d => !docType || d.docType === docType)
                .filter(d => !batchId || d.batchId === batchId)
                .filter(d => Object.entries(props).every(([k, v]) => d.props[k] === v))
                .map(d => ({ d, score: needle ? matchScore(needle, d.searchText || searchTextOf(d)) : 1 }))
                .filter(x => x.score > 0)
                .map(x => ({ ...x, score: x.score + (own && (x.d.instrumentRef === own || x.d.edrmsNo === own) ? 1000 : 0) }))
                .sort((a, b) => b.score - a.score || (a.d.edrmsNo < b.d.edrmsNo ? 1 : -1))
                .map(x => x.d);
            return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
        },
        /**
         * Every version's seal, oldest first (the audit service's backfill, API-669), `limit` at a
         * time after the cursor `after` ({ at, id, version } of the last one read).
         */
        async listSeals({ after = null, limit = 500 } = {}) {
            const key = (v) => [new Date(v.createdAt).getTime(), v.documentId, v.versionNumber];
            const cmp = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];
            const from = after && [new Date(after.at).getTime(), after.id, after.version];
            return [...versions].sort((a, b) => cmp(key(a), key(b))).filter(v => !from || cmp(key(v), from) > 0).slice(0, limit)
                .map(v => ({ documentId: v.documentId, version: v.versionNumber, seal: v.seal, at: v.createdAt }));
        },
        async listVersions(documentId) {
            return versions.filter(v => v.documentId === documentId).sort((a, b) => a.versionNumber - b.versionNumber).map(clone);
        },
        async getVersion(documentId, versionNumber) {
            return clone(versions.find(v => v.documentId === documentId && v.versionNumber === versionNumber)) ?? null;
        },
        async addVersion(documentId, expectedCurrent, version, patch) {
            const doc = docs.get(documentId);
            if (!doc || doc.currentVersion !== expectedCurrent) throw new ConflictError('The document was changed by someone else. Reload and try again.');
            const next = { ...doc, ...clone(patch) };
            assertUnique(next);
            docs.set(documentId, next);
            versions.push(clone(version));
            return clone(next);
        }
    };
}
