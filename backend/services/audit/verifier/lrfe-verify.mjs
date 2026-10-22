#!/usr/bin/env node
/**
 * lrfe-verify: check an audit proof of the land records portal without the portal.
 *
 *   node lrfe-verify.mjs proof.json                       reads the anchoring from Koios (free, no key)
 *   node lrfe-verify.mjs proof.json --source blockfrost   from Blockfrost: the project key in
 *                                                         BLOCKFROST_PROJECT_ID or --key-file <file>
 *   node lrfe-verify.mjs proof.json --address addr_test1…  also require the installation's published
 *                                                         anchoring wallet (recommended)
 *   node lrfe-verify.mjs proof.json --json                the result as JSON
 *   node lrfe-verify.mjs evidence-LR-….zip --address …     an evidence pack (or the folder it was unpacked
 *                                                         into): every file, seal, trail entry and proof
 *   node lrfe-verify.mjs extract.pdf --address … --seal …  an ownership extract: the proof attached inside
 *                                                         it against the blockchain, and the registry's seal
 *                                                         against its published certificate fingerprint
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
 * Exit code 0: valid; 1: not valid; 2: could not be checked (no proof file, a PDF that cannot be
 * read, the chain unreachable).
 *
 * The hashing is that of the portal's audit service (services/audit/README.md sections 1 and 2):
 *   leaf = SHA-256(0x00 || type || item)    node = SHA-256(0x01 || left || right)
 *   root = SHA-256(0x02 || size as 8 bytes big-endian || peaks, largest first)
 *   trail: contentHash = SHA-256(canonical JSON of the entry), hash = SHA-256(prevHash || contentHash)
 */
import {X509Certificate, createHash, verify as cryptoVerify} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {inflateRawSync, inflateSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';

export const LABEL = 8890;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const buf = hex => Buffer.from(hex, 'hex');

// ------------------------------------------------------------------ the tree

/** The hash of a leaf: SHA-256(0x00 || type || item), as hex. */
export const leafHash = (type, item) =>
  sha256(Buffer.from([0x00, type]), buf(item)).toString('hex');
const nodeHash = (l, r) => sha256(Buffer.from([0x01]), l, r);
/** The root of a tree from its size and peaks, largest first, as hex. */
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
    if (Math.floor(size / 2 ** h) % 2 === 1) {
      out.push({height: h, leafStart});
      leafStart += 2 ** h;
    }
  }
  return out;
}

/** Leaf `index` of a tree of `size` leaves, with `path` (siblings, bottom up) and the `peaks`, gives `root`. */
export function checkInclusion({leaf, index, size, path, peaks, root}) {
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(size) ||
    index < 0 ||
    index >= size
  ) {
    return false;
  }
  const ms = mountains(size);
  const k = ms.findIndex(
    m => index >= m.leafStart && index < m.leafStart + 2 ** m.height,
  );
  const m = ms[k];
  const hexList = (l, n) =>
    Array.isArray(l) &&
    l.length === n &&
    l.every(x => typeof x === 'string' && HEX64.test(x));
  if (
    !hexList(path, m.height) ||
    !hexList(peaks, ms.length) ||
    !HEX64.test(leaf || '')
  ) {
    return false;
  }
  let cur = buf(leaf);
  let j = index - m.leafStart; // position among the leaves of its mountain
  for (const sibling of path) {
    cur =
      j % 2 === 0 ? nodeHash(cur, buf(sibling)) : nodeHash(buf(sibling), cur);
    j = Math.floor(j / 2);
  }
  return cur.toString('hex') === peaks[k] && rootOf(size, peaks) === root;
}

// ------------------------------------------------------------------ the trail

/** JSON with object keys sorted at every level, as the portal hashes it. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter(k => value[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
/**
 * A trail entry's content hash: SHA-256 of the canonical JSON of its eight content fields (seq,
 * eventId, type, source, time, actor, subjects, data), as hex.
 */
export const contentHash = ({
  seq,
  eventId,
  type,
  source,
  time,
  actor,
  subjects,
  data,
}) =>
  sha256(
    canonicalJson({seq, eventId, type, source, time, actor, subjects, data}),
  ).toString('hex');
/** A trail entry's hash: SHA-256(previous hash || content hash), as hex. */
export const chainHash = (prev, content) =>
  sha256(buf(prev), buf(content)).toString('hex');

// ------------------------------------------------------------------ the chain

const KOIOS = {
  preview: 'https://preview.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  mainnet: 'https://api.koios.rest/api/v1',
};
const BLOCKFROST = {
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
};

class Unreachable extends Error {}

/** A time in seconds since 1970, as the public sources give it, in ISO form; null when not given. */
const isoFromUnix = seconds =>
  Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

