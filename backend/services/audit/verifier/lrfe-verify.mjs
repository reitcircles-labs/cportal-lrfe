#!/usr/bin/env node
/**
 * lrfe-verify: check an audit proof of the Namibia land records portal without the portal.
 *
 *   node lrfe-verify.mjs proof.json                       reads the anchoring from Koios (free, no key)
 *   node lrfe-verify.mjs proof.json --source blockfrost   from Blockfrost: the project key in
 *                                                         BLOCKFROST_PROJECT_ID or --key-file <file>
 *   node lrfe-verify.mjs proof.json --address addr_test1…  also require the installation's published
 *                                                         anchoring wallet (recommended)
 *   node lrfe-verify.mjs proof.json --json                the result as JSON
 *
 * One file, Node 18 or later, nothing to install. It checks that:
 *   1. the leaf is the item's seal (a land record or document version) or the trail checkpoint;
 *      for a trail entry, the entry's hashes are recomputed from its content and the chain from it
 *      is followed, entry by entry, to that checkpoint;
 *   2. the path leads from the leaf to the tree's root (a Merkle mountain range);
 *   3. the anchoring transaction on Cardano carries that root and tree size in its metadata
 *      (label 8890), and how many blocks deep it is;
 *   4. the transaction was paid by the portal's anchoring wallet: anyone can put a root in a
 *      transaction, only the portal can spend from its wallet. The proof names the wallet; compare it
 *      with the address the installation publishes, or pass that address with --address.
 * Not checked offline: which record or document id and version the seal belongs to (recomputing the
 * seal needs the version's data, which the evidence pack holds).
 * Exit code 0: valid; 1: not valid; 2: could not be checked (no proof, the chain unreachable).
 *
 * The hashing is that of the portal's audit service (services/audit/README.md sections 1 and 2):
 *   leaf = SHA-256(0x00 || type || item)    node = SHA-256(0x01 || left || right)
 *   root = SHA-256(0x02 || size as 8 bytes big-endian || peaks, largest first)
 *   trail: contentHash = SHA-256(canonical JSON of the entry), hash = SHA-256(prevHash || contentHash)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LABEL = 8890;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const buf = (hex) => Buffer.from(hex, 'hex');

// ------------------------------------------------------------------ the tree

export const leafHash = (type, item) => sha256(Buffer.from([0x00, type]), buf(item)).toString('hex');
const nodeHash = (l, r) => sha256(Buffer.from([0x01]), l, r);
export function rootOf(size, peaks) {
    const s = Buffer.alloc(8);
    s.writeBigUInt64BE(BigInt(size));
    return sha256(Buffer.from([0x02]), s, ...peaks.map(buf)).toString('hex');
}

/** The perfect trees a tree of `size` leaves is made of, largest first: { height, leafStart }. */
function mountains(size) {
    const out = [];
    let leafStart = 0;
    for (let h = 52; h >= 0; h--) {
        if (Math.floor(size / 2 ** h) % 2 === 1) { out.push({ height: h, leafStart }); leafStart += 2 ** h; }
    }
    return out;
}

/** Leaf `index` of a tree of `size` leaves, with `path` (siblings, bottom up) and the `peaks`, gives `root`. */
export function checkInclusion({ leaf, index, size, path, peaks, root }) {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return false;
    const ms = mountains(size);
    const k = ms.findIndex(m => index >= m.leafStart && index < m.leafStart + 2 ** m.height);
    const m = ms[k];
    const hexList = (l, n) => Array.isArray(l) && l.length === n && l.every(x => typeof x === 'string' && HEX64.test(x));
    if (!hexList(path, m.height) || !hexList(peaks, ms.length) || !HEX64.test(leaf || '')) return false;
    let cur = buf(leaf);
    let j = index - m.leafStart;                       // position among the leaves of its mountain
    for (const sibling of path) {
        cur = j % 2 === 0 ? nodeHash(cur, buf(sibling)) : nodeHash(buf(sibling), cur);
        j = Math.floor(j / 2);
    }
    return cur.toString('hex') === peaks[k] && rootOf(size, peaks) === root;
}

// ------------------------------------------------------------------ the trail

export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
export const contentHash = ({ seq, eventId, type, source, time, actor, subjects, data }) =>
    sha256(canonicalJson({ seq, eventId, type, source, time, actor, subjects, data })).toString('hex');
export const chainHash = (prev, content) => sha256(buf(prev), buf(content)).toString('hex');

// ------------------------------------------------------------------ the chain

