import { ConflictError } from '@lrfe/common';

const clone = (v) => (v === undefined ? v : structuredClone(v));

/**
 * In-memory intake repository (tests, INTAKE_STORE=memory). Same interface and behaviour as
 * ./sequelize.js: unique file hash, optimistic document versions, one worker per job.
 */
export function createMemoryRepo() {
    const batches = new Map();
    const docs = new Map();
    const extractions = [];
    const jobs = new Map();
    const events = [];
    const counters = new Map();
    let eventSeq = 0;

    return {
        // batches
        async nextBatchNumber(registry) { const n = (counters.get(registry) || 0) + 1; counters.set(registry, n); return n; },
        async createBatch(b) { batches.set(b.id, clone(b)); return clone(b); },
        async getBatch(id) { return clone(batches.get(id)) ?? null; },
        async listBatches() { return [...batches.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone); },
        async countByBatch() {
            const out = {};
            for (const d of docs.values()) {
                out[d.batchId] ??= {};
                out[d.batchId][d.status] = (out[d.batchId][d.status] || 0) + 1;
            }
            return out;
        },

        // documents
        async createDocument(d) {
            if ([...docs.values()].some(x => x.sha256 === d.sha256)) throw new ConflictError('This file was already captured', { field: 'sha256' });
            docs.set(d.id, clone({ version: 1, ...d }));
            return clone(docs.get(d.id));
        },
        async getDocument(id) { return clone(docs.get(id)) ?? null; },
        async findBySha(sha256) { return clone([...docs.values()].find(d => d.sha256 === sha256)) ?? null; },
        /** Patch; with expectedVersion, only if nobody changed it meanwhile (else null). */
        async updateDocument(id, patch, expectedVersion) {
            const d = docs.get(id);
            if (!d || (expectedVersion !== undefined && d.version !== expectedVersion)) return null;
            Object.assign(d, clone(patch), { version: d.version + 1 });
            return clone(d);
        },
        async listDocuments({ batchId, status, q, limit = 100, offset = 0 } = {}) {
            const needle = q?.toLowerCase();
            const statuses = status ? [].concat(status) : null;
            const all = [...docs.values()]
                .filter(d => (!batchId || d.batchId === batchId) && (!statuses || statuses.includes(d.status)))
                .filter(d => !needle || [d.fileName, d.docType, d.edrmsNo, ...(d.fields || []).map(f => f.value)].some(s => String(s ?? '').toLowerCase().includes(needle)))
                .sort((a, b) => a.capturedAt - b.capturedAt);
            return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
        },

        // extractions (one row per model call)
        async addExtraction(e) { extractions.push(clone(e)); },
        async listExtractions(documentId) { return extractions.filter(e => e.documentId === documentId).sort((a, b) => a.createdAt - b.createdAt).map(clone); },
        async getExtraction(id) { return clone(extractions.find(e => e.id === id)) ?? null; },
        async usageSince(since) { return extractions.filter(e => e.createdAt >= since).map(({ answer, ...e }) => clone(e)); },

        // jobs
        async enqueueJob(j) { jobs.set(j.id, clone(j)); return clone(j); },
        async hasOpenJob(documentId) { return [...jobs.values()].some(j => j.documentId === documentId && ['queued', 'running'].includes(j.status)); },
        /** Take the oldest due job; jobs left 'running' longer than staleMs (crashed worker) are taken again. */
        async claimJob({ workerId, now, staleMs }) {
            const due = [...jobs.values()]
                .filter(j => (j.status === 'queued' && j.runAfter <= now) || (j.status === 'running' && now - j.lockedAt > staleMs))
                .sort((a, b) => a.runAfter - b.runAfter)[0];
            if (!due) return null;
            Object.assign(due, { status: 'running', lockedBy: workerId, lockedAt: now, attempts: due.attempts + 1, updatedAt: now });
            return clone(due);
        },
        async updateJob(id, patch) { Object.assign(jobs.get(id), clone(patch)); },
        async listJobs(documentId) { return [...jobs.values()].filter(j => j.documentId === documentId).map(clone); },

        // events (append-only)
        async addEvent(e) { events.push({ id: ++eventSeq, ...clone(e) }); },
        async listEvents(documentId) { return events.filter(e => e.documentId === documentId).map(clone); }
    };
}