async function getJson(url, init, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {...init, signal: AbortSignal.timeout(20_000)});
  } catch (err) {
    throw new Unreachable(
      `${new URL(url).host} cannot be reached: ${err.message}`,
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Unreachable(`${new URL(url).host} answered HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * The anchoring transaction as a public source reports it: { found, metadata (label 8890), blockHeight,
 * blockTime (ISO, null when the source does not say), confirmations, inputAddresses (who paid for it) }.
 * Koios needs no key; Blockfrost a project key for the network.
 */
export async function readAnchoring({
  tx,
  network,
  source = 'koios',
  key,
  fetchImpl = globalThis.fetch,
}) {
  if (source === 'koios') {
    const base = KOIOS[network];
    if (!base) {
      throw new Unreachable(`No Koios address for network "${network}"`);
    }
    const post = (path, extra = {}) =>
      getJson(
        `${base}${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({_tx_hashes: [tx], ...extra}),
        },
        fetchImpl,
      );
    const [md, status, info] = await Promise.all([
      post('/tx_metadata'),
      post('/tx_status'),
      post('/tx_info', {
        _inputs: true,
        _metadata: false,
        _assets: false,
        _withdrawals: false,
        _certs: false,
        _scripts: false,
        _bytecode: false,
      }),
    ]);
    const found = Array.isArray(info) && info.length > 0;
    return {
      found,
      metadata: md?.[0]?.metadata?.[String(LABEL)] ?? null,
      blockHeight: found ? (info[0].block_height ?? null) : null,
      blockTime: found ? isoFromUnix(info[0].tx_timestamp) : null,
      confirmations: status?.[0]?.num_confirmations ?? null,
      inputAddresses: found
        ? (info[0].inputs || []).map(i => i.payment_addr?.bech32 ?? null)
        : [],
    };
  }
  if (source === 'blockfrost') {
    const base = BLOCKFROST[network];
    if (!base) {
      throw new Unreachable(`No Blockfrost address for network "${network}"`);
    }
    if (!key) {
      throw new Unreachable(
        'Blockfrost needs a project key: BLOCKFROST_PROJECT_ID or --key-file',
      );
    }
    const get = path =>
      getJson(`${base}${path}`, {headers: {project_id: key}}, fetchImpl);
    const info = await get(`/txs/${tx}`);
    if (!info) {
      return {
        found: false,
        metadata: null,
        blockHeight: null,
        blockTime: null,
        confirmations: null,
        inputAddresses: [],
      };
    }
    const [rows, tip, utxos] = await Promise.all([
      get(`/txs/${tx}/metadata`),
      get('/blocks/latest'),
      get(`/txs/${tx}/utxos`),
    ]);
    return {
      found: true,
      metadata:
        (rows || []).find(r => String(r.label) === String(LABEL))
          ?.json_metadata ?? null,
      blockHeight: info.block_height,
      blockTime: isoFromUnix(info.block_time),
      confirmations: tip ? tip.height - info.block_height + 1 : null,
      inputAddresses: (utxos?.inputs || []).map(i => i.address ?? null),
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
export async function verifyProof(
  proof,
  {
    source = 'koios',
    key,
    address,
    fetchImpl = globalThis.fetch,
    cache = null,
  } = {},
) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({name, ok: !!ok, detail});
    return !!ok;
  };
  if (proof?.format !== 'lrfe-audit-proof/1') {
    check(
      'proof format',
      false,
      `not an audit proof (format ${JSON.stringify(proof?.format)})`,
    );
    return {valid: false, checks};
  }
  if (!proof.leaf || !proof.tree || !proof.anchor) {
    check(
      'anchored',
      false,
      'not anchored yet: this proof was made before its anchoring; fetch the proof again later',
    );
    return {valid: false, checks};
  }
  const {item, leaf, tree, anchor} = proof;

  // 1. the item and its leaf
  if (item.kind === 'trail-entry') {
    const t = proof.trail;
    const e = t?.entry;
    const intact =
      !!e &&
      contentHash(e) === e.contentHash &&
      chainHash(e.prevHash, e.contentHash) === e.hash &&
      e.seq === item.seq;
    check(
      'trail entry',
      intact,
      intact
        ? `entry ${e.seq} (${e.type}) is as it was recorded`
        : 'the entry does not match its hashes: it was changed',
    );
    let end = intact ? e.hash : null;
    for (const c of intact ? t.later : []) {
      if (!HEX64.test(c || '')) {
        end = null;
        break;
      }
      end = chainHash(end, c);
    }
    const counted =
      intact &&
      Array.isArray(t.later) &&
      t.checkpoint?.seq === e.seq + t.later.length;
    check(
      'trail chain to the checkpoint',
      counted &&
        end === t.checkpoint?.hash &&
        t.checkpoint.hash === leaf.item &&
        leaf.type === 3,
      `${t?.later?.length ?? 0} later entries up to checkpoint ${t?.checkpoint?.seq}`,
    );
  } else {
    const type =
      item.kind === 'record-version'
        ? 1
        : item.kind === 'document-version'
          ? 2
          : null;
    check(
      'item',
      type !== null && leaf.type === type && leaf.item === item.seal,
      type === null
        ? `unknown kind ${item.kind}`
        : `${item.kind} ${item.recordId ?? item.documentId} v${item.version}, seal ${String(item.seal).slice(0, 16)}…`,
    );
  }
  const lh =
    HEX64.test(leaf.item || '') && [1, 2, 3].includes(leaf.type)
      ? leafHash(leaf.type, leaf.item)
      : null;
  check('leaf', lh !== null && lh === leaf.hash, `leaf ${leaf.index}`);

  // 2. the path to the root
  check(
    'path to the root',
    lh !== null &&
      checkInclusion({
        leaf: lh,
        index: leaf.index,
        size: tree.size,
        path: tree.path,
        peaks: tree.peaks,
        root: tree.root,
      }),
    `tree of ${tree.size} leaves, root ${String(tree.root).slice(0, 16)}…`,
  );

  // 3. the root on the chain
  // a pack holds many proofs of the same few transactions: each is read from the chain once
  const cacheKey = `${source}:${anchor.network}:${anchor.tx}`;
  if (cache && !cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      readAnchoring({
        tx: anchor.tx,
        network: anchor.network,
        source,
        key,
        fetchImpl,
      }),
    );
  }
  const onChain = await (cache
    ? cache.get(cacheKey)
    : readAnchoring({
        tx: anchor.tx,
        network: anchor.network,
        source,
        key,
        fetchImpl,
      }));
  const md = onChain.metadata;
  check(
    'transaction on chain',
    onChain.found,
    onChain.found
      ? `${anchor.network} tx ${anchor.tx}, block ${onChain.blockHeight}, ${onChain.confirmations ?? '?'} confirmations (${source})`
      : `${anchor.network} tx ${anchor.tx} is not on the chain (${source})`,
  );
  if (onChain.found) {
    check(
      'root in the transaction',
      !!md &&
        md.sys === 'lrfe-audit' &&
        md.root === tree.root &&
        Number(md.size) === tree.size,
      md
        ? `label ${LABEL}: root ${String(md.root).slice(0, 16)}…, size ${md.size}, batch ${md.batch}`
        : `no label ${LABEL} metadata in the transaction`,
    );
    // anyone can write a root into a transaction; only the portal can pay from its wallet
    const wallet = anchor.address;
    const paid =
      typeof wallet === 'string' &&
      onChain.inputAddresses.length > 0 &&
      onChain.inputAddresses.every(a => a === wallet);
    const pinned = address === undefined || address === wallet;
    check(
      'paid by the anchoring wallet',
      paid && pinned,
      !wallet
        ? 'the proof names no anchoring wallet'
        : !pinned
          ? `the proof's wallet ${wallet} is not the given address ${address}`
          : paid
            ? `${wallet}${address ? ' (the given address)' : ''}`
            : `the transaction was paid from ${onChain.inputAddresses.join(', ') || 'unknown addresses'}, not ${wallet}`,
    );
  }
  const notes = [];
  if (address === undefined && anchor.address) {
    notes.push(
      `Compare the anchoring wallet ${anchor.address} with the address the installation publishes, or pass it with --address.`,
    );
  }
  if (item.kind !== 'trail-entry') {
    notes.push(
      "Which record or document version the seal belongs to is taken from the proof: recomputing the seal needs the version's data (the evidence pack).",
    );
  }
  return {
    valid: checks.every(c => c.ok),
    checks,
    notes,
    anchoring: {network: anchor.network, tx: anchor.tx, ...onChain},
  };
}

// ------------------------------------------------------------------ evidence packs (API-660)

/**
 * The files of an evidence pack: a .zip as the portal exports it, or the folder it was unpacked into
 * (symbolic links are not followed). A name twice in the zip is refused.
 */
