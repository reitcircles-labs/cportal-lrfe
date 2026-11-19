import {canonicalJson, verifyJws} from '@lrfe/common';
import {entryContent, entryHashOf} from './chain.js';

/** Reserved JavaScript property names refused as platform or party identifiers. */
export const RESERVED_KEYS = new Set([
  'toString',
  'valueOf',
  'constructor',
  '__proto__',
  'hasOwnProperty',
]);

/** UUID format check so invalid incoming envelopeIds fail 400 BENV instead of 500 in SQL. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies one chain entry's signature against each active keyset individually so identical
 * `kid` values across different platforms (e.g. `bl-title:v1`) never collide.
 *
 * @param {object} entry
 * @param {!Object} content
 * @param {!Array<{keys: !Array<object>}>} keySets
 * @return {!Promise<boolean>}
 */
async function verifyEntrySignature(entry, content, keySets) {
  if (typeof entry.signature !== 'string' || !entry.signature) {
    return false;
  }
  const canonicalContent = canonicalJson(content);
  for (const jwks of keySets) {
    if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0) {
      continue;
    }
    try {
      const payload = await verifyJws(entry.signature, jwks);
      if (canonicalJson(payload) === canonicalContent) {
        return true;
      }
    } catch {
      // try next active platform keyset
    }
  }
  return false;
}

/**
 * Verifies an incoming DCSA PINT envelope's chain of title across platforms (CB-55):
 * - Every entry `seq` is 1..N with unbroken `previousHash` links and intact `entryHash`.
 * - Every entry's JWS signature verifies against our own keys or an active registered platform's
 *   keys (checking each platform's JWKS independently to prevent `kid` collisions).
 * - If this platform already recorded earlier entries for this B/L, those entries must match our
 *   stored records byte-for-byte.
 *
 * @param {{
 *   entries: !Array<object>,
 *   storedEntries: !Array<object>,
 *   ownPlatformCode: string,
 *   ownJwks: {keys: !Array<object>},
 *   peerPlatformCode: string,
 *   peerJwks: {keys: !Array<object>},
 *   allPlatforms?: !Array<{code: string, status?: string, jwks: {keys: !Array<object>}}>,
 * }} options
 * @return {!Promise<{ok: boolean, code?: string, message?: string}>}
 */
export async function verifyIncomingChain({
  entries,
  storedEntries,
  ownPlatformCode,
  ownJwks,
  peerPlatformCode,
  peerJwks,
  allPlatforms = [],
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      code: 'BENV',
      message: 'Transfer envelope has no chain of title',
    };
  }
  const keySets = [ownJwks, peerJwks];
  const seenCodes = new Set([ownPlatformCode, peerPlatformCode]);
  for (const platform of allPlatforms) {
    if (
      platform?.code &&
      platform.status === 'Active' &&
      platform?.jwks &&
      !seenCodes.has(platform.code)
    ) {
      seenCodes.add(platform.code);
      keySets.push(platform.jwks);
    }
  }

  if (storedEntries.length > entries.length) {
    return {
      ok: false,
      code: 'BENV',
      message: 'Incoming chain is shorter than our stored history',
    };
  }
  for (const stored of storedEntries) {
    const incoming = entries[stored.seq - 1];
    if (!incoming || canonicalJson(incoming) !== canonicalJson(stored)) {
      return {
        ok: false,
        code: 'BSIG',
        message: 'Prior history entry does not match our recorded entry',
      };
    }
  }

  let expectedPrevious = null;
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') {
      return {ok: false, code: 'BENV', message: 'Malformed chain entry'};
    }
    if (entry.seq !== index + 1 || entry.previousHash !== expectedPrevious) {
      return {
        ok: false,
        code: 'BENV',
        message: `Chain link broken at entry ${index + 1}`,
      };
    }
    const content = entryContent(entry);
    if (entry.entryHash !== entryHashOf(content)) {
      return {
        ok: false,
        code: 'BSIG',
        message: `Entry hash mismatch at entry ${entry.seq}`,
      };
    }
    if (!(await verifyEntrySignature(entry, content, keySets))) {
      return {
        ok: false,
        code: 'BSIG',
        message: `Invalid signature at entry ${entry.seq}`,
      };
    }
    expectedPrevious = entry.entryHash;
  }

  return {ok: true};
}