const KOIOS = { preview: 'https://preview.koios.rest/api/v1', preprod: 'https://preprod.koios.rest/api/v1', mainnet: 'https://api.koios.rest/api/v1' };
const BLOCKFROST = { preview: 'https://cardano-preview.blockfrost.io/api/v0', preprod: 'https://cardano-preprod.blockfrost.io/api/v0', mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0' };

class Unreachable extends Error {}

async function getJson(url, init, fetchImpl) {
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) }); } catch (err) { throw new Unreachable(`${new URL(url).host} cannot be reached: ${err.message}`); }
    if (res.status === 404) return null;
    if (!res.ok) throw new Unreachable(`${new URL(url).host} answered HTTP ${res.status}`);
    return res.json();
}

/**
 * The anchoring transaction as a public source reports it: { found, metadata (label 8890), blockHeight,
 * confirmations, inputAddresses (who paid for it) }. Koios needs no key; Blockfrost a project key for
 * the network.
 */
export async function readAnchoring({ tx, network, source = 'koios', key, fetchImpl = globalThis.fetch }) {
    if (source === 'koios') {
        const base = KOIOS[network];
        if (!base) throw new Unreachable(`No Koios address for network "${network}"`);
        const post = (path, extra = {}) => getJson(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _tx_hashes: [tx], ...extra }) }, fetchImpl);
        const [md, status, info] = await Promise.all([post('/tx_metadata'), post('/tx_status'), post('/tx_info', { _inputs: true, _metadata: false, _assets: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false })]);
        const found = Array.isArray(info) && info.length > 0;
        return {
            found,
            metadata: md?.[0]?.metadata?.[String(LABEL)] ?? null,
            blockHeight: found ? info[0].block_height ?? null : null,
            confirmations: status?.[0]?.num_confirmations ?? null,
            inputAddresses: found ? (info[0].inputs || []).map(i => i.payment_addr?.bech32 ?? null) : []
        };
    }
    if (source === 'blockfrost') {
        const base = BLOCKFROST[network];
        if (!base) throw new Unreachable(`No Blockfrost address for network "${network}"`);
        if (!key) throw new Unreachable('Blockfrost needs a project key: BLOCKFROST_PROJECT_ID or --key-file');
        const get = (path) => getJson(`${base}${path}`, { headers: { project_id: key } }, fetchImpl);
        const info = await get(`/txs/${tx}`);
        if (!info) return { found: false, metadata: null, blockHeight: null, confirmations: null, inputAddresses: [] };
        const [rows, tip, utxos] = await Promise.all([get(`/txs/${tx}/metadata`), get('/blocks/latest'), get(`/txs/${tx}/utxos`)]);
        return {
            found: true,
            metadata: (rows || []).find(r => String(r.label) === String(LABEL))?.json_metadata ?? null,
            blockHeight: info.block_height,
            confirmations: tip ? tip.height - info.block_height + 1 : null,
            inputAddresses: (utxos?.inputs || []).map(i => i.address ?? null)
        };
    }
    throw new Unreachable(`Unknown source "${source}": koios or blockfrost`);
}

// ------------------------------------------------------------------ the proof

/**
 * Check a proof. Returns { valid, checks: [{ name, ok, detail }], anchoring, notes } and never throws
 * for a bad proof; throws Unreachable when the chain cannot be read (exit code 2). `address`: the
 * installation's published anchoring wallet; the proof's own must equal it.
 */