export function readPack(path) {
  const files = new Map();
  if (statSync(path).isDirectory()) {
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(full);
        else {
          files.set(
            relative(path, full).split('\\').join('/'),
            readFileSync(full),
          );
        }
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
    if (z.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`${path}: damaged zip directory`);
    }
    const method = z.readUInt16LE(at + 10);
    const size = z.readUInt32LE(at + 20);
    const unpacked = z.readUInt32LE(at + 24);
    const nameLen = z.readUInt16LE(at + 28);
    const extraLen = z.readUInt16LE(at + 30);
    const commentLen = z.readUInt16LE(at + 32);
    const local = z.readUInt32LE(at + 42);
    const name = z.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start =
      local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
    const body = z.subarray(start, start + size);
    if (files.has(name)) {
      throw new Error(`${path}: ${name} is in the zip twice`);
    }
    if (!name.endsWith('/')) {
      if (method === 8) {
        files.set(
          name,
          inflateRawSync(body, {maxOutputLength: Math.max(unpacked, 1)}),
        );
      } else if (method === 0) files.set(name, Buffer.from(body));
      else throw new Error(`${name}: unsupported compression ${method}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const iso = t => new Date(t).toISOString();
const same = (x, y) => (x ?? null) === (y ?? null);

/** A land record version's seal, as land-records computes it (services/land-records/src/seal.js). */
export const recordSeal = v =>
  sha256(
    canonicalJson({
      recordId: v.recordId,
      recordNo: v.recordNo,
      versionNumber: v.versionNumber,
      data: v.data,
      submittedById: v.submittedById ?? null,
      approvedById: v.approvedById ?? null,
      committedAt: iso(v.committedAt),
      previousSeal: v.previousSeal ?? null,
    }),
  ).toString('hex');

/** A document version's seal, as edrms computes it (services/edrms/src/seal.js). */
export const documentSeal = v =>
  sha256(
    canonicalJson({
      documentId: v.documentId,
      edrmsNo: v.edrmsNo,
      versionNumber: v.versionNumber,
      sha256: v.sha256,
      fields: v.fields,
      recordMetadata: v.recordMetadata,
      createdAt: iso(v.createdAt),
      createdById: v.createdById ?? null,
      approvedById: v.approvedById ?? null,
      provenance: v.provenance ?? undefined,
    }),
  ).toString('hex');

const proofName = edrmsNo => edrmsNo.replace(/[^A-Za-z0-9._-]+/g, '_');
// how much older than an anchored trail entry an item may be and still not be in that anchoring (event delay)
const STALE_MS = 10 * 60_000;

/**
 * Check an evidence pack (README.md §6 of the audit service). Returns { valid, checks, unproven, notes }:
 *
 *   1. every file against manifest.json, nothing added or removed, every JSON file readable;
 *   2. the committed versions: each seal recomputed, each following the one before (the first has no
 *      previous seal), record.json agreeing with them; every document version they pin present, with
 *      the pinned seal and type, its file matching the SHA-256 it was sealed with; no other documents;
 *   3. the trail entries' hashes; sign-offs and findings (with their answers) against their trail entries, both ways;
 *   4. a proof file for every version, document version and trail entry, proving that very item, and
 *      checked against the chain. An item without an anchored proof of its own counts as proven when an
 *      anchored item pins it: a later version (previous seals), a version (its documents' seals), an
 *      anchored trail proof (the hashes of the entries up to its checkpoint). A placeholder that such a
 *      pin contradicts fails; items pinned by nothing are listed as unproven.
 */
export async function verifyPack(
  files,
  {source = 'koios', key, address, fetchImpl = globalThis.fetch} = {},
) {
  const checks = [];
  const notes = [];
  const check = (name, ok, detail) => {
    checks.push({name, ok: !!ok, detail});
    return !!ok;
  };
  const read = path => {
    try {
      return JSON.parse(files.get(path).toString('utf8'));
    } catch {
      return undefined;
    }
  };
  const manifest = read('manifest.json');
  if (
    !check(
      'manifest',
      manifest?.format === 'lrfe-evidence-pack/1' &&
        Array.isArray(manifest.files),
      manifest
        ? `${manifest.record?.recordNo} exported ${manifest.exportedAt} by ${manifest.exportedBy?.name}`
        : 'no manifest.json: not an evidence pack',
    )
  ) {
    return {valid: false, checks, unproven: [], notes};
  }
  // 1. the files as exported
  const listed = new Set(manifest.files.map(f => f.path));
  const changed = manifest.files
    .filter(
      f =>
        !files.has(f.path) ||
        sha256(files.get(f.path)).toString('hex') !== f.sha256,
    )
    .map(f => f.path);
  const extra = [...files.keys()].filter(
    p => p !== 'manifest.json' && !listed.has(p),
  );
  check(
    'files as exported',
    !changed.length && !extra.length,
    changed.length || extra.length
      ? [
          changed.length && `changed or missing: ${changed.join(', ')}`,
          extra.length && `not in the manifest: ${extra.join(', ')}`,
        ]
          .filter(Boolean)
          .join('; ')
      : `${manifest.files.length} files match manifest.json (SHA-256 ${sha256(files.get('manifest.json')).toString('hex')})`,
  );
  const unreadable = [...files.keys()].filter(
    p => p.endsWith('.json') && read(p) === undefined,
  );
  check(
    'files readable',
    !unreadable.length,
    unreadable.length
      ? `not readable: ${unreadable.join(', ')}`
      : 'every JSON file reads',
  );

  // 2. versions, record, documents
  const record = read('record/record.json');
  const versions = [...files.keys()]
    .filter(p => /^record\/versions\/v\d+\.json$/.test(p))
    .map(read)
    .filter(v => v && typeof v === 'object')
    .sort((x, y) => x.versionNumber - y.versionNumber);
  check(
    'committed versions',
    versions.length > 0,
    versions.length
      ? `${versions.length} (${versions.map(v => `v${v.versionNumber}`).join(', ')})`
      : 'none in the pack',
  );
  const items = []; // { key, what, proof, seal?, covered }
  let previous = null;
  for (const v of versions) {
    const seal = recordSeal({
      ...v,
      recordId: v.recordId ?? record?.id,
      recordNo: v.recordNo ?? record?.recordNo,
    });
    check(
      `land record version ${v.versionNumber}`,
      seal === v.seal && same(v.previousSeal, previous),
      seal !== v.seal
        ? 'its content does not match its seal: it was changed'
        : !same(v.previousSeal, previous)
          ? 'it does not follow the version before it in the pack (one is missing or changed)'
          : `seal ${v.seal.slice(0, 16)}… recomputed`,
    );
    items.push({
      key: `v${v.versionNumber}`,
      what: `land record version ${v.versionNumber}`,
      proof: `proofs/record-v${v.versionNumber}.json`,
      seal: v.seal,
      version: v,
      time: v.committedAt,
    });
    previous = v.seal;
  }
  const last = versions.at(-1);
  check(
    'record',
    !!record &&
      versions.every(v => same(v.recordId ?? record.id, record.id)) &&
      (!last || record.currentVersion === last.versionNumber),
    !record
      ? 'record/record.json is missing'
      : last && record.currentVersion !== last.versionNumber
        ? `record.json says the current version is ${record.currentVersion}, the pack's last is ${last.versionNumber}`
        : `${record.recordNo}, current version ${record.currentVersion}`,
  );
  // the document versions the versions pin, and nothing else
  const pinned = new Map(); // documentId:version → every pin of it: [{ seal, docType, edrmsNo, by }]
  for (const v of versions) {
    for (const d of v.data?.documents || []) {
      const k = `${d.edrmsDocumentId}:${d.version}`;
      if (!pinned.has(k)) pinned.set(k, []);
      pinned.get(k).push({
        seal: d.seal,
        docType: d.docType,
        edrmsNo: d.edrmsNo,
        by: v.versionNumber,
      });
    }
  }
  const docs = new Map();
  for (const path of [...files.keys()].filter(p =>
    /^documents\/[^/]+\/v\d+\.json$/.test(p),
  )) {
    const d = read(path);
    if (d) docs.set(`${d.documentId}:${d.versionNumber}`, {path, d});
  }
  for (const [k, pins] of pinned) {
    const entry = docs.get(k);
    const name = `${pins[0].edrmsNo ?? k} version ${k.split(':')[1]}`;
    if (!entry) {
      check(
        name,
        false,
        `pinned in land record version ${pins.map(x => x.by).join(', ')} but not in the pack`,
      );
      continue;
    }
    const {path, d} = entry;
    const file = files.get(`${path.slice(0, path.lastIndexOf('/'))}/${d.file}`);
    const fileOk = !!file && sha256(file).toString('hex') === d.sha256;
    const seal = documentSeal(d);
    const problem = !file
      ? 'its file is missing'
      : !fileOk
        ? 'its file does not match the SHA-256 it was sealed with: the file was changed'
        : seal !== d.seal
          ? 'its metadata does not match its seal: it was changed'
          : pins.find(x => x.seal !== d.seal)
            ? `its seal is not the one land record version ${pins.find(x => x.seal !== d.seal).by} pins: it was replaced`
            : pins.find(x => x.docType && x.docType !== d.docType)
              ? 'its type is not the one the land record pins'
              : null;
    check(
      name,
      !problem,
      problem ??
        `file and metadata match seal ${d.seal.slice(0, 16)}…, as pinned in version ${pins.map(x => x.by).join(', ')}`,
    );
    items.push({
      key: `d${k}`,
      what: name,
      proof: `proofs/${proofName(d.edrmsNo)}-v${d.versionNumber}.json`,
      seal: d.seal,
      pinnedBy: pins.map(x => `v${x.by}`),
      documentId: d.documentId,
      version: d.versionNumber,
      sha256: d.sha256,
      time: d.createdAt,
    });
  }
  const unpinned = [...docs.keys()]
    .filter(k => !pinned.has(k))
    .map(k => docs.get(k).path);
  check(
    'documents',
    !unpinned.length,
    unpinned.length
      ? `not pinned in any version: ${unpinned.join(', ')}`
      : `${pinned.size} pinned document versions`,
  );

  // 3. the trail, and sign-offs and findings as recorded in it (both ways)
  const entries = Array.isArray(read('trail/entries.json'))
    ? read('trail/entries.json')
    : [];
  const broken = entries
    .filter(
      e =>
        contentHash(e) !== e.contentHash ||
        chainHash(e.prevHash, e.contentHash) !== e.hash,
    )
    .map(e => e.seq);
  check(
    'trail entries',
    files.has('trail/entries.json') && !broken.length,
    broken.length
      ? `entries ${broken.join(', ')} do not match their hashes: changed`
      : `${entries.length} entries match their hashes`,
  );
  for (const e of entries) {
    items.push({
      key: `t${e.seq}`,
      what: `trail entry ${e.seq}`,
      proof: `proofs/trail-${e.seq}.json`,
      entry: e,
    });
  }
  // each version against its commit entry, each document version against its filing or correction entry:
  // they carry the seals, so an anchored entry also proves the item (and a forged item cannot match it)
  const commits = entries.filter(
    e =>
      e.type === 'records.record.committed' &&
      same(e.data?.recordId, record?.id),
  );
  for (const it of items.filter(i => i.version)) {
    const v = it.version;
    const e = commits.find(c => c.data.versionNumber === v.versionNumber);
    if (!e) continue;
    // bound: proven with the entry; its time (the event's clock, like the other entries) is the one compared below
    if (
      check(
        it.what,
        e.data.seal === v.seal && same(e.data.previousSeal, v.previousSeal),
        `its seal is not the one in its commit entry (trail entry ${e.seq})`,
      )
    ) {
      checks.pop();
      it.boundTo = `t${e.seq}`;
      it.time = e.time;
    }
  }
  const notInPack = commits
    .filter(c => !versions.some(v => v.versionNumber === c.data.versionNumber))
    .map(c => c.data.versionNumber);
  check(
    'versions in the trail',
    !notInPack.length,
    notInPack.length
      ? `committed in the trail but missing from the pack: version ${notInPack.join(', ')}`
      : `${commits.length} commits in the trail, all in the pack`,
  );
  for (const it of items.filter(i => i.documentId)) {
    const e = entries.find(
      x =>
        same(x.data?.documentId, it.documentId) &&
        ((x.type === 'edrms.document.filed' && it.version === 1) ||
          (x.type === 'edrms.document.amended' &&
            x.data.version === it.version)),
    );
    if (!e) continue;
    if (
      check(
        it.what,
        e.data.seal === it.seal && same(e.data.sha256, it.sha256),
        `its seal is not the one in its ${e.type === 'edrms.document.filed' ? 'filing' : 'correction'} entry (trail entry ${e.seq})`,
      )
    ) {
      checks.pop();
      it.boundTo = `t${e.seq}`;
      it.time = e.time;
    }
  }
  const byType = (type, idKey) =>
    new Map(
      entries.filter(e => e.type === type).map(e => [e.data?.[idKey], e]),
    );
  const itemMatches = (row, e) =>
    same(row.recordId, e.data.recordId) &&
    same(row.recordNo, e.data.recordNo) &&
    same(row.recordVersion, e.data.versionNumber) &&
    same(row.documentId, e.data.edrmsDocumentId) &&
    same(row.edrmsNo, e.data.edrmsNo) &&
    same(row.documentVersion, e.data.documentVersion) &&
    same(row.seal, e.data.seal);
  const signoffs = read('signoffs.json') || [];
  const findings = read('findings.json') || [];
  const signed = byType('audit.signoff.recorded', 'signoffId');
  // an audit checkpoint (API-680) also names its range and the findings in it
  const sameIds = (a, b) =>
    JSON.stringify([...(a || [])].sort()) ===
    JSON.stringify([...(b || [])].sort());
  const checkpointMatches = (s, e) =>
    s.kind !== 'checkpoint' ||
    (e.data.kind === 'checkpoint' &&
      same(s.fromVersion, e.data.fromVersion) &&
      same(s.toVersion, e.data.toVersion) &&
      sameIds(s.items?.findings, e.data.findings));
  const badSignoffs = signoffs.filter(s => {
    const e = signed.get(s.id);
    return (
      !e ||
      !itemMatches(s, e) ||
      !checkpointMatches(s, e) ||
      !same(e.data.comment, s.comment) ||
      !same(e.actor?.id, s.signedById) ||
      !same(e.actor?.name, s.signedByName)
    );
  });
  const missingSignoffs = [...signed.keys()].filter(
    id => !signoffs.some(s => s.id === id),
  );
  check(
    'sign-offs',
    !badSignoffs.length && !missingSignoffs.length,
    badSignoffs.length
      ? `${badSignoffs.length} do not match their trail entries`
      : missingSignoffs.length
        ? `${missingSignoffs.length} in the trail are missing from signoffs.json`
        : `${signoffs.length} match their trail entries`,
  );
  const raised = byType('audit.finding.raised', 'findingId');
  const closed = byType('audit.finding.closed', 'findingId');
  const answeredIn = id =>
    entries.filter(
      e => e.type === 'audit.finding.answered' && e.data?.findingId === id,
    );
  const badFindings = findings.filter(f => {
    const r = raised.get(f.id);
    const c = closed.get(f.id);
    if (
      !r ||
      !itemMatches(f, r) ||
      r.data.description !== f.description ||
      !same(r.actor?.id, f.raisedById) ||
      !same(r.actor?.name, f.raisedByName) ||
      !same(r.data.instanceId, f.instanceId)
    ) {
      return true;
    }
    // every answer (API-680), in order, against its trail entry
    const answers = f.answers || [];
    const answered = answeredIn(f.id);
    if (
      answers.length !== answered.length ||
      answers.some(
        (a, i) =>
          a.text !== answered[i].data.answer ||
          !same(a.byId, answered[i].actor?.id) ||
          !same(a.byName, answered[i].actor?.name),
      )
    ) {
      return true;
    }
    if (f.status === 'open') return !!c;
    // closed by an auditor: outcome agreed or mistake (API-680), or "closed" before it
    const outcome = f.status === 'closed' ? (f.outcome ?? 'closed') : f.status;
    if (!c || c.data.outcome !== outcome) return true;
    return f.status === 'closed'
      ? !same(c.data.reason, f.closeReason) ||
          !same(c.actor?.id, f.closedById) ||
          !same(c.actor?.name, f.closedByName)
      : !same(c.data.resolvedByVersion, f.resolvedByVersion);
  });
  const missingFindings = [...raised.keys()].filter(
    id => !findings.some(f => f.id === id),
  );
  check(
    'findings',
    !badFindings.length && !missingFindings.length,
    badFindings.length
      ? `${badFindings.length} do not match their trail entries`
      : missingFindings.length
        ? `${missingFindings.length} in the trail are missing from findings.json`
        : `${findings.length} match their trail entries`,
  );

  // 4. proofs: one for every item, proving that item; checked on chain
  const expected = new Set(items.map(i => i.proof));
  const strayProofs = [...files.keys()].filter(
    p => p.startsWith('proofs/') && !expected.has(p),
  );
  check(
    'proof files',
    !strayProofs.length && items.every(i => files.has(i.proof)),
    strayProofs.length
      ? `proofs of nothing in the pack: ${strayProofs.join(', ')}`
      : items.some(i => !files.has(i.proof))
        ? `missing: ${items
            .filter(i => !files.has(i.proof))
            .map(i => i.proof)
            .join(', ')}`
        : `one for each of the ${items.length} items`,
  );
  const cache = new Map();
  const anchoredTrail = [];
  for (const it of items) {
    const proof = read(it.proof);
    if (!proof) continue; // missing: reported above
    const ofItem = it.entry
      ? !!proof.trail?.entry &&
        canonicalJson(proof.trail.entry) === canonicalJson(it.entry)
      : proof.item?.seal === it.seal;
    if (
      !check(
        it.proof,
        ofItem,
        ofItem
          ? 'proves the item in the pack'
          : 'proves another item than the one in the pack',
      )
    ) {
      continue;
    }
    checks.pop(); // only failures are listed per proof
    if (!['anchored', 'confirmed'].includes(proof.status)) continue;
    const r = await verifyProof(proof, {
      source,
      key,
      address,
      fetchImpl,
      cache,
    });
    const failed = r.checks.filter(c => !c.ok);
    // sent but not yet confirmed at export: a transaction still on its way is not proven yet, not a failure
    if (
      proof.status === 'anchored' &&
      failed.length === 1 &&
      failed[0].name === 'transaction on chain'
    ) {
      continue;
    }
    if (failed.length) {
      check(
        it.proof,
        false,
        failed.map(c => `${c.name}: ${c.detail}`).join('; '),
      );
      continue;
    }
    it.anchored = true;
    if (it.entry) {
      anchoredTrail.push({
        seq: it.entry.seq,
        entry: proof.trail.entry,
        later: proof.trail.later,
        checkpoint: proof.trail.checkpoint.seq,
      });
    }
  }
  // what anchored items pin: later trail entries up to a checkpoint (and the entry before), the versions
  // and documents those entries commit or file, earlier versions (previous seals), their documents
  const covered = new Set(items.filter(i => i.anchored).map(i => i.key));
  for (const it of items.filter(x => x.entry && !x.anchored)) {
    const e = it.entry;
    for (const t of anchoredTrail) {
      if (e.seq > t.seq && e.seq <= t.checkpoint) {
        if (t.later[e.seq - t.seq - 1] === e.contentHash) covered.add(it.key);
        else {
          check(
            it.what,
            false,
            `does not match the anchored chain of trail entry ${t.seq} (its proof's later entries): changed or forged`,
          );
        }
      }
      if (t.seq === e.seq + 1 && t.entry.prevHash !== e.hash) {
        check(
          it.what,
          false,
          `is not the entry before anchored trail entry ${t.seq}: changed or forged`,
        );
      } else if (t.seq === e.seq + 1) covered.add(it.key);
    }
  }
  for (const it of items) {
    if (it.boundTo && covered.has(it.boundTo)) covered.add(it.key);
  }
  for (let i = versions.length - 1; i >= 1; i--) {
    if (covered.has(`v${versions[i].versionNumber}`)) {
      covered.add(`v${versions[i - 1].versionNumber}`);
    }
  }
  for (const it of items) {
    if (it.pinnedBy?.some(v => covered.has(v))) covered.add(it.key);
  }
  // "not yet anchored" must be true: a version or document version older than trail entries the pack
  // shows anchored would be in that anchoring (its seal went into the tree when it was committed or
  // filed). Without a proof it was changed, or the audit tree misses it (before the audit service, not
  // backfilled).
  const anchoredUntil = Math.max(
    ...anchoredTrail.map(t => Date.parse(t.entry.time)).filter(Number.isFinite),
    -Infinity,
  );
  for (const it of items.filter(i => i.time && !covered.has(i.key))) {
    if (!it.boundTo) {
      check(
        it.what,
        false,
        "it is not proven on chain and its commit or filing is not in the pack's trail: it was changed, the audit tree misses it (run the backfill), or the pack was exported in the moment before its commit was recorded (export again)",
      );
    } else if (Date.parse(it.time) + STALE_MS < anchoredUntil) {
      check(
        it.what,
        false,
        `it is older than trail entries anchored up to ${new Date(anchoredUntil).toISOString()}, so it should be in that anchoring, but it has no proof: it was changed, or the audit tree misses it (run the backfill)`,
      );
    }
  }
  const unproven = items.filter(i => !covered.has(i.key)).map(i => i.what);
  check(
    'proofs on chain',
    true,
    `${items.filter(i => i.anchored).length} proofs checked against the chain; ${covered.size} of ${items.length} items proven${unproven.length ? `, ${unproven.length} not yet anchored` : ''}`,
  );

  const wallet = manifest.anchoring?.wallet;
  if (address === undefined && wallet) {
    notes.push(
      `Compare the anchoring wallet ${wallet} with the address the portal publishes, or pass it with --address.`,
    );
  }
  if (unproven.length) {
    notes.push(
      `Not proven on chain: ${unproven.join(', ')}. They may be newer than the last anchoring, or changed since the export: an offline check cannot tell. Export the pack again after the next anchoring, or check them with the portal.`,
    );
  }
  notes.push(
    "Not covered by any seal, shown as exported: README.txt, manifest.json's exportedBy, exportedAt and anchoring, record.json beyond its id and current version, document titles, the times of sign-offs and findings.",
  );
  notes.push(
    `An offline check cannot show that nothing was left out: the newest version, or a trail entry, removed together with its proof (a version in between breaks the chain of seals and is caught). The portal can: it recorded this export with the SHA-256 of its manifest (${sha256(files.get('manifest.json')).toString('hex')}) in its trail (audit.evidence.exported), anchored with the next root.`,
  );
  return {valid: checks.every(c => c.ok), checks, unproven, notes};
}

// ------------------------------------------------------------------ ownership extracts (API-694)

/** The name of the proof attached inside an ownership extract's PDF: record-v<n>.proof.json. */
const EXTRACT_PROOF_NAME = /^record-v(\d+)\.proof\.json$/;
/** The most all attached files together may inflate to: a proof is a few kilobytes. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The most nodes of the attachments' name tree read: an extract has one. */
const MAX_NAME_TREE_NODES = 1000;
const PDF_DELIMITERS = '()<>[]{}/% \t\r\n\f\0';

/**
 * A small reader of the PDF objects an extract is made of (PDF 32000-1, section 7.3): numbers,
 * names (as '/Name'), strings (as Buffers), arrays, dictionaries (plain objects keyed without the
 * slash) and references ({ref: n}). Returns { value, end }.
 */
function pdfValue(text, start) {
  let at = skipPdfSpace(text, start);
  if (text.startsWith('<<', at)) {
    const dict = {};
    at = skipPdfSpace(text, at + 2);
    while (!text.startsWith('>>', at)) {
      if (at >= text.length) throw new Error('unterminated dictionary');
      const key = pdfValue(text, at);
      if (typeof key.value !== 'string' || !key.value.startsWith('/')) {
        throw new Error(`a dictionary key is not a name at byte ${at}`);
      }
      const entry = pdfValue(text, key.end);
      dict[key.value.slice(1)] = entry.value;
      at = skipPdfSpace(text, entry.end);
    }
    return {value: dict, end: at + 2};
  }
  const first = text[at];
  if (first === '[') {
    const list = [];
    at = skipPdfSpace(text, at + 1);
    while (text[at] !== ']') {
      if (at >= text.length) throw new Error('unterminated array');
      const item = pdfValue(text, at);
      list.push(item.value);
      at = skipPdfSpace(text, item.end);
    }
    return {value: list, end: at + 1};
  }
  if (first === '/') {
    let end = at + 1;
    while (end < text.length && !PDF_DELIMITERS.includes(text[end])) end++;
    return {value: text.slice(at, end), end};
  }
  if (first === '(') return literalString(text, at);
  if (first === '<') {
    const end = text.indexOf('>', at);
    if (end < 0) throw new Error('unterminated hex string');
    let hex = text.slice(at + 1, end).replace(/\s+/g, '');
    if (hex.length % 2) hex += '0';
    return {value: Buffer.from(hex, 'hex'), end: end + 1};
  }
  const ref = /^(\d+)\s+(\d+)\s+R(?![^()<>[\]{}/%\s])/.exec(
    text.slice(at, at + 32),
  );
  if (ref) return {value: {ref: Number(ref[1])}, end: at + ref[0].length};
  const word = /^[^()<>[\]{}/%\s]+/.exec(text.slice(at, at + 64));
  if (!word) throw new Error(`unexpected "${first}" at byte ${at}`);
  const keywords = {true: true, false: false, null: null};
  const value =
    word[0] in keywords ? keywords[word[0]] : Number.parseFloat(word[0]);
  return {value, end: at + word[0].length};
}

/** White space and comments skipped. */
function skipPdfSpace(text, start) {
  let at = start;
  while (at < text.length) {
    if (' \t\r\n\f\0'.includes(text[at])) at++;
    else if (text[at] === '%') {
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++;
    } else break;
  }
  return at;
}

/** A literal string (…), with its escapes and balanced parentheses, as a Buffer. */
function literalString(text, start) {
  const ESCAPES = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f'};
  let out = '';
  let depth = 0;
  let at = start;
  while (at < text.length) {
    const c = text[at++];
    if (c === '\\') {
      const next = text[at++];
      if (next in ESCAPES) out += ESCAPES[next];
      else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(text.slice(at - 1, at + 2))[0];
        out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
        at += octal.length - 1;
      } else if (next === '\r') {
        if (text[at] === '\n') at++;
      } else if (next !== '\n') out += next;
    } else if (c === '(') {
      if (depth++ > 0) out += c;
    } else if (c === ')') {
      if (--depth === 0) return {value: Buffer.from(out, 'latin1'), end: at};
      out += c;
    } else out += c;
  }
  throw new Error('unterminated string');
}

