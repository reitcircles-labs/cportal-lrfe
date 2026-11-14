/**
 * The seal of a committed record version, shared by every product's record service (CB-27):
 * land-records and shipping-records seal their versions with this one formula. It lives here, not
 * in a product service, because the offline verifier (services/audit/verifier/lrfe-verify.mjs,
 * `recordSeal`) repeats this exact formula for every product: a record service that sealed
 * differently could not be checked offline. Change it only together with the verifier, and never
 * for versions already sealed.
 *
 * Imported from `@lrfe/record-contract/seal`.
 */
import {canonicalJson, sha256Hex} from '@lrfe/common';

/**
 * The seal of a committed version: SHA-256 over the canonical JSON of the whole version (its data,
 * who submitted and approved it, when, and the previous version's seal). Each seal therefore
 * depends on every version before it: changing an earlier version breaks all later seals.
 * @param {{id: string, recordNo: string}} record
 * @param {{
 *   versionNumber: number,
 *   data: object,
 *   submittedById?: ?string,
 *   approvedById?: ?string,
 *   committedAt: (Date|string),
 *   previousSeal?: ?string,
 * }} version
 * @return {string} the seal, lowercase hex
 */
export function sealOf(record, version) {
  return sha256Hex(
    canonicalJson({
      recordId: record.id,
      recordNo: record.recordNo,
      versionNumber: version.versionNumber,
      data: version.data,
      submittedById: version.submittedById ?? null,
      approvedById: version.approvedById ?? null,
      committedAt: new Date(version.committedAt).toISOString(),
      previousSeal: version.previousSeal ?? null,
    }),
  );
}

/**
 * Recompute the chain of committed versions (oldest first). Returns one entry per version:
 * `{versionNumber, seal, intact, linked}`: `intact`, the stored seal matches the content;
 * `linked`, its previousSeal is the seal of the version before.
 * @param {{id: string, recordNo: string}} record
 * @param {!Array<object>} committed the committed versions, oldest first
 * @return {!Array<{versionNumber: number, seal: string, intact: boolean, linked: boolean}>}
 */
export function verifyChain(record, committed) {
  let previous = null;
  return committed.map(v => {
    const intact = sealOf(record, v) === v.seal;
    const linked = (v.previousSeal ?? null) === previous;
    previous = v.seal;
    return {versionNumber: v.versionNumber, seal: v.seal, intact, linked};
  });
}
