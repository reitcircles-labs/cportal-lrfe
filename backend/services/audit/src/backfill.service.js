import { AppError } from '@lrfe/common';
import { LEAF_TYPES } from './mmr.js';

/**
 * The one-time backfill (README.md section 1, "Before deployment"; API-669): land record versions
 * and document versions sealed before the audit service started go into the tree too, so the
 * anchored root covers the whole register. Both lists are read a page at a time (with an audit
 * service token) and merged oldest first; each seal becomes a leaf with the same key a live event
 * would give it, so nothing is added twice: not when the backfill runs again, nor for seals whose
 * events the audit service also received. The run is recorded as one trail entry with the counts.
 */
export class BackfillService {
    constructor({ trail, tree, sources, clock = () => new Date(), logger = console, pageSize = 500, batchSize = 5000 }) {
        this.trail = trail;
        this.tree = tree;
        this.sources = sources;          // { records(after, limit), documents(after, limit) } → { items, next }: next is the cursor for `after`
        this.clock = clock;
        this.logger = logger;
        this.pageSize = pageSize;
        this.batchSize = batchSize;
    }

    /** Read both lists, add what the tree does not have yet. Returns the counts. */
    async run() {
        const started = this.clock();
        const records = this.reader('records', (s) => ({ key: `record-version:${s.recordId}:${s.version}`, type: LEAF_TYPES.recordVersion, item: s.seal, at: s.at }));
        const documents = this.reader('documents', (s) => ({ key: `document-version:${s.documentId}:${s.version}`, type: LEAF_TYPES.documentVersion, item: s.seal, at: s.at }));
        const counts = { records: 0, documents: 0, added: 0, alreadyInTree: 0 };
        let pending = [], first = null, last = null;
        const flush = async () => {
            if (!pending.length) return;
            const added = await this.tree.append(pending.map(({ at, ...leaf }) => leaf));
            counts.added += added.length;
            counts.alreadyInTree += pending.length - added.length;
            if (added.length) { first ??= added[0].index; last = added.at(-1).index; }
            pending = [];
        };
        // merge the two lists by time, oldest first
        let r = await records.next(), d = await documents.next();
        while (r || d) {
            const takeRecord = r && (!d || new Date(r.at) <= new Date(d.at));
            const leaf = takeRecord ? r : d;
            counts[takeRecord ? 'records' : 'documents']++;
            pending.push(leaf);
            if (pending.length >= this.batchSize) await flush();
            if (takeRecord) r = await records.next(); else d = await documents.next();
        }
        await flush();
        const data = { ...counts, ...(counts.added ? { fromLeaf: first, toLeaf: last } : {}), seconds: Math.round((this.clock() - started) / 100) / 10 };
        if (counts.added) {
            // once per range of leaves added: running it again adds nothing and records nothing
            await this.trail.record({ id: `backfill:${first}-${last}`, type: 'audit.backfill.completed', source: 'audit', time: this.clock().toISOString(), actor: { id: null, name: 'System' }, data });
        }
        this.logger.info?.(data, 'audit: backfill of earlier seals done');
        return data;
    }

    /**
     * Run until it has gone through both lists completely: a failure (a service unreachable, a
     * page timing out) is retried after `retryMs`. Safe after a partial run: it adds only what is
     * missing. `onRetry(err)` is told about each failure.
     */
    async untilDone({ retryMs = 60_000, onRetry = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.()) } = {}) {
        for (;;) {
            try { return await this.run(); } catch (err) {
                onRetry(err);
                await sleep(retryMs);
            }
        }
    }

    /** One list, a page at a time, as leaves: next() → the next leaf or null. */
    reader(name, toLeaf) {
        let buffer = [], cursor = null, done = false;
        return {
            next: async () => {
                while (!buffer.length && !done) {
                    const page = await this.sources[name](cursor, this.pageSize);
                    buffer = page.items.map(toLeaf);
                    if (page.next === null || page.next === undefined || !page.items.length) done = true;
                    else cursor = page.next;
                }
                return buffer.shift() ?? null;
            }
        };
    }
}

/** The two lists over HTTP, from land-records and edrms, with an audit service token. */
export function createSealSources({ recordsUrl, edrmsUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    const get = (base, path, what) => async (after, limit) => {
        let res;
        try {
            res = await fetchImpl(`${base}${path}?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { headers: { authorization: `Bearer ${serviceToken()}` }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new AppError(503, `The ${what} service cannot be reached: ${err.message}`);
        }
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (res.status >= 400) throw new AppError(502, `Reading the ${what} seals failed (${res.status}): ${json?.message || 'no detail'}`);
        return json;
    };
    return {
        records: get(recordsUrl, '/records/seals', 'land records'),
        documents: get(edrmsUrl, '/documents/seals', 'document')
    };
}
