/**
 * In-memory audit repository: tests and `AUDIT_STORE=memory` (lost on restart). Same interface as
 * ./sequelize.js.
 */
const SENT = ['submitted', 'onChain', 'confirmed'];

export function createMemoryRepo() {
    const entries = [];
    const leaves = [];                                 // the tree's leaves by index (README.md section 2)
    const nodes = [];                                  // the tree's nodes by position: Buffers
    const byKey = new Map();                           // leaf key → leaf
    let queue = Promise.resolve();
    let treeQueue = Promise.resolve();
    const anchors = [];
    const leases = new Map();
    const tree = {
        async leafCount() { return leaves.length; },
        async existingKeys(keys) { return keys.filter(k => byKey.has(k)); },
        async getNodes(positions) { return new Map(positions.map(p => [p, nodes[p]])); },
        async leafByKey(key) { const l = byKey.get(key); return l ? { ...l } : null; },
        async itemsByKeys(keys) { return new Map(keys.filter(k => byKey.has(k)).map(k => [k, byKey.get(k).item])); },
        async insert(newLeaves, newNodes) {
            for (const n of newNodes) { if (n.pos !== nodes.length) throw new Error(`tree: node ${n.pos} out of order`); nodes.push(n.hash); }
            for (const l of newLeaves) { const copy = { ...l }; leaves.push(copy); byKey.set(copy.key, copy); }
        }
    };

    const copy = (e) => structuredClone(e);
    const matches = (e, { subjects, type, from, to, exceptRecord }) =>
        (!subjects || e.subjects.some(s => subjects.includes(s)))
        && (!type || e.type === type || (type.endsWith('.') && e.type.startsWith(type)))
        && (!from || e.time >= from)
        && (!to || e.time < to)
        && (!exceptRecord || !e.subjects.some(s => s.startsWith('record:') && s !== exceptRecord));

    return {
        entries,                                       // tests change and remove entries directly
        leaves, nodes, anchors,                        // tests change them directly
        async sync() {},

        /**
         * Append one entry, one writer at a time: `build(last)` makes it from the last entry. Null
         * (nothing written) when an entry for `eventId` exists already.
         */
        append(eventId, build) {
            const run = queue.then(() => {
                if (entries.some(e => e.eventId === eventId)) return null;
                const entry = build(entries.at(-1) ?? null);
                entries.push(copy(entry));
                return copy(entry);
            });
            queue = run.catch(() => {});
            return run;
        },

        async list(filter, { limit, offset }) {
            const found = entries.filter(e => matches(e, filter));
            return { total: found.length, entries: found.slice(offset, offset + limit).map(copy) };
        },

        /** Every subject of the entries that name one of `subjects` (apart from other records). */
        async linkedSubjects(subjects, { exceptRecord } = {}) {
            const out = new Set();
            for (const e of entries) if (matches(e, { subjects, exceptRecord })) e.subjects.forEach(s => out.add(s));
            return [...out];
        },

        /** Entries in order, from seq `after` + 1, at most `limit`. */
        async page(after, limit) {
            return entries.filter(e => e.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit).map(copy);
        },

        /** The last trail entry, or null. */
        async head() { return entries.length ? copy(entries.at(-1)) : null; },

        async entryBySeq(seq) { const e = entries.find(x => x.seq === seq); return e ? copy(e) : null; },
        /** The contentHash of each entry with from ≤ seq ≤ to, in order (a trail entry's proof, API-658). */
        async contentHashes(from, to) { return entries.filter(e => e.seq >= from && e.seq <= to).sort((a, b) => a.seq - b.seq).map(e => ({ seq: e.seq, contentHash: e.contentHash })); },

        // ------------------------------------------------ anchorings (README.md section 3)
        async lastAnchor() { return anchors.length ? { ...anchors.at(-1) } : null; },
        async lastAnchorWhere(statuses) { const a = [...anchors].reverse().find(x => statuses.includes(x.status)); return a ? { ...a } : null; },
        async createAnchor(row) { anchors.push({ attempts: 0, ...row }); return { ...anchors.at(-1) }; },
        async updateAnchor(batch, patch) { Object.assign(anchors.find(a => a.batch === batch), patch); },
        async listAnchors({ limit = 50 } = {}) { return anchors.slice(-limit).reverse().map(a => ({ ...a })); },
        /** Given-up anchorings that spent this wallet output, oldest first. */
        async anchorsSpending(txHash, index) { return anchors.filter(a => a.inputTxHash === txHash && a.inputIndex === index && a.status === 'failed').map(a => ({ ...a })); },
        /** The first confirmed anchoring that covers leaf `index`. */
        async anchorCovering(index) { const a = anchors.find(x => x.status === 'confirmed' && x.size > index); return a ? { ...a } : null; },
        async anchorByBatch(batch) { const a = anchors.find(x => x.batch === batch); return a ? { ...a } : null; },
        /** The first anchoring sent (submitted, on chain or confirmed) whose root covers leaf `index` (API-658). */
        async anchorForLeaf(index) { const a = anchors.find(x => SENT.includes(x.status) && x.size > index); return a ? { ...a } : null; },
        /** The first anchoring sent whose trail checkpoint is at or after entry `seq` (API-658). */
        async anchorForEntry(seq) {
            const a = anchors.filter(x => SENT.includes(x.status) && x.checkpointSeq !== null && x.checkpointSeq !== undefined && x.checkpointSeq >= seq)
                .sort((x, y) => x.checkpointSeq - y.checkpointSeq || x.batch - y.batch)[0];
            return a ? { ...a } : null;
        },
        /** Take or renew the job for `ms`; false while another holder has it. */
        async claimLease(name, holder, ms, now = new Date()) {
            const l = leases.get(name);
            if (l && l.holder !== holder && l.expiresAt > now) return false;
            leases.set(name, { holder, expiresAt: new Date(now.getTime() + ms) });
            return true;
        },

        /** The tree, read without the lock (positions never change once written). */
        tree,
        /** `fn(tree)` with the tree to itself: one writer at a time. */
        withTreeLock(fn) {
            const run = treeQueue.then(() => fn(tree));
            treeQueue = run.catch(() => {});
            return run;
        }
    };
}