/** A PDF text string (UTF-16 with its byte order mark, or PDFDocEncoding read as Latin-1). */
function pdfText(value) {
  if (!Buffer.isBuffer(value)) return null;
  if (value[0] === 0xfe && value[1] === 0xff) {
    return Buffer.from(value.subarray(2)).swap16().toString('utf16le');
  }
  return value.toString('latin1');
}

/**
 * The objects of a PDF by number, from its cross-reference tables (newest first, following /Prev),
 * and its trailer. A PDF saved with a cross-reference stream (by another program) is not read: an
 * extract as the registry issued it has a table.
 */
function pdfObjects(pdf) {
  const text = pdf.toString('latin1');
  const startxref = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1);
  if (!startxref) throw new Error('not a PDF (no cross-reference table)');
  const offsets = new Map();
  let trailer = null;
  const seen = new Set();
  let at = Number(startxref[1]);
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    if (!text.startsWith('xref', at)) {
      throw new Error(
        'the PDF was saved again by another program (it has no cross-reference table): use the extract as the registry issued it',
      );
    }
    let cursor = at + 4;
    for (;;) {
      const section = /^\s*(\d+)\s+(\d+)\s*?[\r\n]+/.exec(
        text.slice(cursor, cursor + 64),
      );
      if (!section) break;
      cursor += section[0].length;
      const first = Number(section[1]);
      for (let i = 0; i < Number(section[2]); i++) {
        const line = /^(\d{10}) (\d{5}) ([nf])/.exec(
          text.slice(cursor, cursor + 20),
        );
        if (!line) throw new Error('damaged cross-reference table');
        if (line[3] === 'n' && !offsets.has(first + i)) {
          offsets.set(first + i, Number(line[1]));
        }
        cursor += 20;
      }
    }
    cursor = skipPdfSpace(text, cursor);
    if (!text.startsWith('trailer', cursor)) {
      throw new Error('damaged cross-reference table (no trailer)');
    }
    const dict = pdfValue(text, cursor + 7).value;
    trailer ??= dict;
    at = dict.Prev;
  }
  return {text, offsets, trailer};
}

