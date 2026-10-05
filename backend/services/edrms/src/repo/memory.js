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
