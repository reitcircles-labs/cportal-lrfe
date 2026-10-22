import {normalizeCheckCode} from './check-code.js';

/** What a token looks like: 32 random bytes, base64url (newToken). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** How many characters of the fingerprint (the version's seal) the answer shows. */
const FINGERPRINT_SHOWN = 8;

/**
 * The public check of an ownership extract (API-693): anyone holding an extract scans its QR code
 * and is told one state:
 *   current       it matches the registry's record, the version is on the blockchain, still current
 *   replaced      it matches, but the record has a newer version: the next one since `replacedAt`
 *   revoked       the registry withdrew it on `revokedAt`
 *   mismatch      it does not match the registry's record (a check failed)
 *   unknown       there is no such extract
 *   unavailable   it cannot be checked right now
 * An extract is found by its QR code's token or by its check code, typed in from the extract.
 * Current and replaced are answered only when the version has just been checked: its seal held by
 * land-records, in the audit tree, and in a confirmed batch on the blockchain. Every answer has the
 * same fields, null where they do not apply, and never anything about the owners or the parcel.
 */
export class ExtractCheck {
  constructor({repo, records, versions, clock = () => new Date()}) {
    this.repo = repo;
    this.records = records; // land-records: the record's current version
    this.versions = versions; // the audit service: the version checked now
    this.clock = clock;
  }

  /**
   * The answer for `token`: the QR code's token, or the check code typed in from the extract
   * (API-692); and for the log why a check could not be made (`reason`: the part that could not be
   * read). Anything else is unknown.
   * @return {Promise<{answer: object, reason: (string|null)}>}
   */
  async check(token) {
    let extract = null;
    try {
      const isToken = TOKEN.test(token);
      const code = isToken ? null : normalizeCheckCode(token);
      if (isToken) {
        extract = await this.repo.getExtractByToken(token);
      } else if (code) {
        extract = await this.repo.getExtractByCheckCode(code);
      }
    } catch {
      return this.unavailable(null, 'register');
    }
    if (!extract) return {answer: this.answer('unknown'), reason: null};
    if (extract.status === 'revoked') {
      return {
        answer: this.answer('revoked', extract, {revokedAt: extract.revokedAt}),
        reason: null,
      };
    }
    return this.verified(extract);
  }

  /** A valid extract: its version checked now against land-records and the blockchain. */
  async verified(extract) {
    let record;
    try {
      record = await this.records.getRecord(extract.recordId);
    } catch {
      return this.unavailable(extract, 'land-records');
    }
    if (!record?.current) return this.mismatch(extract, 'land-records');
    const proof = await this.versions.checkVersion(
      extract.recordId,
      extract.versionNumber,
    );
    if (!proof) return this.unavailable(extract, 'audit');
    if (!(proof.valid && proof.status === 'confirmed')) {
      // a check that failed is a mismatch; one that could not be made now is not
      return Object.values(proof.checks || {}).includes(false)
        ? this.mismatch(extract, 'audit')
        : this.unavailable(extract, 'audit');
    }
    const verifiedFacts = {
      fingerprintEnd: String(proof.seal).slice(-FINGERPRINT_SHOWN),
      batch: proof.batch,
      transactionId: proof.tx,
      explorerUrl: proof.explorerUrl ?? null,
    };
    const current = record.current;
    if (current.versionNumber === extract.versionNumber) {
      // the seal land-records holds for its current version is the one on the blockchain
      if (current.seal !== proof.seal) {
        return this.mismatch(extract, 'land-records');
      }
      return {
        answer: this.answer('current', extract, verifiedFacts),
        reason: null,
      };
    }
    if (current.versionNumber < extract.versionNumber) {
      return this.mismatch(extract, 'land-records');
    }
    // replaced when the version after it was committed, however many came since
    let next;
    try {
      next = await this.records.getVersion(
        extract.recordId,
        extract.versionNumber + 1,
      );
    } catch {
      return this.unavailable(extract, 'land-records');
    }
    if (!next?.committedAt) return this.mismatch(extract, 'land-records');
    return {
      answer: this.answer('replaced', extract, {
        ...verifiedFacts,
        replacedAt: next.committedAt,
      }),
      reason: null,
    };
  }

  unavailable(extract, reason) {
    return {answer: this.answer('unavailable', extract), reason};
  }

  mismatch(extract, reason) {
    return {answer: this.answer('mismatch', extract), reason};
  }

  /**
   * One answer, every field always there. Of the register row only what is printed on the extract
   * and is not personal: its id and number, the record number, the version and the issue date.
   */
  answer(state, extract = null, facts = {}) {
    return {
      state,
      extractId: extract?.id ?? null,
      extractNo: extract?.extractNo ?? null,
      recordNo: extract?.recordNo ?? null,
      versionNumber: extract?.versionNumber ?? null,
      issuedAt: extract?.issuedAt ?? null,
      fingerprintEnd: null,
      batch: null,
      transactionId: null,
      explorerUrl: null,
      replacedAt: null,
      revokedAt: null,
      ...facts,
      checkedAt: this.clock(),
    };
  }
}
