import {Op, UniqueConstraintError} from 'sequelize';
import {ConflictError, inTransaction} from '@lrfe/common';
import {defineModels, SCHEMA} from './models.js';

/**
 * A row as a plain object, or null.
 * @param {?object} row
 * @return {?object}
 */
function plain(row) {
  return row ? row.get({plain: true}) : null;
}

/**
 * A chain entry as the repository answers it: its time as an ISO string, as it was hashed.
 * @param {object} row
 * @return {object}
 */
function entryOf(row) {
  return {...row, at: new Date(row.at).toISOString()};
}

/** The 409 for a reference the organisation already holds (unique per organisation: models.js). */
const DUPLICATE_BL =
  'Your organisation already has a B/L with this carrier code and transport document reference';

/**
 * Runs `fn`, turning a broken unique rule into a 409 with this message: a reference the
 * organisation already holds, or a version number taken meanwhile.
 * @param {string} message
 * @param {function(): Promise<*>} fn
 * @return {Promise<*>}
 */
async function uniqueToConflict(message, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw new ConflictError(message);
    }
    throw err;
  }
}

/**
 * PostgreSQL shipping-records repository. Same interface as ./memory.js.
 * @param {import('sequelize').Sequelize} sequelize
 * @return {!Object<string, *>}
 */