/**
 * The objects of a PDF, read on demand: `read(n)` gives { value, stream? } of object n, `deref(v)`
 * the value a reference points to (or v itself); and the trailer.
 */
function pdfReader(pdf) {
  const {text, offsets, trailer} = pdfObjects(pdf);
  const read = number => {
    const at = offsets.get(number);
    if (at === undefined) throw new Error(`object ${number} is missing`);
    const head = /^(\d+)\s+(\d+)\s+obj/.exec(text.slice(at, at + 32));
    if (!head || Number(head[1]) !== number) {
      throw new Error(`object ${number} is not where the table says`);
    }
    const {value, end} = pdfValue(text, at + head[0].length);
    const keyword = /^\s*stream(\r\n|\n)/.exec(text.slice(end, end + 16));
    if (!keyword) return {value};
    const length = deref(value.Length);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`object ${number}: stream without a length`);
    }
    const start = end + keyword[0].length;
    return {value, stream: pdf.subarray(start, start + length)};
  };
  const deref = value =>
    value && typeof value === 'object' && 'ref' in value
      ? read(value.ref).value
      : value;
  return {trailer, read, deref};
}

/** The same file name attached twice: which one is the extract's cannot be told. */
export class DuplicateAttachment extends Error {}

/**
 * The files attached inside a PDF (its /EmbeddedFiles name tree), by name, as Buffers. Streams are
 * read as stored or inflated (FlateDecode); nothing else is needed for an extract.
 */
