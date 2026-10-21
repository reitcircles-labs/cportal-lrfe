import {UniqueConstraintError} from 'sequelize';
import {ConflictError} from '@lrfe/common';
import {defineModels} from './models.js';

const plain = row => (row ? row.get({plain: true}) : null);

/** Postgres extracts repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
  const m = defineModels(sequelize);

  return {
    models: m,
    /** Create missing tables (idempotent, safe on every start). */
    async sync() {
      await sequelize.sync();
    },
    async addExtract(extract) {
      try {
        await m.Extract.create(extract);
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new ConflictError('An extract with this token already exists');
        }
        throw err;
      }
      return extract;
    },
    async getExtract(id) {
      return plain(await m.Extract.findByPk(id));
    },
    /** The extracts of a land record, newest first. */
    async listExtracts(recordId) {
      const rows = await m.Extract.findAll({
        where: {recordId},
        order: [['issuedAt', 'DESC']],
      });
      return rows.map(plain);
    },
    /** Revoke an extract that is still valid: the updated row, or null when it is not valid. */
    async revokeExtract(id, patch) {
      // the status in the condition: of two revocations at the same moment, one wins
      const [n] = await m.Extract.update(
        {...patch, status: 'revoked'},
        {where: {id, status: 'valid'}},
      );
      return n ? plain(await m.Extract.findByPk(id)) : null;
    },
  };
}
