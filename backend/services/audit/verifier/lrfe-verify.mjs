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
 *   node lrfe-verify.mjs evidence-LR-….zip --address …     an evidence pack (or the folder it was unpacked
 *                                                         into): every file, seal, trail entry and proof
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
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';
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
export async function verifyProof(proof, { source = 'koios', key, address, fetchImpl = globalThis.fetch, cache = null } = {}) {
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
    // a pack holds many proofs of the same few transactions: each is read from the chain once
    const cacheKey = `${source}:${anchor.network}:${anchor.tx}`;
    if (cache && !cache.has(cacheKey)) cache.set(cacheKey, readAnchoring({ tx: anchor.tx, network: anchor.network, source, key, fetchImpl }));
    const onChain = await (cache ? cache.get(cacheKey) : readAnchoring({ tx: anchor.tx, network: anchor.network, source, key, fetchImpl }));
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

// ------------------------------------------------------------------ evidence packs (API-660)

/**
 * The files of an evidence pack: a .zip as the portal exports it, or the folder it was unpacked into
 * (symbolic links are not followed). A name twice in the zip is refused.
 */
export function readPack(path) {
    const files = new Map();
    if (statSync(path).isDirectory()) {
        const walk = (dir) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                const st = lstatSync(full);
                if (st.isSymbolicLink()) continue;
                if (st.isDirectory()) walk(full);
                else files.set(relative(path, full).split('\\').join('/'), readFileSync(full));
            }
        };
        walk(path);
        return files;
    }
    const z = readFileSync(path);
    let end = z.length - 22;
    while (end >= 0 && z.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0) throw new Error(`${path} is not a zip file`);
    const count = z.readUInt16LE(end + 10);
    let at = z.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) {
        if (z.readUInt32LE(at) !== 0x02014b50) throw new Error(`${path}: damaged zip directory`);
        const method = z.readUInt16LE(at + 10), size = z.readUInt32LE(at + 20), unpacked = z.readUInt32LE(at + 24);
        const nameLen = z.readUInt16LE(at + 28), extraLen = z.readUInt16LE(at + 30), commentLen = z.readUInt16LE(at + 32);
        const local = z.readUInt32LE(at + 42);
        const name = z.subarray(at + 46, at + 46 + nameLen).toString('utf8');
        const start = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
        const body = z.subarray(start, start + size);
        if (files.has(name)) throw new Error(`${path}: ${name} is in the zip twice`);
        if (!name.endsWith('/')) {
            if (method === 8) files.set(name, inflateRawSync(body, { maxOutputLength: Math.max(unpacked, 1) }));
            else if (method === 0) files.set(name, Buffer.from(body));
            else throw new Error(`${name}: unsupported compression ${method}`);
        }
        at += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}

const iso = (t) => new Date(t).toISOString();
const same = (x, y) => (x ?? null) === (y ?? null);

/** A land record version's seal, as land-records computes it (services/land-records/src/seal.js). */
export const recordSeal = (v) => sha256(canonicalJson({
    recordId: v.recordId, recordNo: v.recordNo, versionNumber: v.versionNumber, data: v.data,
    submittedById: v.submittedById ?? null, approvedById: v.approvedById ?? null, committedAt: iso(v.committedAt), previousSeal: v.previousSeal ?? null
})).toString('hex');

/** A document version's seal, as edrms computes it (services/edrms/src/seal.js). */
export const documentSeal = (v) => sha256(canonicalJson({
    documentId: v.documentId, edrmsNo: v.edrmsNo, versionNumber: v.versionNumber, sha256: v.sha256, fields: v.fields,
    recordMetadata: v.recordMetadata, createdAt: iso(v.createdAt), createdById: v.createdById ?? null, approvedById: v.approvedById ?? null,
    provenance: v.provenance ?? undefined
})).toString('hex');