export function pdfAttachments(bytes) {
  const pdf = Buffer.from(bytes);
  const {trailer, read, deref} = pdfReader(pdf);
  // all attachments together within MAX_ATTACHMENT_BYTES: a small PDF cannot unpack into gigabytes
  let budget = MAX_ATTACHMENT_BYTES;
  const decoded = ref => {
    const {value, stream} = read(ref?.ref);
    if (!stream) throw new Error('an attachment is not a stream');
    const filters = [deref(value.Filter) ?? []].flat();
    let file;
    if (filters.length === 0) file = Buffer.from(stream);
    else if (
      filters.length === 1 &&
      filters[0] === '/FlateDecode' &&
      value.DecodeParms === undefined
    ) {
      try {
        file = inflateSync(stream, {maxOutputLength: Math.max(budget, 1)});
      } catch (err) {
        if (err.code !== 'ERR_BUFFER_TOO_LARGE') throw err;
        file = null;
      }
    } else {
      throw new Error(`an attachment is stored as ${filters.join(' ')}`);
    }
    if (!file || file.length > budget) {
      throw new Error('the attached files are larger than any extract holds');
    }
    budget -= file.length;
    return file;
  };
  const files = new Map();
  // each node of the tree once: a /Kids that points back up would otherwise never end
  const visited = new Set();
  const walk = (entry, depth) => {
    if (entry && typeof entry === 'object' && 'ref' in entry) {
      if (visited.has(entry.ref)) return;
      visited.add(entry.ref);
    }
    if (visited.size > MAX_NAME_TREE_NODES) {
      throw new Error('the list of attached files is too large');
    }
    const node = deref(entry);
    if (!node || typeof node !== 'object' || depth > 16) return;
    const names = deref(node.Names) ?? [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      const spec = deref(names[i + 1]);
      const name = pdfText(deref(names[i])) ?? pdfText(spec?.UF);
      const embedded = deref(spec?.EF);
      if (!name || !embedded) continue;
      if (files.has(name)) {
        throw new DuplicateAttachment(`${name} is attached twice`);
      }
      files.set(name, decoded(embedded.F ?? embedded.UF));
    }
    for (const kid of deref(node.Kids) ?? []) walk(kid, depth + 1);
  };
  const catalog = deref(trailer.Root);
  walk(deref(catalog?.Names)?.EmbeddedFiles, 0);
  return files;
}

// a minimal DER reader, enough for the seal's CMS SignedData (RFC 5652)

