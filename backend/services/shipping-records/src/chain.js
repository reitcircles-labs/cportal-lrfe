import {canonicalJson, sha256Hex, verifyJws} from '@lrfe/common';

/**
 * The chain of title (CB-32, docs/chain-of-title.md of the shipping pack): each command applied to
 * a B/L's title adds one entry, numbered from 1, holding the hash of the entry before and signed
 * by the platform. This module makes an entry's hash and checks a chain; it needs nothing but the
 * entries and the platform's public keys, so a chain can be checked anywhere, offline.
 */

/** The JWS type of a chain-of-title entry. */
export const TITLE_ENTRY_TYP = 'lrfe-title-entry';

/**
 * What an entry's hash and signature are over: the entry without its `entryHash` and `signature`.
 * @param {!Object} entry
 * @return {!Object}
 */
export function entryContent(entry) {
  const content = {...entry};
  delete content.entryHash;
  delete content.signature;
  return content;
}

/**
 * An entry's hash: SHA-256 of the canonical JSON of its content, lowercase hex.
 * @param {!Object} content the entry without `entryHash` and `signature`
 * @return {string}
 */
export function entryHashOf(content) {
  return sha256Hex(canonicalJson(content));
}

/**
 * The header of a compact JWS, or null when it has none that can be read.
 * @param {string} jws
 * @return {?Object}
 */
function headerOf(jws) {
  try {
    const header = JSON.parse(
      Buffer.from(jws.split('.')[0], 'base64url').toString('utf8'),
    );
    if (header !== null && typeof header === 'object') {
      return header;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether an entry's signature is the platform's over exactly its content, made with the key the
 * entry names.
 * @param {!Object} entry
 * @param {!Object} content
 * @param {{keys: !Array<!Object>}} jwks
 * @return {!Promise<boolean>}
 */
async function isSigned(entry, content, jwks) {
  if (typeof entry.signature !== 'string') {
    return false;
  }
  const header = headerOf(entry.signature);
  if (
    header === null ||
    header.typ !== TITLE_ENTRY_TYP ||
    header.kid !== entry.kid
  ) {
    return false;
  }
  try {
    const payload = await verifyJws(entry.signature, jwks);
    return canonicalJson(payload) === canonicalJson(content);
  } catch {
    return false;
  }
}

/**
 * Checks a B/L's chain of title, in the order given, entry by entry:
 *   linked  its seq is its place (1..n) and its previousHash is the entryHash of the entry before
 *           (for the first: `startPreviousHash`, null for a B/L of its own, the parent's last
 *           entryHash for a split child)
 *   intact  its entryHash is the hash of its content
 *   signed  its signature is the platform's JWS over its content, with the key of its kid
 * The chain is valid when it has entries and every one is linked, intact and signed. Never throws
 * on bad input: what cannot be read does not verify.
 * @param {!Array<!Object>} entries
 * @param {{keys: !Array<!Object>}} jwks the platform's public keys (GET /records/title/keys)
 * @param {{startPreviousHash?: ?string}} [options]
 * @return {!Promise<{valid: boolean, entries: !Array<{seq: *, linked: boolean, intact: boolean,
 *     signed: boolean}>}>}
 */
export async function verifyTitleChain(
  entries,
  jwks,
  {startPreviousHash = null} = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {valid: false, entries: []};
  }
  const results = [];
  let expectedPrevious = startPreviousHash;
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object') {
      results.push({seq: null, linked: false, intact: false, signed: false});
      expectedPrevious = undefined;
      continue;
    }
    const content = entryContent(entry);
    const linked =
      entry.seq === index + 1 && entry.previousHash === expectedPrevious;
    const intact = entry.entryHash === entryHashOf(content);
    const signed = await isSigned(entry, content, jwks);
    results.push({seq: entry.seq, linked, intact, signed});
    expectedPrevious = entry.entryHash;
  }
  const valid = results.every(r => r.linked && r.intact && r.signed);
  return {valid, entries: results};
}