export function createSequelizeRepo(sequelize) {
  const models = defineModels(sequelize);

  /**
   * A version's row inside the current transaction, if any.
   * @param {string} recordId
   * @param {number} versionNumber
   * @param {object} [options]
   * @return {Promise<?object>}
   */
  async function versionRow(recordId, versionNumber, options = {}) {
    return plain(
      await models.Version.findOne({
        where: {recordId, versionNumber},
        ...options,
      }),
    );
  }

  return {
    models,
    /**
     * Create missing tables (idempotent, safe on every start).
     * @return {!Promise<void>}
     */
    async sync() {
      await sequelize.sync();
      // the audit service's backfill reads committed seals in this order
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "bl_version_seal_order" ON "${SCHEMA}"."bl_version" ("committedAt", "recordId", "versionNumber") WHERE "seal" IS NOT NULL`,
      );
      // a split child's title proof finds its parent's split entry by its hash (CB-35)
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "bl_title_entry_hash" ON "${SCHEMA}"."bl_title_entry" ("entryHash")`,
      );
    },

    /**
     * A new record with its first version, in one transaction; 409 when its organisation already
     * holds the reference.
     * @param {{record: object, version: object}} created
     * @return {!Promise<object>} the record
     */
    async createRecord({record, version}) {
      return uniqueToConflict(DUPLICATE_BL, () =>
        inTransaction(sequelize, async transaction => {
          await models.Record.create(record, {transaction});
          await models.Version.create(version, {transaction});
          return record;
        }),
      );
    },
    /**
     * @param {string} id
     * @return {!Promise<?object>}
     */
    async getRecord(id) {
      return plain(await models.Record.findByPk(id));
    },
    /**
     * A record read in the caller's transaction with its row locked until the transaction ends
     * (CB-34: a commit or a submission waits for an issue in progress).
     * @param {string} id
     * @return {!Promise<?object>}
     */
    async lockRecord(id) {
      return inTransaction(sequelize, async transaction =>
        plain(
          await models.Record.findByPk(id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          }),
        ),
      );
    },
    /**
     * The record of an organisation with a carrier code and reference.
     * @param {{organisationId: string, carrierCode: string, recordNo: string}} reference
     * @return {!Promise<?object>}
     */
    async findRecord({organisationId, carrierCode, recordNo}) {
      return plain(
        await models.Record.findOne({
          where: {organisationId, carrierCode, recordNo},
        }),
      );
    },
    /**
     * A page of records, newest first; `organisationId` null for every organisation's.
     * @param {{
     *   organisationId?: ?string,
     *   status?: string,
     *   draftState?: string,
     *   q?: string,
     *   limit?: number,
     *   offset?: number,
     * }} [query]
     * @return {!Promise<{items: !Array<object>, total: number}>}
     */
    async listRecords({
      organisationId = null,
      status,
      draftState,
      q,
      limit = 50,
      offset = 0,
    } = {}) {
      const where = {};
      if (organisationId !== null) {
        where.organisationId = organisationId;
      }
      if (status) {
        where.status = status;
      }
      if (draftState) {
        where.draftState = draftState;
      }
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        where[Op.or] = [
          {recordNo: {[Op.iLike]: like}},
          {label: {[Op.iLike]: like}},
        ];
      }
      const {rows, count} = await models.Record.findAndCountAll({
        where,
        order: [
          ['createdAt', 'DESC'],
          ['id', 'ASC'],
        ],
        limit,
        offset,
      });
      return {items: rows.map(plain), total: count};
    },
    /**
     * @param {string} id
     * @param {object} patch
     * @return {!Promise<?object>} the record, or null when there is none
     */
    async updateRecord(id, patch) {
      const [n] = await models.Record.update(patch, {where: {id}});
      return n ? plain(await models.Record.findByPk(id)) : null;
    },

    /**
     * @param {string} recordId
     * @param {number} versionNumber
     * @return {!Promise<?object>}
     */
    async getVersion(recordId, versionNumber) {
      return versionRow(recordId, versionNumber);
    },
    /**
     * @param {string} recordId
     * @return {!Promise<!Array<object>>} oldest first
     */
    async listVersions(recordId) {
      const rows = await models.Version.findAll({
        where: {recordId},
        order: [['versionNumber', 'ASC']],
      });
      return rows.map(plain);
    },
    /**
     * @param {object} version
     * @return {!Promise<object>}
     */
    async addVersion(version) {
      return uniqueToConflict(
        `Version ${version.versionNumber} already exists`,
        async () => plain(await models.Version.create(version)),
      );
    },
    /**
     * Update a version; with `expectedState` and `expectedRevision`, only while it is still in
     * that state and at that revision (else null).
     * @param {string} recordId
     * @param {number} versionNumber
     * @param {object} patch
     * @param {{expectedState?: string, expectedRevision?: number}} [expected]
     * @return {!Promise<?object>}
     */
    async updateVersion(
      recordId,
      versionNumber,
      patch,
      {expectedState, expectedRevision} = {},
    ) {
      const where = {recordId, versionNumber};
      if (expectedState !== undefined) {
        where.state = expectedState;
      }
      if (expectedRevision !== undefined) {
        where.revision = expectedRevision;
      }
      const [n] = await models.Version.update(patch, {where});
      return n ? versionRow(recordId, versionNumber) : null;
    },
    /**
     * Commit a version in review: it becomes committed and the record is updated.
     * @param {{
     *   recordId: string,
     *   versionNumber: number,
     *   versionPatch: object,
     *   recordPatch: object,
     * }} commit
     * @return {!Promise<{record: object, version: object}>}
     */
    async commit({recordId, versionNumber, versionPatch, recordPatch}) {
      return inTransaction(sequelize, async transaction => {
        const [n] = await models.Version.update(
          {...versionPatch, state: 'committed'},
          {where: {recordId, versionNumber, state: 'in_review'}, transaction},
        );
        if (!n) {
          throw new ConflictError('The version is not in review');
        }
        await models.Record.update(recordPatch, {
          where: {id: recordId},
          transaction,
        });
        return {
          record: plain(await models.Record.findByPk(recordId, {transaction})),
          version: await versionRow(recordId, versionNumber, {transaction}),
        };
      });
    },

    /**
     * The title of a B/L (CB-31), or null before it is issued.
     * @param {string} recordId
     * @return {!Promise<?object>}
     */
    async getTitle(recordId) {
      return plain(await models.Title.findByPk(recordId));
    },
    /**
     * A B/L's first title; null when it has one already (the table's primary key: one title per
     * B/L, also against a concurrent issue).
     * @param {object} title the title with its `recordId`
     * @return {!Promise<?object>}
     */
    async createTitle(title) {
      try {
        return plain(await models.Title.create(title));
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          return null;
        }
        throw err;
      }
    },
    /**
     * Changes a B/L's title, only while it is still at the revision the caller read (else null).
     * A concurrent change waits for the other's transaction, then finds the revision moved on.
     * @param {string} recordId
     * @param {object} patch
     * @param {number} expectedRevision
     * @return {!Promise<?object>}
     */
    async updateTitle(recordId, patch, expectedRevision) {
      const [n] = await models.Title.update(patch, {
        where: {recordId, revision: expectedRevision},
      });
      return n ? plain(await models.Title.findByPk(recordId)) : null;
    },

    /**
     * A B/L's chain of title (CB-32), in order of seq; none before it is issued.
     * @param {string} recordId
     * @return {!Promise<!Array<object>>}
     */
    async listTitleEntries(recordId) {
      const rows = await models.TitleEntry.findAll({
        where: {recordId},
        order: [['seq', 'ASC']],
      });
      return rows.map(row => entryOf(plain(row)));
    },
    /**
     * The chain-of-title entry with this entryHash, of any B/L (CB-35: a split child's first
     * entry links to its parent's split entry by its hash), or null.
     * @param {string} entryHash
     * @return {!Promise<?object>}
     */
    async findTitleEntryByHash(entryHash) {
      const row = plain(await models.TitleEntry.findOne({where: {entryHash}}));
      return row ? entryOf(row) : null;
    },
    /**
     * Adds an entry to a B/L's chain of title, in the caller's transaction; a second entry with
     * the same seq is refused by the primary key.
     * @param {object} entry
     * @return {!Promise<object>}
     */
    async appendTitleEntry(entry) {
      return entryOf(plain(await models.TitleEntry.create(entry)));
    },

    /**
     * Every committed version's seal, oldest first, after the cursor `after`.
     * @param {{after?: ?{at: string, id: string, version: number}, limit?: number}} [page]
     * @return {!Promise<!Array<{recordId: string, version: number, seal: string, at: Date}>>}
     */
    async listSeals({after = null, limit = 500} = {}) {
      const sealed = {seal: {[Op.ne]: null}};
      let where = sealed;
      if (after) {
        const position =
          `("committedAt", "recordId", "versionNumber") > (` +
          `${sequelize.escape(new Date(after.at))}, ` +
          `${sequelize.escape(after.id)}::uuid, ${Number(after.version)})`;
        where = {[Op.and]: [sealed, sequelize.literal(position)]};
      }
      const rows = await models.Version.findAll({
        where,
        attributes: ['recordId', 'versionNumber', 'seal', 'committedAt'],
        order: [
          ['committedAt', 'ASC'],
          ['recordId', 'ASC'],
          ['versionNumber', 'ASC'],
        ],
        limit,
      });
      return rows.map(r => ({
        recordId: r.recordId,
        version: r.versionNumber,
        seal: r.seal,
        at: r.committedAt,
      }));
    },
    /**
     * Number and label of each record by id.
     * @param {!Array<string>} ids
     * @return {!Promise<!Array<{id: string, recordNo: string, label: string}>>}
     */
    async recordLabels(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await models.Record.findAll({
        where: {id: ids},
        attributes: ['id', 'recordNo', 'label'],
      });
      return rows.map(r => ({id: r.id, recordNo: r.recordNo, label: r.label}));
    },
    /**
     * Which of these versions are committed.
     * @param {!Array<{recordId: string, versionNumber: number}>} pairs
     * @return {!Promise<!Array<{recordId: string, versionNumber: number}>>}
     */
    async committedVersions(pairs) {
      if (pairs.length === 0) {
        return [];
      }
      const rows = await models.Version.findAll({
        where: {
          state: 'committed',
          [Op.or]: pairs.map(p => ({
            recordId: p.recordId,
            versionNumber: p.versionNumber,
          })),
        },
        attributes: ['recordId', 'versionNumber'],
      });
      return rows.map(v => ({
        recordId: v.recordId,
        versionNumber: v.versionNumber,
      }));
    },
  };
}