/** The element at `at`: { tag, start (of its header), body (of its content), end }. */
function derAt(bytes, at) {
  const tag = bytes[at];
  let length = bytes[at + 1];
  let body = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[body + i];
    body += count;
  }
  if (tag === undefined || body + length > bytes.length) {
    throw new Error('damaged DER');
  }
  return {tag, start: at, body, end: body + length};
}
/** The elements inside a constructed element. */
function derChildren(bytes, element) {
  const out = [];
  for (let at = element.body; at < element.end;) {
    const child = derAt(bytes, at);
    out.push(child);
    at = child.end;
  }
  return out;
}
/** An object identifier in dotted form. */
function derOid(bytes, element) {
  const body = bytes.subarray(element.body, element.end);
  const parts = [Math.floor(body[0] / 40), body[0] % 40];
  let value = 0;
  for (const byte of body.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}
const derBody = (bytes, element) => bytes.subarray(element.body, element.end);
const derWhole = (bytes, element) => bytes.subarray(element.start, element.end);

const SEAL_OID = {
  signedData: '1.2.840.113549.1.7.2',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
};
const DIGESTS = {
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
// ECDSA and RSA (PKCS #1 v1.5): what the registry's seal uses (extracts service, src/seal/cms.js)
const SIGNATURE_ALGORITHMS = new Set([
  '1.2.840.10045.4.3.2',
  '1.2.840.10045.4.3.3',
  '1.2.840.10045.4.3.4',
  '1.2.840.113549.1.1.1',
  '1.2.840.113549.1.1.11',
  '1.2.840.113549.1.1.12',
  '1.2.840.113549.1.1.13',
]);

/**
 * The signature dictionaries of the PDF's signature fields, reached as a PDF reader reaches them:
 * the catalog's /AcroForm, its /Fields (and their /Kids), each field's value /V with a /ByteRange.
 */
function signatureDictionaries(pdf) {
  const {trailer, deref} = pdfReader(pdf);
  const form = deref(deref(trailer.Root)?.AcroForm);
  const found = [];
  const visited = new Set();
  const walk = (entry, depth) => {
    if (entry && typeof entry === 'object' && 'ref' in entry) {
      if (visited.has(entry.ref)) return;
      visited.add(entry.ref);
    }
    if (visited.size > MAX_NAME_TREE_NODES || depth > 16) {
      throw new Error('the form is too large');
    }
    const field = deref(entry);
    if (!field || typeof field !== 'object' || Array.isArray(field)) return;
    const value = deref(field.V);
    if (value && typeof value === 'object' && 'ByteRange' in value) {
      found.push({...value, ByteRange: deref(value.ByteRange)});
    }
    for (const kid of deref(field.Kids) ?? []) walk(kid, depth + 1);
  };
  for (const field of deref(form?.Fields) ?? []) walk(field, 0);
  return found;
}

/** A certificate fingerprint as typed or copied: hex, with or without colons or spaces, any case. */
const fingerprintOf = text =>
  String(text ?? '')
    .replace(/[\s:]/g, '')
    .toLowerCase();

/**
 * The PDF's organisation seal checked as a PDF reader checks it: the signature's /ByteRange covers
 * the whole file but the signature itself, the digest of those bytes is the one signed, and the
 * signature over the signed attributes holds with the public key of the certificate in it (and
 * that certificate is the one the signature names). The certificate is not checked against an
 * authority but pinned: with `fingerprint`, the SHA-256 of the registry's seal certificate (DER)
 * as the registry publishes it (GET /api/public/extracts/seal), the certificate must be that one;
 * a certificate made by anyone else, with the same name or not, fails.
 * Returns { status: 'valid' | 'invalid' | 'none' | 'unchecked', detail, subject, sha256 }; only
 * 'valid' vouches for the PDF ('unchecked': made in a way this checker cannot verify).
 */
export function checkPdfSeal(bytes, {fingerprint} = {}) {
  const pdf = Buffer.from(bytes);
  const notSealed = detail => ({
    status: 'invalid',
    detail,
    subject: null,
    sha256: null,
  });
  let signatures;
  try {
    signatures = signatureDictionaries(pdf);
  } catch (err) {
    return notSealed(`the seal cannot be read: ${err.message}`);
  }
  // every /ByteRange written in the file: a second one, in or out of the form, is not the registry's
  const written =
    pdf.toString('latin1').match(/\/ByteRange\s*\[/g)?.length ?? 0;
  if (signatures.length === 0 && written === 0) {
    return {
      status: 'none',
      detail:
        'the PDF has no seal: it is not an extract as the registry issued it',
      subject: null,
      sha256: null,
    };
  }
  if (signatures.length !== 1 || written !== 1) {
    return notSealed(
      'the PDF has more than one seal, or a seal outside its signature field: it is not an extract as the registry issued it',
    );
  }
  const range = signatures[0].ByteRange;
  if (range.length !== 4 || !range.every(n => Number.isSafeInteger(n))) {
    return notSealed('the seal cannot be read: its byte range is damaged');
  }
  const [start, length, after, rest] = range;
  if (start !== 0 || after < length || after + rest !== pdf.length) {
    return notSealed(
      'the seal does not cover the whole file: the PDF was changed after it was sealed',
    );
  }
  // what the seal does not cover must be the signature and nothing else: one hex string, as a PDF
  // reader requires; anything hidden beside it would be outside the seal
  const gap = pdf.subarray(length, after).toString('latin1');
  if (!/^<(?:[0-9A-Fa-f]{2})*>$/.test(gap)) {
    return notSealed(
      'the space left for the seal holds more than the seal: the PDF was changed after it was sealed',
    );
  }
  let subject = null;
  let sha256 = null;
  try {
    const cms = Buffer.from(gap.slice(1, -1), 'hex');
    const contentInfo = derChildren(cms, derAt(cms, 0));
    if (derOid(cms, contentInfo[0]) !== SEAL_OID.signedData) {
      throw new Error('the signature is not a CMS SignedData');
    }
    const signedData = derChildren(cms, derChildren(cms, contentInfo[1])[0]);
    const certificates = signedData.find(e => e.tag === 0xa0);
    const signerInfo = derChildren(cms, signedData.at(-1))[0];
    const signerParts = derChildren(cms, signerInfo);
    const sid = signerParts[1];
    const digestName =
      DIGESTS[derOid(cms, derChildren(cms, signerParts[2])[0])];
    const signedAttrs = signerParts.find(e => e.tag === 0xa0);
    const signatureAlgorithm = derOid(
      cms,
      derChildren(
        cms,
        signerParts.find((e, i) => i > 2 && e.tag === 0x30),
      )[0],
    );
    const signature = derBody(
      cms,
      signerParts.find(e => e.tag === 0x04),
    );
    const certificateList = certificates
      ? derChildren(cms, certificates).map(c => derWhole(cms, c))
      : [];
    const serialOf = hexText => hexText.toUpperCase().replace(/^0+/, '');
    const sidSerial =
      sid.tag === 0x30
        ? serialOf(derBody(cms, derChildren(cms, sid)[1]).toString('hex'))
        : null;
    const certificateDer =
      certificateList.find(
        der =>
          sidSerial !== null &&
          serialOf(new X509Certificate(der).serialNumber) === sidSerial,
      ) ?? (certificateList.length === 1 ? certificateList[0] : null);
    if (!certificateDer) {
      throw new Error('the signature does not hold its certificate');
    }
    const certificate = new X509Certificate(certificateDer);
    // one line, without the escapes Node puts before commas inside a value
    subject = certificate.subject
      .split('\n')
      .map(part => part.replace(/\\(.)/g, '$1'))
      .join(', ');
    sha256 = createHash('sha256').update(certificateDer).digest('hex');
    if (
      !digestName ||
      !signedAttrs ||
      !SIGNATURE_ALGORITHMS.has(signatureAlgorithm)
    ) {
      return {
        status: 'unchecked',
        detail: `the seal is made in a way this checker cannot verify (${signedAttrs ? `algorithm ${signatureAlgorithm}` : 'no signed attributes'}), so it does not vouch for the PDF`,
        subject,
        sha256,
      };
    }
    const attributes = new Map(
      derChildren(cms, signedAttrs).map(a => {
        const [type, values] = derChildren(cms, a);
        return [derOid(cms, type), derChildren(cms, values)[0]];
      }),
    );
    const content = Buffer.concat([
      pdf.subarray(0, length),
      pdf.subarray(after, after + rest),
    ]);
    const messageDigest = attributes.get(SEAL_OID.messageDigest);
    const digestMatches =
      !!messageDigest &&
      derBody(cms, messageDigest).equals(
        createHash(digestName).update(content).digest(),
      );
    // the signing-certificate-v2 attribute names the certificate by its hash, so it cannot be swapped
    const signingCertificate = attributes.get(SEAL_OID.signingCertificateV2);
    let certificateNamed = true;
    if (signingCertificate) {
      const essCertId = derChildren(
        cms,
        derChildren(cms, derChildren(cms, signingCertificate)[0])[0],
      );
      const algorithm =
        essCertId[0].tag === 0x30
          ? DIGESTS[derOid(cms, derChildren(cms, essCertId[0])[0])]
          : 'sha256';
      const hash = essCertId.find(e => e.tag === 0x04);
      certificateNamed =
        !!algorithm &&
        !!hash &&
        derBody(cms, hash).equals(
          createHash(algorithm).update(certificateDer).digest(),
        );
    }
    const signedBytes = Buffer.from(derWhole(cms, signedAttrs));
    signedBytes[0] = 0x31; // signed as a SET OF, not with its [0] tag
    const signatureHolds = cryptoVerify(
      digestName,
      signedBytes,
      {key: certificate.publicKey, dsaEncoding: 'der'},
      signature,
    );
    if (!digestMatches) {
      return {
        status: 'invalid',
        detail:
          'the seal does not match the file: the PDF was changed after it was sealed',
        subject,
        sha256,
      };
    }
    if (!signatureHolds || !certificateNamed) {
      return {
        status: 'invalid',
        detail:
          'the seal’s signature does not hold: it was not made with the key of its certificate',
        subject,
        sha256,
      };
    }
    if (fingerprint !== undefined && fingerprintOf(fingerprint) !== sha256) {
      return {
        status: 'invalid',
        detail: `the seal was not made with the registry's certificate: its certificate (${subject}) has the fingerprint ${sha256}, not the registry's ${fingerprintOf(fingerprint)}`,
        subject,
        sha256,
      };
    }
    return {
      status: 'valid',
      detail: `sealed with the registry's certificate (${subject}, fingerprint ${sha256.slice(0, 16)}…); the whole file is as sealed`,
      subject,
      sha256,
    };
  } catch (err) {
    return {
      status: 'invalid',
      detail: `the seal cannot be read: ${err.message}`,
      subject,
      sha256,
    };
  }
}

/**
 * A check of verifyProof's as an extract's reader reads it: "blockchain", no network or source
 * names, the registry's address rather than the anchoring wallet.
 */
function extractCheck(c, {proof, anchoring}) {
  const tx = proof.anchor?.tx;
  switch (c.name) {
    case 'item':
      return {
        name: 'fingerprint',
        ok: c.ok,
        detail: c.ok
          ? `the version's fingerprint ${String(proof.item.seal).slice(0, 16)}…`
          : 'the proof’s fingerprint is not the one it proves',
      };
    case 'path to the root':
      return {
        name: 'in the batch',
        ok: c.ok,
        detail: c.ok
          ? `the fingerprint is inside the batch's combined fingerprint (${proof.tree.size} items)`
          : "the fingerprint is not inside the batch's combined fingerprint",
      };
    case 'transaction on chain':
      return {
        name: 'transaction on the blockchain',
        ok: c.ok,
        detail: c.ok
          ? `transaction ${tx}, block ${anchoring.blockHeight}, ${anchoring.confirmations ?? '?'} confirmations`
          : `transaction ${tx} is not on the blockchain`,
      };
    case 'root in the transaction':
      return {
        name: 'batch fingerprint in the transaction',
        ok: c.ok,
        detail: c.ok
          ? `the transaction carries the batch's combined fingerprint (label ${LABEL})`
          : `the transaction does not carry the batch's combined fingerprint (label ${LABEL})`,
      };
    case 'paid by the anchoring wallet':
      return {
        name: "sent from the registry's address",
        ok: c.ok,
        detail: c.detail,
      };
    default:
      return c;
  }
}

/**
 * Check an ownership extract's PDF (API-694): the proof attached inside it (record-v<n>.proof.json),
 * checked as a proof file is (verifyProof: the fingerprint's leaf, the path to the batch's combined
 * fingerprint, the transaction on the blockchain carrying it under label 8890, sent from `address`,
 * the registry's published address), its batch the one on the blockchain; and the registry's seal
 * over the PDF, made with the certificate whose SHA-256 is `seal` (published by the registry).
 * `address` and `seal` are required: without them nothing can be vouched for.
 * Returns { valid, checks, notes, seal, batch, date, dateFrom, versionNumber, anchoring }; throws
 * Unreachable when the blockchain cannot be read, and an Error when the file cannot be read as a PDF.
 */
export async function verifyExtract(
  bytes,
  {source = 'koios', key, address, seal, fetchImpl = globalThis.fetch} = {},
) {
  if (!address || !seal) {
    throw new TypeError(
      "An extract is checked against the registry's published address and seal fingerprint: both are needed",
    );
  }
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({name, ok: !!ok, detail});
    return !!ok;
  };
  const notes = [
    'An offline check cannot show whether a newer version of the land record exists, or whether the registry has revoked this extract. Use the public check page for that: scan the QR code on the extract.',
  ];
  const sealResult = checkPdfSeal(bytes, {fingerprint: seal});
  const unproven = {seal: sealResult, batch: null, date: null, dateFrom: null};
  let files;
  try {
    files = pdfAttachments(bytes);
  } catch (err) {
    if (!(err instanceof DuplicateAttachment)) throw err;
    check(
      'attached proof',
      false,
      `${err.message}: it is not an extract as the registry issued it`,
    );
    return {valid: false, checks, notes, ...unproven};
  }
  const attached = [...files.keys()].filter(n => EXTRACT_PROOF_NAME.test(n));
  if (attached.length !== 1) {
    check(
      'attached proof',
      false,
      attached.length === 0
        ? 'the PDF has no proof attached (record-v<n>.proof.json): it is not an ownership extract as the registry issued it, or the proof was removed'
        : `more than one proof is attached: ${attached.join(', ')}`,
    );
    return {valid: false, checks, notes, ...unproven};
  }
  const [name] = attached;
  const versionNumber = Number(EXTRACT_PROOF_NAME.exec(name)[1]);
  let proof;
  try {
    proof = JSON.parse(files.get(name).toString('utf8'));
  } catch {
    proof = undefined;
  }
  const item = proof?.item;
  if (
    !check(
      'attached proof',
      item?.kind === 'record-version' && item.version === versionNumber,
      !proof
        ? `${name} cannot be read`
        : item?.kind !== 'record-version'
          ? `${name} is not the proof of a land record version`
          : item.version !== versionNumber
            ? `${name} is the proof of version ${item.version}`
            : `${name}: land record ${item.recordId}, version ${versionNumber}`,
    )
  ) {
    return {valid: false, checks, notes, ...unproven};
  }
  const result = await verifyProof(proof, {source, key, address, fetchImpl});
  checks.push(
    ...result.checks.map(c =>
      extractCheck(c, {proof, anchoring: result.anchoring}),
    ),
  );
  const md = result.anchoring?.metadata;
  if (md) {
    check(
      'batch',
      Number(md.batch) === proof.anchor.batch,
      Number(md.batch) === proof.anchor.batch
        ? `batch ${md.batch}`
        : `the proof says batch ${proof.anchor.batch}, the blockchain batch ${md.batch}`,
    );
  }
  // the seal is its own check, apart from the blockchain's: only a verified seal of the registry's
  // certificate vouches for what the PDF shows
  check('registry seal', sealResult.status === 'valid', sealResult.detail);
  notes.push(
    "The fingerprint cannot be recomputed from the extract: the version's full data (with the owners' full ID numbers) is not in the PDF, on purpose. The registry's seal ties what the extract shows to its attached proof.",
  );
  const blockTime = result.anchoring?.blockTime ?? null;
  return {
    valid: checks.every(c => c.ok),
    checks,
    notes,
    seal: sealResult,
    batch: md ? Number(md.batch) : null,
    date: blockTime ?? proof.anchor?.confirmedAt ?? null,
    dateFrom: blockTime ? 'blockchain' : 'proof',
    versionNumber,
    anchoring: result.anchoring,
  };
}

/** The verdict on an extract in plain words, for the command line. */
export function extractVerdict(result) {
  if (result.valid) {
    let date = '';
    if (result.date) {
      date = ` of ${result.date.slice(0, 10)}`;
      if (result.dateFrom !== 'blockchain') {
        date += ' (the date as the attached proof gives it)';
      }
    }
    return `VALID: version ${result.versionNumber} of the land record is on the blockchain, in batch ${result.batch}${date}, sent from the registry's address, and the PDF is as the registry sealed it.`;
  }
  const failed = result.checks.filter(c => !c.ok);
  const reason = failed.map(c => `${c.name}: ${c.detail}`).join('; ');
  const sealOnly = failed.length === 1 && failed[0].name === 'registry seal';
  return sealOnly
    ? `NOT VALID: ${reason}. The checks against the blockchain passed: the attached proof is genuine, but what the PDF shows is not vouched for by the registry.`
    : `NOT VALID: ${reason}.`;
}

// ------------------------------------------------------------------ command line

async function main(argv) {
  const args = argv.slice(2);
  const flag = name => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const source = flag('--source') || 'koios';
  const keyFile = flag('--key-file');
  const address = flag('--address');
  const seal = flag('--seal');
  const file = args[0];
  if (!file || file === '--help' || file === '-h') {
    process.stdout.write(
      'usage: node lrfe-verify.mjs <proof.json | evidence pack .zip or folder | extract .pdf> [--address <anchoring wallet>] [--seal <seal fingerprint>, for an extract] [--source koios|blockfrost] [--key-file <file>] [--json]\n',
    );
    return file ? 0 : 2;
  }
  const key =
    source === 'blockfrost'
      ? keyFile
        ? readFileSync(keyFile, 'utf8').trim()
        : process.env.BLOCKFROST_PROJECT_ID
      : undefined;
  let isPack = false;
  try {
    isPack = file.endsWith('.zip') || statSync(file).isDirectory();
  } catch {
    /* reported below */
  }
  if (isPack) return checkPack(file, {source, key, address, json});
  if (file.toLowerCase().endsWith('.pdf')) {
    return checkExtract(file, {source, key, address, seal, json});
  }
  let proof;
  try {
    proof = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`Cannot read the proof ${file}: ${err.message}\n`);
    return 2;
  }
  // a proof may be the verify call's answer, which holds the proof
  if (proof?.proof?.format) proof = proof.proof;
  let result;
  try {
    result = await verifyProof(proof, {source, key, address});
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    process.stderr.write(`Could not check against the chain: ${err.message}\n`);
    return 2;
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const c of result.checks) {
      process.stdout.write(
        `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}\n`,
      );
    }
    for (const n of result.notes || []) process.stdout.write(`note  ${n}\n`);
    process.stdout.write(
      result.valid
        ? '\nVALID: the item was in the tree whose root the anchoring wallet put on Cardano in that transaction.\n'
        : '\nNOT VALID.\n',
    );
  }
  return result.valid ? 0 : 1;
}

