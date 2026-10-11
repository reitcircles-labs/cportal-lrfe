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
    const signoffs = [];
    const findings = [];
    const alerts = new Map();
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

        /** Entries of `type` with after < seq ≤ upTo, in order (what a batch covers, API-696). */
        async entriesOfType(type, after, upTo) {
            return entries.filter(e => e.type === type && e.seq > after && e.seq <= upTo).sort((a, b) => a.seq - b.seq).map(copy);
        },
        /** The key and event of each leaf with from ≤ index < to, in order (what a batch covers, API-696). */
        async leavesInRange(from, to) { return leaves.slice(from, to).map(l => ({ key: l.key, eventId: l.eventId ?? null })); },
        /** The trail entries of these events. */
        async entriesByEventIds(eventIds) {
            const wanted = new Set(eventIds);
            return entries.filter(e => wanted.has(e.eventId)).map(copy);
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
        /** Newest first; only those with one of `statuses` when given. */
        async listAnchors({ statuses, limit = 50, offset = 0 } = {}) {
            return anchors.filter(a => !statuses || statuses.includes(a.status)).sort((a, b) => b.batch - a.batch).slice(offset, offset + limit).map(a => ({ ...a }));
        },
        /** How many anchorings there are of each status. */
        async countAnchors() {
            const out = {};
            for (const a of anchors) out[a.status] = (out[a.status] ?? 0) + 1;
            return out;
        },
        /** The newest anchoring before `batch` with one of `statuses`, or null. */
        async anchorBefore(batch, statuses) {
            const a = anchors.filter(x => x.batch < batch && statuses.includes(x.status)).sort((x, y) => y.batch - x.batch)[0];
            return a ? { ...a } : null;
        },
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

        // ------------------------------------------------ sign-offs and findings (README.md section 5)
        signoffs, findings,                            // tests read them directly
        /**
         * Null when it exists already (the unique indexes in PostgreSQL): a checkpoint once per record
         * and version, an item sign-off (API-659) once per auditor and item.
         */
        async createSignoff(row) {
            const kind = row.kind ?? 'item';
            const sameCheckpoint = (x) => x.kind === 'checkpoint' && x.recordId === row.recordId
                && (x.toVersion === row.toVersion || x.fromVersion === row.fromVersion);
            const sameItem = (x) => (x.kind ?? 'item') === 'item' && x.signedById === row.signedById && x.recordId === row.recordId
                && x.recordVersion === row.recordVersion && (x.documentId ?? null) === (row.documentId ?? null);
            const taken = signoffs.some(kind === 'checkpoint' ? sameCheckpoint : sameItem);
            if (taken) return null;
            signoffs.push(structuredClone({ ...row, kind }));
            return structuredClone({ ...row, kind });
        },
        async listSignoffs({ recordId, documentId } = {}) {
            return signoffs.filter(x => (!recordId || x.recordId === recordId) && (!documentId || x.documentId === documentId))
                .sort((a, b) => a.signedAt - b.signedAt).map(x => structuredClone(x));
        },
        async createFinding(row) {
            findings.push(structuredClone({ answers: [], ...row }));
            return structuredClone({ answers: [], ...row });
        },
        async getFinding(id) { const f = findings.find(x => x.id === id); return f ? structuredClone(f) : null; },
        async listFindings({ recordId, documentId, status } = {}) {
            return findings.filter(x => (!recordId || x.recordId === recordId) && (!documentId || x.documentId === documentId) && (!status || x.status === status))
                .sort((a, b) => a.raisedAt - b.raisedAt).map(x => structuredClone(x));
        },
        /** Add an answer to an open finding; false when it is no longer open. */
        async addAnswer(id, answer) {
            const f = findings.find(x => x.id === id && x.status === 'open');
            if (!f) return false;
            f.answers = [...(f.answers || []), structuredClone(answer)];
            return true;
        },
        alerts,                                        // tests read them directly
        async getAlert(key) { return alerts.has(key) ? { ...alerts.get(key) } : null; },
        async listAlerts() { return [...alerts.values()].map(a => ({ ...a })); },
        /** Null when the item was found changed already. */
        async createAlert(row) {
            if (alerts.has(row.key)) return null;
            alerts.set(row.key, { ...row });
            return { ...row };
        },
        /** Change an open finding; false when it is no longer open (resolved or closed meanwhile). */
        async updateOpenFinding(id, patch) {
            const f = findings.find(x => x.id === id && x.status === 'open');
            if (!f) return false;
            Object.assign(f, patch);
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