const proofName = (edrmsNo) => edrmsNo.replace(/[^A-Za-z0-9._-]+/g, '_');
// how much older than an anchored trail entry an item may be and still not be in that anchoring (event delay)
const STALE_MS = 10 * 60_000;

/**
 * Check an evidence pack (README.md §6 of the audit service). Returns { valid, checks, unproven, notes }:
 *
 *   1. every file against manifest.json, nothing added or removed, every JSON file readable;
 *   2. the committed versions: each seal recomputed, each following the one before (the first has no
 *      previous seal), record.json agreeing with them; every document version they pin present, with
 *      the pinned seal and type, its file matching the SHA-256 it was sealed with; no other documents;
 *   3. the trail entries' hashes; sign-offs and findings against their trail entries, both ways;
 *   4. a proof file for every version, document version and trail entry, proving that very item, and
 *      checked against the chain. An item without an anchored proof of its own counts as proven when an
 *      anchored item pins it: a later version (previous seals), a version (its documents' seals), an
 *      anchored trail proof (the hashes of the entries up to its checkpoint). A placeholder that such a
 *      pin contradicts fails; items pinned by nothing are listed as unproven.
 */
export async function verifyPack(files, { source = 'koios', key, address, fetchImpl = globalThis.fetch } = {}) {
    const checks = [], notes = [];
    const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
    const read = (path) => { try { return JSON.parse(files.get(path).toString('utf8')); } catch { return undefined; } };
    const manifest = read('manifest.json');
    if (!check('manifest', manifest?.format === 'lrfe-evidence-pack/1' && Array.isArray(manifest.files), manifest ? `${manifest.record?.recordNo} exported ${manifest.exportedAt} by ${manifest.exportedBy?.name}` : 'no manifest.json: not an evidence pack')) {
        return { valid: false, checks, unproven: [], notes };
    }
    // 1. the files as exported
    const listed = new Set(manifest.files.map(f => f.path));
    const changed = manifest.files.filter(f => !files.has(f.path) || sha256(files.get(f.path)).toString('hex') !== f.sha256).map(f => f.path);
    const extra = [...files.keys()].filter(p => p !== 'manifest.json' && !listed.has(p));
    check('files as exported', !changed.length && !extra.length,
        changed.length || extra.length ? [changed.length && `changed or missing: ${changed.join(', ')}`, extra.length && `not in the manifest: ${extra.join(', ')}`].filter(Boolean).join('; ') : `${manifest.files.length} files match manifest.json (SHA-256 ${sha256(files.get('manifest.json')).toString('hex')})`);
    const unreadable = [...files.keys()].filter(p => p.endsWith('.json') && read(p) === undefined);
    check('files readable', !unreadable.length, unreadable.length ? `not readable: ${unreadable.join(', ')}` : 'every JSON file reads');

    // 2. versions, record, documents
    const record = read('record/record.json');
    const versions = [...files.keys()].filter(p => /^record\/versions\/v\d+\.json$/.test(p)).map(read).filter(v => v && typeof v === 'object').sort((x, y) => x.versionNumber - y.versionNumber);
    check('committed versions', versions.length > 0, versions.length ? `${versions.length} (${versions.map(v => `v${v.versionNumber}`).join(', ')})` : 'none in the pack');
    const items = [];                                       // { key, what, proof, seal?, covered }
    let previous = null;
    for (const v of versions) {
        const seal = recordSeal({ ...v, recordId: v.recordId ?? record?.id, recordNo: v.recordNo ?? record?.recordNo });
        check(`land record version ${v.versionNumber}`, seal === v.seal && same(v.previousSeal, previous),
            seal !== v.seal ? 'its content does not match its seal: it was changed' : !same(v.previousSeal, previous) ? 'it does not follow the version before it in the pack (one is missing or changed)' : `seal ${v.seal.slice(0, 16)}… recomputed`);
        items.push({ key: `v${v.versionNumber}`, what: `land record version ${v.versionNumber}`, proof: `proofs/record-v${v.versionNumber}.json`, seal: v.seal, version: v, time: v.committedAt });
        previous = v.seal;
    }
    const last = versions.at(-1);
    check('record', !!record && versions.every(v => same(v.recordId ?? record.id, record.id)) && (!last || record.currentVersion === last.versionNumber),
        !record ? 'record/record.json is missing' : last && record.currentVersion !== last.versionNumber ? `record.json says the current version is ${record.currentVersion}, the pack's last is ${last.versionNumber}` : `${record.recordNo}, current version ${record.currentVersion}`);
    // the document versions the versions pin, and nothing else
    const pinned = new Map();                               // documentId:version → every pin of it: [{ seal, docType, edrmsNo, by }]
    for (const v of versions) for (const d of v.data?.documents || []) {
        const k = `${d.edrmsDocumentId}:${d.version}`;
        if (!pinned.has(k)) pinned.set(k, []);
        pinned.get(k).push({ seal: d.seal, docType: d.docType, edrmsNo: d.edrmsNo, by: v.versionNumber });
    }
    const docs = new Map();
    for (const path of [...files.keys()].filter(p => /^documents\/[^/]+\/v\d+\.json$/.test(p))) {
        const d = read(path);
        if (d) docs.set(`${d.documentId}:${d.versionNumber}`, { path, d });
    }
    for (const [k, pins] of pinned) {
        const entry = docs.get(k);
        const name = `${pins[0].edrmsNo ?? k} version ${k.split(':')[1]}`;
        if (!entry) { check(name, false, `pinned in land record version ${pins.map(x => x.by).join(', ')} but not in the pack`); continue; }
        const { path, d } = entry;
        const file = files.get(`${path.slice(0, path.lastIndexOf('/'))}/${d.file}`);
        const fileOk = !!file && sha256(file).toString('hex') === d.sha256;
        const seal = documentSeal(d);
        const problem = !file ? 'its file is missing'
            : !fileOk ? 'its file does not match the SHA-256 it was sealed with: the file was changed'
                : seal !== d.seal ? 'its metadata does not match its seal: it was changed'
                    : pins.find(x => x.seal !== d.seal) ? `its seal is not the one land record version ${pins.find(x => x.seal !== d.seal).by} pins: it was replaced`
                        : pins.find(x => x.docType && x.docType !== d.docType) ? 'its type is not the one the land record pins' : null;
        check(name, !problem, problem ?? `file and metadata match seal ${d.seal.slice(0, 16)}…, as pinned in version ${pins.map(x => x.by).join(', ')}`);
        items.push({ key: `d${k}`, what: name, proof: `proofs/${proofName(d.edrmsNo)}-v${d.versionNumber}.json`, seal: d.seal, pinnedBy: pins.map(x => `v${x.by}`), documentId: d.documentId, version: d.versionNumber, sha256: d.sha256, time: d.createdAt });
    }
    const unpinned = [...docs.keys()].filter(k => !pinned.has(k)).map(k => docs.get(k).path);
    check('documents', !unpinned.length, unpinned.length ? `not pinned in any version: ${unpinned.join(', ')}` : `${pinned.size} pinned document versions`);

    // 3. the trail, and sign-offs and findings as recorded in it (both ways)
    const entries = Array.isArray(read('trail/entries.json')) ? read('trail/entries.json') : [];
    const broken = entries.filter(e => contentHash(e) !== e.contentHash || chainHash(e.prevHash, e.contentHash) !== e.hash).map(e => e.seq);
    check('trail entries', files.has('trail/entries.json') && !broken.length, broken.length ? `entries ${broken.join(', ')} do not match their hashes: changed` : `${entries.length} entries match their hashes`);
    for (const e of entries) items.push({ key: `t${e.seq}`, what: `trail entry ${e.seq}`, proof: `proofs/trail-${e.seq}.json`, entry: e });
    // each version against its commit entry, each document version against its filing or correction entry:
    // they carry the seals, so an anchored entry also proves the item (and a forged item cannot match it)
    const commits = entries.filter(e => e.type === 'records.record.committed' && same(e.data?.recordId, record?.id));
    for (const it of items.filter(i => i.version)) {
        const v = it.version, e = commits.find(c => c.data.versionNumber === v.versionNumber);
        if (!e) continue;
        // bound: proven with the entry; its time (the event's clock, like the other entries) is the one compared below
        if (check(it.what, e.data.seal === v.seal && same(e.data.previousSeal, v.previousSeal), `its seal is not the one in its commit entry (trail entry ${e.seq})`)) { checks.pop(); it.boundTo = `t${e.seq}`; it.time = e.time; }
    }
    const notInPack = commits.filter(c => !versions.some(v => v.versionNumber === c.data.versionNumber)).map(c => c.data.versionNumber);
    check('versions in the trail', !notInPack.length, notInPack.length ? `committed in the trail but missing from the pack: version ${notInPack.join(', ')}` : `${commits.length} commits in the trail, all in the pack`);
    for (const it of items.filter(i => i.documentId)) {
        const e = entries.find(x => same(x.data?.documentId, it.documentId)
            && ((x.type === 'edrms.document.filed' && it.version === 1) || (x.type === 'edrms.document.amended' && x.data.version === it.version)));
        if (!e) continue;
        if (check(it.what, e.data.seal === it.seal && same(e.data.sha256, it.sha256), `its seal is not the one in its ${e.type === 'edrms.document.filed' ? 'filing' : 'correction'} entry (trail entry ${e.seq})`)) { checks.pop(); it.boundTo = `t${e.seq}`; it.time = e.time; }
    }
    const byType = (type, idKey) => new Map(entries.filter(e => e.type === type).map(e => [e.data?.[idKey], e]));
    const itemMatches = (row, e) => same(row.recordId, e.data.recordId) && same(row.recordNo, e.data.recordNo) && same(row.recordVersion, e.data.versionNumber)
        && same(row.documentId, e.data.edrmsDocumentId) && same(row.edrmsNo, e.data.edrmsNo) && same(row.documentVersion, e.data.documentVersion) && same(row.seal, e.data.seal);
    const signoffs = read('signoffs.json') || [], findings = read('findings.json') || [];
    const signed = byType('audit.signoff.recorded', 'signoffId');
    const badSignoffs = signoffs.filter(s => { const e = signed.get(s.id); return !e || !itemMatches(s, e) || e.data.comment !== s.comment || !same(e.actor?.id, s.signedById) || !same(e.actor?.name, s.signedByName); });
    const missingSignoffs = [...signed.keys()].filter(id => !signoffs.some(s => s.id === id));
    check('sign-offs', !badSignoffs.length && !missingSignoffs.length,
        badSignoffs.length ? `${badSignoffs.length} do not match their trail entries` : missingSignoffs.length ? `${missingSignoffs.length} in the trail are missing from signoffs.json` : `${signoffs.length} match their trail entries`);
    const raised = byType('audit.finding.raised', 'findingId'), closed = byType('audit.finding.closed', 'findingId');
    const badFindings = findings.filter(f => {
        const r = raised.get(f.id), c = closed.get(f.id);
        if (!r || !itemMatches(f, r) || r.data.description !== f.description || !same(r.actor?.id, f.raisedById) || !same(r.actor?.name, f.raisedByName) || !same(r.data.instanceId, f.instanceId)) return true;
        if (f.status === 'open') return !!c;
        if (!c || c.data.outcome !== f.status) return true;
        return f.status === 'closed' ? !same(c.data.reason, f.closeReason) || !same(c.actor?.id, f.closedById) || !same(c.actor?.name, f.closedByName) : !same(c.data.resolvedByVersion, f.resolvedByVersion);
    });
    const missingFindings = [...raised.keys()].filter(id => !findings.some(f => f.id === id));
    check('findings', !badFindings.length && !missingFindings.length,
        badFindings.length ? `${badFindings.length} do not match their trail entries` : missingFindings.length ? `${missingFindings.length} in the trail are missing from findings.json` : `${findings.length} match their trail entries`);

    // 4. proofs: one for every item, proving that item; checked on chain
    const expected = new Set(items.map(i => i.proof));
    const strayProofs = [...files.keys()].filter(p => p.startsWith('proofs/') && !expected.has(p));
    check('proof files', !strayProofs.length && items.every(i => files.has(i.proof)),
        strayProofs.length ? `proofs of nothing in the pack: ${strayProofs.join(', ')}` : items.some(i => !files.has(i.proof)) ? `missing: ${items.filter(i => !files.has(i.proof)).map(i => i.proof).join(', ')}` : `one for each of the ${items.length} items`);
    const cache = new Map();
    const anchoredTrail = [];
    for (const it of items) {
        const proof = read(it.proof);
        if (!proof) continue;                                   // missing: reported above
        const ofItem = it.entry ? !!proof.trail?.entry && canonicalJson(proof.trail.entry) === canonicalJson(it.entry) : proof.item?.seal === it.seal;
        if (!check(it.proof, ofItem, ofItem ? 'proves the item in the pack' : 'proves another item than the one in the pack')) continue;
        checks.pop();                                           // only failures are listed per proof
        if (!['anchored', 'confirmed'].includes(proof.status)) continue;
        const r = await verifyProof(proof, { source, key, address, fetchImpl, cache });
        const failed = r.checks.filter(c => !c.ok);
        // sent but not yet confirmed at export: a transaction still on its way is not proven yet, not a failure
        if (proof.status === 'anchored' && failed.length === 1 && failed[0].name === 'transaction on chain') continue;
        if (failed.length) { check(it.proof, false, failed.map(c => `${c.name}: ${c.detail}`).join('; ')); continue; }
        it.anchored = true;
        if (it.entry) anchoredTrail.push({ seq: it.entry.seq, entry: proof.trail.entry, later: proof.trail.later, checkpoint: proof.trail.checkpoint.seq });
    }
    // what anchored items pin: later trail entries up to a checkpoint (and the entry before), the versions
    // and documents those entries commit or file, earlier versions (previous seals), their documents
    const covered = new Set(items.filter(i => i.anchored).map(i => i.key));
    for (const it of items.filter(x => x.entry && !x.anchored)) {
        const e = it.entry;
        for (const t of anchoredTrail) {
            if (e.seq > t.seq && e.seq <= t.checkpoint) {
                if (t.later[e.seq - t.seq - 1] === e.contentHash) covered.add(it.key);
                else check(it.what, false, `does not match the anchored chain of trail entry ${t.seq} (its proof's later entries): changed or forged`);
            }
            if (t.seq === e.seq + 1 && t.entry.prevHash !== e.hash) check(it.what, false, `is not the entry before anchored trail entry ${t.seq}: changed or forged`);
            else if (t.seq === e.seq + 1) covered.add(it.key);
        }
    }
    for (const it of items) if (it.boundTo && covered.has(it.boundTo)) covered.add(it.key);
    for (let i = versions.length - 1; i >= 1; i--) if (covered.has(`v${versions[i].versionNumber}`)) covered.add(`v${versions[i - 1].versionNumber}`);
    for (const it of items) if (it.pinnedBy?.some(v => covered.has(v))) covered.add(it.key);
    // "not yet anchored" must be true: a version or document version older than trail entries the pack
    // shows anchored would be in that anchoring (its seal went into the tree when it was committed or
    // filed). Without a proof it was changed, or the audit tree misses it (before the audit service, not
    // backfilled).
    const anchoredUntil = Math.max(...anchoredTrail.map(t => Date.parse(t.entry.time)).filter(Number.isFinite), -Infinity);
    for (const it of items.filter(i => i.time && !covered.has(i.key))) {
        if (!it.boundTo) {
            check(it.what, false, 'it is not proven on chain and its commit or filing is not in the pack\'s trail: it was changed, the audit tree misses it (run the backfill), or the pack was exported in the moment before its commit was recorded (export again)');
        } else if (Date.parse(it.time) + STALE_MS < anchoredUntil) {
            check(it.what, false, `it is older than trail entries anchored up to ${new Date(anchoredUntil).toISOString()}, so it should be in that anchoring, but it has no proof: it was changed, or the audit tree misses it (run the backfill)`);
        }
    }
    const unproven = items.filter(i => !covered.has(i.key)).map(i => i.what);
    check('proofs on chain', true, `${items.filter(i => i.anchored).length} proofs checked against the chain; ${covered.size} of ${items.length} items proven${unproven.length ? `, ${unproven.length} not yet anchored` : ''}`);

    const wallet = manifest.anchoring?.wallet;
    if (address === undefined && wallet) notes.push(`Compare the anchoring wallet ${wallet} with the address the portal publishes, or pass it with --address.`);
    if (unproven.length) notes.push(`Not proven on chain: ${unproven.join(', ')}. They may be newer than the last anchoring, or changed since the export: an offline check cannot tell. Export the pack again after the next anchoring, or check them with the portal.`);
    notes.push('Not covered by any seal, shown as exported: README.txt, manifest.json\'s exportedBy, exportedAt and anchoring, record.json beyond its id and current version, document titles, the times of sign-offs and findings.');
    notes.push(`An offline check cannot show that nothing was left out: the newest version, or a trail entry, removed together with its proof (a version in between breaks the chain of seals and is caught). The portal can: it recorded this export with the SHA-256 of its manifest (${sha256(files.get('manifest.json')).toString('hex')}) in its trail (audit.evidence.exported), anchored with the next root.`);
    return { valid: checks.every(c => c.ok), checks, unproven, notes };
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
        process.stdout.write('usage: node lrfe-verify.mjs <proof.json | evidence pack .zip or folder> [--address <anchoring wallet>] [--source koios|blockfrost] [--key-file <file>] [--json]\n');
        return file ? 0 : 2;
    }
    const key = source === 'blockfrost' ? (keyFile ? readFileSync(keyFile, 'utf8').trim() : process.env.BLOCKFROST_PROJECT_ID) : undefined;
    let isPack = false;
    try { isPack = file.endsWith('.zip') || statSync(file).isDirectory(); } catch { /* reported below */ }
    if (isPack) return checkPack(file, { source, key, address, json });
    let proof;
    try { proof = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { process.stderr.write(`Cannot read the proof ${file}: ${err.message}\n`); return 2; }
    // a proof may be the verify call's answer, which holds the proof
    if (proof?.proof?.format) proof = proof.proof;
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

async function checkPack(path, { source, key, address, json }) {
    let files;
    try { files = readPack(path); } catch (err) { process.stderr.write(`Cannot read the evidence pack ${path}: ${err.message}\n`); return 2; }
    let result;
    try { result = await verifyPack(files, { source, key, address }); } catch (err) {
        if (!(err instanceof Unreachable)) throw err;
        process.stderr.write(`Could not check against the chain: ${err.message}\n`);
        return 2;
    }
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
        for (const c of result.checks) process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}\n`);
        for (const n of result.notes) process.stdout.write(`note  ${n}\n`);
        process.stdout.write(!result.valid ? '\nNOT VALID.\n'
            : result.unproven.length ? `\nVALID AS FAR AS ANCHORED: the pack is consistent and its anchored items are as exported; ${result.unproven.length} items are not proven on chain (see above): they may be newer than the last anchoring, or changed since the export.\n`
                : '\nVALID: the pack is consistent and as exported, and every version, document and trail entry in it existed unchanged when its root was put on Cardano.\n');
    }
    return result.valid ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main(process.argv).then(code => { process.exitCode = code; }, err => { process.stderr.write(`${err.stack}\n`); process.exitCode = 2; });
}
