import { AppError, BadRequestError, NotFoundError } from '@lrfe/common';
import { chainHash, contentHash } from './chain.js';
import { leafHash, verifyInclusion } from './mmr.js';
import { committedMetadata, LABEL } from './cardano/tx.js';

export const PROOF_FORMAT = 'lrfe-audit-proof/1';
export const KINDS = ['record-version', 'document-version', 'trail-entry'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proofs and verification (README.md section 4; API-658). A proof shows that a land record version,
 * a document version or a trail entry is a leaf of the tree whose root was put on Cardano in one
 * anchoring transaction; anyone can check it without the portal (verifier/lrfe-verify.mjs).
 *
 *   proof(kind, id, version)    the proof, against the first anchoring that covers the item (or,
 *                               while none does, against the tree as it is now: status `waiting`)
 *   verify(kind, id, version)   the item's seal recomputed from the current data, the path to the
 *                               root, and the root in the anchoring transaction on the chain
 *   statusOf(keys)              per leaf key: waiting | anchored | confirmed (land-records, edrms)
 *
 * `sources`: { recordVersion(recordId, n), documentVersion(documentId, n) } → { seal, intact } as the
 * owning service recomputes it now (createVerifySources).
 */
export class ProofService {
    constructor({ repo, tree, cardano = null, sources = null, clock = () => new Date(), logger = console }) {
        this.repo = repo;
        this.tree = tree;
        this.cardano = cardano;
        this.sources = sources;
        this.clock = clock;
        this.logger = logger;
    }

    /** The item named by `kind`, `id` (and `version`): its leaf key. */
    static itemOf(kind, id, version) {
        if (!KINDS.includes(kind)) throw new BadRequestError(`Unknown kind "${kind}": use ${KINDS.join(', ')}`);
        if (kind === 'trail-entry') {
            const seq = Number(id);
            if (!Number.isSafeInteger(seq) || seq < 1) throw new BadRequestError('A trail entry is named by its number (seq)');
            return { kind, seq };
        }
        if (!UUID.test(String(id))) throw new BadRequestError(`A ${kind} is named by its ${kind === 'record-version' ? 'land record' : 'document'} id (a uuid)`);
        const n = Number(version);
        if (!Number.isSafeInteger(n) || n < 1) throw new BadRequestError('Which version? Give "version" (1, 2, …)');
        return kind === 'record-version'
            ? { kind, recordId: id, version: n, key: `record-version:${id}:${n}` }
            : { kind, documentId: id, version: n, key: `document-version:${id}:${n}` };
    }

    async proof(kind, id, version) {
        const item = ProofService.itemOf(kind, id, version);
        return item.kind === 'trail-entry' ? this.entryProof(item) : this.versionProof(item);
    }

    async versionProof(item) {
        const leaf = await this.repo.tree.leafByKey(item.key);
        if (!leaf) throw new NotFoundError(`This ${item.kind === 'record-version' ? 'land record' : 'document'} version is not in the audit tree yet`);
        const anchor = await this.repo.anchorForLeaf(leaf.leafIndex);
        const p = await this.tree.inclusionProof(item.key, anchor ? anchor.size : undefined);
        const { key, ...rest } = item;
        return this.assemble({ ...rest, seal: leaf.item }, p, anchor);
    }

    /**
     * A trail entry is covered by the first trail checkpoint at or after it that went on chain. The
     * proof holds the entry itself and, for each later entry up to the checkpoint, only its
     * contentHash: the chain from the entry to the checkpoint can be recomputed without other
     * records' data (README.md section 1).
     */
    async entryProof(item) {
        const entry = await this.repo.entryBySeq(item.seq);
        if (!entry) throw new NotFoundError(`There is no trail entry ${item.seq}`);
        const { seq, eventId, type, source, time, actor, subjects, data, prevHash, contentHash: ch, hash } = entry;
        const trail = { entry: { seq, eventId, type, source, time, actor, subjects, data, prevHash, contentHash: ch, hash }, later: [], checkpoint: null };
        const anchor = await this.repo.anchorForEntry(item.seq);
        if (!anchor) return this.assemble({ kind: 'trail-entry', seq }, null, null, trail);
        const p = await this.tree.inclusionProof(`trail-checkpoint:${anchor.checkpointSeq}`, anchor.size);
        trail.later = (await this.repo.contentHashes(item.seq + 1, anchor.checkpointSeq)).map(e => e.contentHash);
        trail.checkpoint = { seq: anchor.checkpointSeq, hash: p.leaf.item };
        return this.assemble({ kind: 'trail-entry', seq, checkpointSeq: anchor.checkpointSeq }, p, anchor, trail);
    }

    async assemble(item, p, anchor, trail) {
        const status = !anchor ? 'waiting' : anchor.status === 'confirmed' ? 'confirmed' : 'anchored';
        return {
            format: PROOF_FORMAT,
            status,
            item,
            ...(trail ? { trail } : {}),
            leaf: p ? { key: p.leaf.key, type: p.leaf.type, item: p.leaf.item, index: p.leaf.index, hash: p.leaf.hash } : null,
            tree: p ? { size: p.size, path: p.path, peaks: p.peaks, root: p.root } : null,
            anchor: anchor ? await this.anchorInfo(anchor) : null
        };
    }

    /** The anchoring as a proof names it; confirmations counted now when the chain can be reached. */
    async anchorInfo(a) {
        const block = a.blockHeight ?? a.firstSeenHeight ?? null;
        let confirmations = null;
        if (block !== null && this.cardano) {
            try { confirmations = Math.max(0, (await this.cardano.tipHeight()) - block + 1); } catch { /* the chain cannot be reached now: left out */ }
        }
        return {
            network: a.network, label: LABEL, batch: a.batch, tx: a.txHash, root: a.root, size: a.size,
            // the wallet that pays every anchoring: the offline verifier checks the transaction came from it
            address: await this.walletAddress(),
            // Blockfrost names the block that holds it; the own node only when it was first seen there
            block, blockIs: a.blockHeight ? 'included' : block !== null ? 'firstSeen' : null,
            confirmations, status: a.status === 'confirmed' ? 'confirmed' : a.status === 'onChain' ? 'onChain' : 'submitted',
            confirmedAt: a.confirmedAt ?? null
        };
    }

    /** The anchoring wallet's address, or null when anchoring is off or OpenBao cannot be reached. */
    async walletAddress() {
        if (!this.cardano) return null;
        try { return await this.cardano.address(); } catch { return null; }
    }

    // ------------------------------------------------ verify

    /**
     * Check an item now: (1) its seal recomputed from the current data by the service that owns it
     * (a trail entry: its hashes recomputed here, then the chain to the checkpoint), (2) the leaf and
     * the path to the root, (3) the root and size in the anchoring transaction's metadata. `valid`
     * only when all three hold; a version not yet anchored is never valid.
     */
    async verify(kind, id, version) {
        const p = await this.proof(kind, id, version);
        const checks = { item: await this.checkItem(p), path: null, chain: null };
        if (p.leaf) {
            const recomputed = Buffer.from(leafHash(p.leaf.type, p.leaf.item)).toString('hex');
            checks.path = { ok: recomputed === p.leaf.hash && verifyInclusion({ leafHash: recomputed, leafIndex: p.leaf.index, size: p.tree.size, path: p.tree.path, peaks: p.tree.peaks, root: p.tree.root }) };
        }
        if (p.anchor) checks.chain = await this.checkChain(p);
        const valid = p.status !== 'waiting' && [checks.item, checks.path, checks.chain].every(c => c?.ok === true);
        return { valid, status: p.status, checks, checkedAt: this.clock().toISOString(), proof: p };
    }

    async checkItem(p) {
        if (p.item.kind === 'trail-entry') {
            const e = p.trail.entry;
            const ok = contentHash(e) === e.contentHash && chainHash(e.prevHash, e.contentHash) === e.hash;
            const out = { ok, source: 'trail', ...(ok ? {} : { problem: 'the entry was changed after it was recorded' }) };
            if (ok && p.trail.checkpoint) {
                const end = p.trail.later.reduce((h, c) => chainHash(h, c), e.hash);
                if (end !== p.trail.checkpoint.hash || p.trail.checkpoint.hash !== p.leaf.item) return { ok: false, source: 'trail', problem: 'the chain from the entry does not reach the anchored checkpoint' };
            }
            return out;
        }
        if (!this.sources) return { ok: null, problem: 'the owning service is not configured' };
        const record = p.item.kind === 'record-version';
        let now;
        try {
            now = record ? await this.sources.recordVersion(p.item.recordId, p.item.version) : await this.sources.documentVersion(p.item.documentId, p.item.version);
        } catch (err) {
            if (err.statusCode === 404) return { ok: false, source: record ? 'land-records' : 'edrms', problem: 'the version no longer exists' };
            return { ok: null, source: record ? 'land-records' : 'edrms', problem: `the seal could not be recomputed now: ${err.message}` };
        }
        const ok = now.intact === true && now.seal === p.item.seal;
        return {
            ok, source: record ? 'land-records' : 'edrms', seal: now.seal,
            ...(ok ? {} : { problem: !now.intact ? 'the version\'s data no longer matches its seal' : 'the seal differs from the one in the tree' })
        };
    }

    /**
     * The root in the transaction: read from the chain where the provider can look up a past
     * transaction (Blockfrost); otherwise (the own node) from the signed transaction as it was sent,
     * whose id commits to its metadata, and its status as the anchoring job followed it.
     */
    async checkChain(p) {
        const a = p.anchor;
        const matches = (md) => !!md && md.sys === 'lrfe-audit' && md.root === p.tree.root && Number(md.size) === p.tree.size && md.root === a.root;
        if (this.cardano?.lookup) {
            let md;
            try { md = await this.cardano.lookup(a.tx); } catch (err) {
                return { ok: null, source: this.cardano.provider, problem: `the chain cannot be reached now: ${err.message}` };
            }
            if (md !== undefined) {
                if (md === null) {
                    const onChain = await this.cardano.status(a.tx).then(x => x.onChain, () => false);
                    return { ok: false, source: this.cardano.provider, tx: a.tx, problem: onChain ? 'the transaction carries no anchoring metadata' : 'the transaction is not on the chain' };
                }
                return { ok: matches(md), source: this.cardano.provider, tx: a.tx, metadata: md, ...(matches(md) ? {} : { problem: 'the root in the transaction is not this proof\'s root' }) };
            }
        }
        if (!a.address) return { ok: null, source: 'stored', tx: a.tx, problem: 'the anchoring wallet cannot be read now (OpenBao)' };
        const row = await this.repo.anchorByBatch(a.batch);
        const md = row ? committedMetadata(row.cbor, row.txHash, a.address) : null;
        const ok = matches(md) && ['onChain', 'confirmed'].includes(row.status);
        return {
            ok, source: 'stored', tx: a.tx, metadata: md,
            note: 'checked against the transaction as sent, signed by the anchoring wallet, and the anchoring job\'s record of it on chain; the offline verifier reads it from a public source',
            ...(ok ? {} : { problem: !matches(md) ? 'the stored transaction is not signed by the anchoring wallet or does not carry this proof\'s root' : 'the transaction is not on chain yet' })
        };
    }

    // ------------------------------------------------ status for land-records and edrms

    /** Per leaf key: { status: waiting | anchored | confirmed, batch, tx, network } or null (not in the tree). */
    async statusOf(keys) {
        const out = {};
        const byIndex = new Map();
        for (const key of keys) {
            const leaf = await this.repo.tree.leafByKey(key);
            if (!leaf) { out[key] = null; continue; }
            if (!byIndex.has(leaf.leafIndex)) byIndex.set(leaf.leafIndex, await this.repo.anchorForLeaf(leaf.leafIndex));
            const a = byIndex.get(leaf.leafIndex);
            out[key] = a
                ? { status: a.status === 'confirmed' ? 'confirmed' : 'anchored', batch: a.batch, tx: a.txHash, network: a.network, confirmedAt: a.confirmedAt ?? null }
                : { status: 'waiting' };
        }
        return out;
    }
}

/** The owning services' own recomputation of a version's seal, over HTTP with an audit service token. */
export function createVerifySources({ recordsUrl, edrmsUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
    const get = async (url, what) => {
        let res;
        try {
            res = await fetchImpl(url, { headers: { authorization: `Bearer ${serviceToken()}` }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new AppError(503, `The ${what} service cannot be reached: ${err.message}`);
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON (a proxy's error page): reported by status below */ }
        if (res.status === 404) throw new NotFoundError(json?.message || 'Not found');
        if (res.status >= 400 || !json) throw new AppError(502, `The ${what} service could not check the version (${res.status}): ${json?.message || 'no detail'}`);
        return json;
    };
    return {
        async recordVersion(recordId, n) {
            const r = await get(`${recordsUrl}/records/${recordId}/verify`, 'land records');
            const v = r.versions.find(x => x.versionNumber === n);
            if (!v) throw new NotFoundError('Version not found');
            return { seal: v.seal, intact: v.intact, linked: v.linked };
        },
        async documentVersion(documentId, n) {
            const r = await get(`${edrmsUrl}/documents/${documentId}/versions/${n}/verify`, 'document');
            return { seal: r.seal, intact: r.intact };
        }
    };
}
