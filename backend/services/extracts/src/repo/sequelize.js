import {UniqueConstraintError} from 'sequelize';
import {ConflictError, inTransaction} from '@lrfe/common';
import {SCHEMA, defineModels} from './models.js';

const plain = row => (row ? row.get({plain: true}) : null);

/** Postgres extracts repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
  const m = defineModels(sequelize);

  return {
    models: m,
    /** Create missing tables (idempotent, safe on every start). */
    async sync() {
      await sequelize.sync();
      // columns added after the table was first created (API-692): nullable for older rows, each
      // with a unique index of a fixed name, so a start never adds a second one
      for (const [column, type] of [
        ['extractNo', 'VARCHAR(255)'],
        ['checkCode', 'VARCHAR(12)'],
      ]) {
        await sequelize.query(
          `ALTER TABLE "${SCHEMA}"."extract" ADD COLUMN IF NOT EXISTS "${column}" ${type}`,
        );
        await sequelize.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS "extract_${column}_unique" ON "${SCHEMA}"."extract" ("${column}")`,
        );
      }
    },
    /**
     * Save a new extract: `build(seq)` makes it with the year's next number, while the counter row
     * is locked. The number is used only if the extract is saved, so a failed issue leaves no gap.
     */
    async addExtract({year, build}) {
      try {
        return await inTransaction(sequelize, async transaction => {
          const [[{last}]] = await sequelize.query(
            `INSERT INTO "${SCHEMA}"."counter" ("year", "last") VALUES (:year, 1)
                     ON CONFLICT ("year") DO UPDATE SET "last" = "counter"."last" + 1 RETURNING "last"`,
            {replacements: {year}, transaction},
          );
          const extract = await build(last);
          await m.Extract.create(extract, {transaction});
          return extract;
        });
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new ConflictError(
            'An extract with this token or code already exists',
          );
        }
        throw err;
      }
    },
    async getExtract(id) {
      return plain(await m.Extract.findByPk(id));
    },
    /** The extract with this token (the public check), or null. */
    async getExtractByToken(token) {
      return plain(await m.Extract.findOne({where: {token}}));
    },
    /** The extract with this check code (typed in on the check page), or null. */
    async getExtractByCheckCode(checkCode) {
      return plain(await m.Extract.findOne({where: {checkCode}}));
    },
    /** The extracts of a land record, newest first. */
    async listExtracts(recordId) {
      const rows = await m.Extract.findAll({
        where: {recordId},
        order: [
          ['issuedAt', 'DESC'],
          ['extractNo', 'DESC'],
        ],
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
