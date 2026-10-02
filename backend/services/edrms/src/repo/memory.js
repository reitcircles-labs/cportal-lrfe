import { ConflictError } from '@lrfe/common';

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
        async listDocuments({ q, docType, batchId, props = {}, limit = 50, offset = 0 } = {}) {
            const needle = q?.toLowerCase();
            const all = [...docs.values()]
                .filter(d => !docType || d.docType === docType)
                .filter(d => !batchId || d.batchId === batchId)
                .filter(d => Object.entries(props).every(([k, v]) => d.props[k] === v))
                .filter(d => !needle || [d.title, d.instrumentRef, d.edrmsNo, JSON.stringify(d.props)].some(s => String(s ?? '').toLowerCase().includes(needle)))
                .sort((a, b) => (a.edrmsNo < b.edrmsNo ? 1 : -1));
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