export async function verifyProof(proof, { source = 'koios', key, address, fetchImpl = globalThis.fetch } = {}) {
    const checks = [];
    const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
    if (proof?.format !== 'lrfe-audit-proof/1') { check('proof format', false, `not an audit proof (format ${JSON.stringify(proof?.format)})`); return { valid: false, checks }; }
    if (!proof.leaf || !proof.tree || !proof.anchor) {
        check('anchored', false, 'not anchored yet: this proof was made before its anchoring; fetch the proof again later');
        return { valid: false, checks };
    }
    const { item, leaf, tree, anchor } = proof;

    // 1. the item and its leaf
    if (item.kind === 'trail-entry') {
        const t = proof.trail;
        const e = t?.entry;
        const intact = !!e && contentHash(e) === e.contentHash && chainHash(e.prevHash, e.contentHash) === e.hash && e.seq === item.seq;
        check('trail entry', intact, intact ? `entry ${e.seq} (${e.type}) is as it was recorded` : 'the entry does not match its hashes: it was changed');
        let end = intact ? e.hash : null;
        for (const c of (intact ? t.later : [])) {
            if (!HEX64.test(c || '')) { end = null; break; }
            end = chainHash(end, c);
        }
        const counted = intact && Array.isArray(t.later) && t.checkpoint?.seq === e.seq + t.later.length;
        check('trail chain to the checkpoint', counted && end === t.checkpoint?.hash && t.checkpoint.hash === leaf.item && leaf.type === 3,
            `${t?.later?.length ?? 0} later entries up to checkpoint ${t?.checkpoint?.seq}`);
    } else {
        const type = item.kind === 'record-version' ? 1 : item.kind === 'document-version' ? 2 : null;
        check('item', type !== null && leaf.type === type && leaf.item === item.seal,
            type === null ? `unknown kind ${item.kind}` : `${item.kind} ${item.recordId ?? item.documentId} v${item.version}, seal ${String(item.seal).slice(0, 16)}…`);
    }
    const lh = HEX64.test(leaf.item || '') && [1, 2, 3].includes(leaf.type) ? leafHash(leaf.type, leaf.item) : null;
    check('leaf', lh !== null && lh === leaf.hash, `leaf ${leaf.index}`);

    // 2. the path to the root
    check('path to the root', lh !== null && checkInclusion({ leaf: lh, index: leaf.index, size: tree.size, path: tree.path, peaks: tree.peaks, root: tree.root }),
        `tree of ${tree.size} leaves, root ${String(tree.root).slice(0, 16)}…`);

    // 3. the root on the chain
    const onChain = await readAnchoring({ tx: anchor.tx, network: anchor.network, source, key, fetchImpl });
    const md = onChain.metadata;
    check('transaction on chain', onChain.found, onChain.found ? `${anchor.network} tx ${anchor.tx}, block ${onChain.blockHeight}, ${onChain.confirmations ?? '?'} confirmations (${source})` : `${anchor.network} tx ${anchor.tx} is not on the chain (${source})`);
    if (onChain.found) {
        check('root in the transaction', !!md && md.sys === 'lrfe-audit' && md.root === tree.root && Number(md.size) === tree.size,
            md ? `label ${LABEL}: root ${String(md.root).slice(0, 16)}…, size ${md.size}, batch ${md.batch}` : `no label ${LABEL} metadata in the transaction`);
        // anyone can write a root into a transaction; only the portal can pay from its wallet
        const wallet = anchor.address;
        const paid = typeof wallet === 'string' && onChain.inputAddresses.length > 0 && onChain.inputAddresses.every(a => a === wallet);
        const pinned = address === undefined || address === wallet;
        check('paid by the anchoring wallet', paid && pinned,
            !wallet ? 'the proof names no anchoring wallet'
                : !pinned ? `the proof's wallet ${wallet} is not the given address ${address}`
                    : paid ? `${wallet}${address ? ' (the given address)' : ''}` : `the transaction was paid from ${onChain.inputAddresses.join(', ') || 'unknown addresses'}, not ${wallet}`);
    }
    const notes = [];
    if (address === undefined && anchor.address) notes.push(`Compare the anchoring wallet ${anchor.address} with the address the installation publishes, or pass it with --address.`);
    if (item.kind !== 'trail-entry') notes.push('Which record or document version the seal belongs to is taken from the proof: recomputing the seal needs the version\'s data (the evidence pack).');
    return { valid: checks.every(c => c.ok), checks, notes, anchoring: { network: anchor.network, tx: anchor.tx, ...onChain } };
}

// ------------------------------------------------------------------ command line

async function main(argv) {
    const args = argv.slice(2);
    const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
    const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
    const source = flag('--source') || 'koios';
    const keyFile = flag('--key-file');
    const address = flag('--address');
    const file = args[0];
    if (!file || file === '--help' || file === '-h') {
        process.stdout.write('usage: node lrfe-verify.mjs proof.json [--address <anchoring wallet>] [--source koios|blockfrost] [--key-file <file>] [--json]\n');
        return file ? 0 : 2;
    }
    let proof;
    try { proof = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { process.stderr.write(`Cannot read the proof ${file}: ${err.message}\n`); return 2; }
    // a proof may be the verify call's answer, which holds the proof
    if (proof?.proof?.format) proof = proof.proof;
    const key = source === 'blockfrost' ? (keyFile ? readFileSync(keyFile, 'utf8').trim() : process.env.BLOCKFROST_PROJECT_ID) : undefined;
    let result;
    try { result = await verifyProof(proof, { source, key, address }); } catch (err) {
        if (!(err instanceof Unreachable)) throw err;
        process.stderr.write(`Could not check against the chain: ${err.message}\n`);
        return 2;
    }
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
        for (const c of result.checks) process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}\n`);
        for (const n of result.notes || []) process.stdout.write(`note  ${n}\n`);
        process.stdout.write(result.valid ? '\nVALID: the item was in the tree whose root the anchoring wallet put on Cardano in that transaction.\n' : '\nNOT VALID.\n');
    }
    return result.valid ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main(process.argv).then(code => { process.exitCode = code; }, err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 2; });
}
