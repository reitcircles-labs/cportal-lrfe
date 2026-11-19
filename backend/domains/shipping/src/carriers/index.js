/**
 * The SMDG Liner Code List of carrier codes a B/L may name (CB-68): the 3-character liner codes
 * published by SMDG (smdg.org). The list is a JSON file built from an SMDG release with
 * `scripts/build-carrier-list.mjs`; an install can point to another file with CARRIER_LIST_FILE.
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** The SMDG carrier code list shipped with the shipping pack. */
export const DEFAULT_CARRIER_LIST_FILE = fileURLToPath(
  new URL('../../data/smdg-liner-codes.json', import.meta.url),
);

/** The most carriers a search returns when no higher limit is requested. */
const MAX_RESULTS = 500;

/**
 * A carrier of the SMDG list.
 * @typedef {{code: string, name: string}} Carrier
 */

/**
 * Normalizes `[code, name]` pairs into sorted, unique carrier entries.
 * @param {!Array<!Array<string>>} rows `[code, name]` pairs
 * @return {!Array<!Carrier>}
 */
export function carriersOfRows(rows) {
  const byCode = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    const code = String(row[0] ?? '')
      .trim()
      .toUpperCase();
    const name = String(row[1] ?? '').trim();
    if (code === '' || name === '' || byCode.has(code)) {
      continue;
    }
    byCode.set(code, {code, name});
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The same words without accents, in lower case, for searching.
 * @param {string} text
 * @return {string}
 */
function folded(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * A carrier code list to look carriers up in and search.
 * @param {!Array<!Carrier>} carriers
 * @param {?string=} version the SMDG release version, if known
 * @return {{size: number, version: ?string, has: function(string): boolean,
 *     get: function(string): ?Carrier, list: function(): !Array<!Carrier>,
 *     search: function(string=, number=): !Array<!Carrier>}}
 */
export function createCarrierList(carriers, version = null) {
  const sorted = [...carriers].sort((a, b) => a.code.localeCompare(b.code));
  const byCode = new Map(sorted.map(carrier => [carrier.code, carrier]));
  const index = sorted.map(carrier => ({
    carrier,
    code: carrier.code.toLowerCase(),
    name: folded(carrier.name),
  }));
  return {
    size: byCode.size,
    version,
    has: code =>
      byCode.has(
        String(code ?? '')
          .trim()
          .toUpperCase(),
      ),
    get: code =>
      byCode.get(
        String(code ?? '')
          .trim()
          .toUpperCase(),
      ) ?? null,
    list: () => sorted,
    search(query = '', limit = MAX_RESULTS) {
      const wanted = folded(String(query ?? '').trim());
      const max = Math.min(Math.max(1, limit), MAX_RESULTS);
      if (wanted === '') {
        return sorted.slice(0, max);
      }
      const exact = byCode.get(wanted.toUpperCase());
      const found = exact ? [exact] : [];
      for (const entry of index) {
        if (found.length >= max) {
          break;
        }
        const matches =
          entry.code.startsWith(wanted) ||
          entry.name.startsWith(wanted) ||
          entry.name.includes(` ${wanted}`) ||
          entry.name.includes(wanted);
        if (matches && entry.carrier !== exact) {
          found.push(entry.carrier);
        }
      }
      return found;
    },
  };
}

/**
 * Reads a carrier list file (JSON: `{version, carriers: [[code, name], ...]}`).
 * @param {string=} file the file; the pack's own list when not given
 * @return {!ReturnType<typeof createCarrierList>}
 */
export function loadCarrierList(file = DEFAULT_CARRIER_LIST_FILE) {
  const {version = null, carriers} = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(carriers) || carriers.length === 0) {
    throw new Error(`The carrier list ${file} holds no carriers`);
  }
  return createCarrierList(carriersOfRows(carriers), version);
}

/**
 * Checks whether a B/L document's `carrierCode` belongs to the SMDG list (CB-68).
 * @param {*} document the B/L document
 * @param {?ReturnType<typeof createCarrierList>} carrierList none: no check
 * @return {!Array<{path: string, message: string}>}
 */
export function carrierProblems(document, carrierList) {
  if (!carrierList) {
    return [];
  }
  const code = document?.carrierCode;
  if (typeof code !== 'string' || code === '') {
    return []; // the schema check names a missing carrier code
  }
  if (!carrierList.has(code)) {
    return [
      {
        path: 'carrierCode',
        message: `${code} is not on the SMDG liner code list: pick the carrier code from the list`,
      },
    ];
  }
  return [];
}
