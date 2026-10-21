import {ConflictError} from '@lrfe/common';

const clone = v => (v === undefined ? v : structuredClone(v));

/**
 * In-memory extracts repository (tests, EXTRACTS_STORE=memory). Behaviour must match
 * ./sequelize.js: a unique token, a revocation only of a valid extract.
 */
export function createMemoryRepo() {
  const extracts = new Map();

  return {
    async addExtract(extract) {
      if ([...extracts.values()].some(e => e.token === extract.token)) {
        throw new ConflictError('An extract with this token already exists');
      }
      extracts.set(extract.id, clone(extract));
      return clone(extract);
    },
    async getExtract(id) {
      return clone(extracts.get(id)) ?? null;
    },
    /** The extracts of a land record, newest first. */
    async listExtracts(recordId) {
      return [...extracts.values()]
        .filter(e => e.recordId === recordId)
        .sort((a, b) => b.issuedAt - a.issuedAt)
        .map(clone);
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