async function checkPack(path, {source, key, address, json}) {
  let files;
  try {
    files = readPack(path);
  } catch (err) {
    process.stderr.write(
      `Cannot read the evidence pack ${path}: ${err.message}\n`,
    );
    return 2;
  }
  let result;
  try {
    result = await verifyPack(files, {source, key, address});
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    process.stderr.write(`Could not check against the chain: ${err.message}\n`);
    return 2;
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const c of result.checks) {
      process.stdout.write(
        `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}\n`,
      );
    }
    for (const n of result.notes) process.stdout.write(`note  ${n}\n`);
    process.stdout.write(
      !result.valid
        ? '\nNOT VALID.\n'
        : result.unproven.length
          ? `\nVALID AS FAR AS ANCHORED: the pack is consistent and its anchored items are as exported; ${result.unproven.length} items are not proven on chain (see above): they may be newer than the last anchoring, or changed since the export.\n`
          : '\nVALID: the pack is consistent and as exported, and every version, document and trail entry in it existed unchanged when its root was put on Cardano.\n',
    );
  }
  return result.valid ? 0 : 1;
}

async function checkExtract(path, {source, key, address, seal, json}) {
  if (!address || !seal) {
    process.stderr.write(
      "usage: node lrfe-verify.mjs extract.pdf --address <the registry's address> --seal <the registry's seal fingerprint>\n" +
        "Both are published by the registry (its public page, or GET /api/public/extracts/seal for the seal's fingerprint): an extract is checked against them, never against what the PDF says of itself.\n",
    );
    return 2;
  }
  let result;
  try {
    result = await verifyExtract(readFileSync(path), {
      source,
      key,
      address,
      seal,
    });
  } catch (err) {
    if (err instanceof Unreachable) {
      process.stderr.write(
        `Could not check against the blockchain: ${err.message}\n`,
      );
    } else {
      process.stderr.write(`Cannot read the extract ${path}: ${err.message}\n`);
    }
    return 2;
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const c of result.checks) {
      process.stdout.write(
        `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}\n`,
      );
    }
    for (const n of result.notes) process.stdout.write(`note  ${n}\n`);
    process.stdout.write(`\n${extractVerdict(result)}\n`);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv).then(
    code => {
      process.exitCode = code;
    },
    err => {
      process.stderr.write(`${err.stack}\n`);
      process.exitCode = 2;
    },
  );
}
