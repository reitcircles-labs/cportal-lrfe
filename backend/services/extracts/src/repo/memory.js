import {ConflictError} from '@lrfe/common';

const clone = v => (v === undefined ? v : structuredClone(v));

/**
 * In-memory extracts repository (tests, EXTRACTS_STORE=memory). Behaviour must match
 * ./sequelize.js: a unique token, a revocation only of a valid extract.
 */
export function createMemoryRepo() {
  const extracts = new Map();
  const counter = new Map(); // year → the last number used

  return {
    /**
     * Save a new extract: `build(seq)` makes it with the year's next number. The number is used
     * only when the extract is saved, so a failed issue leaves no gap.
     */
    async addExtract({year, build}) {
      const seq = (counter.get(year) ?? 0) + 1;
      const extract = await build(seq);
      const clash = [...extracts.values()].find(
        e => e.token === extract.token || e.checkCode === extract.checkCode,
      );
      if (clash) {
        throw new ConflictError(
          'An extract with this token or code already exists',
        );
      }
      counter.set(year, seq);
      extracts.set(extract.id, clone(extract));
      return clone(extract);
    },
    async getExtract(id) {
      return clone(extracts.get(id)) ?? null;
    },
    /** The extract with this token (the public check), or null. */
    async getExtractByToken(token) {
      const found = [...extracts.values()].find(e => e.token === token);
      return clone(found) ?? null;
    },
    /** The extract with this check code (typed in on the check page), or null. */
    async getExtractByCheckCode(checkCode) {
      const found = [...extracts.values()].find(e => e.checkCode === checkCode);
      return clone(found) ?? null;
    },
    /** The extracts of a land record, newest first. */
    async listExtracts(recordId) {
      return (
        [...extracts.values()]
          .filter(e => e.recordId === recordId)
          // the same moment: the higher number first
          .sort(
            (a, b) =>
              b.issuedAt - a.issuedAt ||
              String(b.extractNo).localeCompare(String(a.extractNo)),
          )
          .map(clone)
      );
    },
    /** Revoke an extract that is still valid: the updated row, or null when it is not valid. */
    async revokeExtract(id, patch) {
      const extract = extracts.get(id);
      if (!extract || extract.status !== 'valid') return null;
      Object.assign(extract, clone(patch), {status: 'revoked'});
      return clone(extract);
    },
  };
}
