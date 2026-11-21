import {DataTypes, Op, QueryTypes, UniqueConstraintError} from 'sequelize';
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
  const {rawEntry, ...rest} = row;
  if (rawEntry) {
    return rawEntry;
  }
  return {...rest, at: new Date(rest.at).toISOString()};
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
      // On an existing install (CB-71), add 'archived' to the status enum before sync()
      await sequelize.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = '${SCHEMA}' AND t.typname = 'enum_bill_of_lading_status'
          ) THEN
            ALTER TYPE "${SCHEMA}"."enum_bill_of_lading_status" ADD VALUE IF NOT EXISTS 'archived';
          END IF;
        END $$;
      `);
      await sequelize.sync();
      // Replace the old full unique index with a partial one so archived drafts free their numbers
      await sequelize.query(
        `DROP INDEX IF EXISTS "${SCHEMA}"."bill_of_lading_organisation_id_carrier_code_record_no"`,
      );
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "bill_of_lading_active_reference" ON "${SCHEMA}"."bill_of_lading" ("organisationId", "carrierCode", "recordNo") WHERE "status" <> 'archived'`,
      );
      // the audit service's backfill reads committed seals in this order
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "bl_version_seal_order" ON "${SCHEMA}"."bl_version" ("committedAt", "recordId", "versionNumber") WHERE "seal" IS NOT NULL`,
      );
      // the list of a party's B/Ls finds them by their parties (CB-42)
      for (const column of ['carrier', 'holder', 'consignee']) {
        await sequelize.query(
          `CREATE INDEX IF NOT EXISTS "bl_title_${column}" ON "${SCHEMA}"."bl_title" ("${column}")`,
        );
      }
      for (const column of ['from', 'to']) {
        await sequelize.query(
          `CREATE INDEX IF NOT EXISTS "bl_title_entry_${column}" ON "${SCHEMA}"."bl_title_entry" ("${column}")`,
        );
      }
      // a split child's title proof finds its parent's split entry by its hash (CB-35)
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "bl_title_entry_hash" ON "${SCHEMA}"."bl_title_entry" ("entryHash")`,
      );
      // CB-55: add cross-platform transfer columns to bl_title if upgrading an existing install
      const queryInterface = sequelize.getQueryInterface();
      const titleTable = {tableName: 'bl_title', schema: SCHEMA};
      const titleColumns = await queryInterface.describeTable(titleTable);
      for (const column of [
        'externalPlatform',
        'externalParty',
        'previousState',
        'previousEndorsement',
      ]) {
        if (!titleColumns[column]) {
          await queryInterface.addColumn(titleTable, column, {
            type: DataTypes.STRING,
          });
        }
      }
      if (!titleColumns.changeReason) {
        await queryInterface.addColumn(titleTable, 'changeReason', {
          type: DataTypes.TEXT,
        });
      }
      const entryTable = {tableName: 'bl_title_entry', schema: SCHEMA};
      const entryColumns = await queryInterface.describeTable(entryTable);
      if (!entryColumns.rawEntry) {
        await queryInterface.addColumn(entryTable, 'rawEntry', {
          type: DataTypes.JSONB,
        });
      }
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
          where: {
            organisationId,
            carrierCode,
            recordNo,
            status: {[Op.ne]: 'archived'},
          },
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
      where.status = status ?? {[Op.ne]: 'archived'};
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
     * A page of the B/Ls an organisation is party to (CB-42), newest first: before issue those it
     * owns; after it those of which it is the carrier, the holder or the consignee, or that its
     * chain of title moved from or to it. Each with its title (null before issue) and whether the
     * chain names the organisation. With `number`, only those whose number (`recordNo`) is that
     * one, whatever its case (CB-47).
     * @param {{
     *   organisationId: string,
     *   limit?: number,
     *   offset?: number,
     *   number?: string,
     * }} query
     * @return {!Promise<{
     *   items: !Array<{record: object, title: ?object, inChain: boolean, version: ?object}>,
     *   total: number,
     * }>}
     */
    async listPartyRecords({organisationId, limit = 50, offset = 0, number}) {
      const from = `
        FROM "${SCHEMA}"."bill_of_lading" r
        LEFT JOIN "${SCHEMA}"."bl_title" t ON t."recordId" = r."id"`;
      const inChain = `EXISTS (
        SELECT 1 FROM "${SCHEMA}"."bl_title_entry" e
        WHERE e."recordId" = r."id" AND (e."from" = :org OR e."to" = :org))`;
      // with a number, only the B/Ls of that number (CB-47), whatever its case
      let numbered = '';
      if (number !== undefined) {
        numbered = 'AND lower(r."recordNo") = lower(:number)';
      }
      const where = `
        WHERE r."status" <> 'archived'
          AND ((t."recordId" IS NULL AND r."organisationId" = :org)
          OR t."carrier" = :org OR t."holder" = :org OR t."consignee" = :org
          OR ${inChain})
          ${numbered}`;
      const replacements = {org: organisationId, number: number ?? null};
      const rows = await sequelize.query(
        `SELECT r."id", ${inChain} AS "inChain" ${from} ${where}
         ORDER BY r."createdAt" DESC, r."id" ASC LIMIT :limit OFFSET :offset`,
        {
          replacements: {...replacements, limit, offset},
          type: QueryTypes.SELECT,
        },
      );
      const [{total}] = await sequelize.query(
        `SELECT COUNT(*)::int AS "total" ${from} ${where}`,
        {replacements, type: QueryTypes.SELECT},
      );
      const ids = rows.map(row => row.id);
      const records = await models.Record.findAll({where: {id: ids}});
      const titles = await models.Title.findAll({where: {recordId: ids}});
      const targetVersions = records
        .map(row => ({
          recordId: row.id,
          versionNumber: row.currentVersion ?? row.draftVersion,
        }))
        .filter(v => v.versionNumber !== null && v.versionNumber !== undefined);
      const latestVersions = targetVersions.length
        ? await models.Version.findAll({where: {[Op.or]: targetVersions}})
        : [];
      const recordById = new Map(records.map(row => [row.id, plain(row)]));
      const titleById = new Map(titles.map(row => [row.recordId, plain(row)]));
      const versionByRecord = new Map(
        latestVersions.map(row => [row.recordId, plain(row)]),
      );
      const items = rows.map(row => ({
        record: recordById.get(row.id),
        title: titleById.get(row.id) ?? null,
        inChain: row.inChain,
        version: versionByRecord.get(row.id) ?? null,
      }));
      return {items, total};
    },
    /**
     * Active issued B/Ls of a carrier organisation and carrier code (CB-56 duplicate cargo check):
     * excludes archived, voided, and split-closed records.
     * @param {string} organisationId
     * @param {string} carrierCode
     * @return {!Promise<!Array<{record: object, version: ?object}>>}
     */
    async listActiveCarrierIssued(organisationId, carrierCode) {
      const rows = await sequelize.query(
        `SELECT r."id"
         FROM "${SCHEMA}"."bill_of_lading" r
         INNER JOIN "${SCHEMA}"."bl_title" t ON t."recordId" = r."id"
         WHERE r."organisationId" = :org
           AND r."carrierCode" = :carrierCode
           AND r."status" <> 'archived'
           AND r."currentVersion" IS NOT NULL
           AND t."state" NOT IN ('void', 'split')`,
        {
          replacements: {org: organisationId, carrierCode},
          type: QueryTypes.SELECT,
        },
      );
      if (rows.length === 0) {
        return [];
      }
      const ids = rows.map(row => row.id);
      const records = await models.Record.findAll({where: {id: ids}});
      const targets = records.map(row => ({
        recordId: row.id,
        versionNumber: row.currentVersion,
      }));
      if (targets.length === 0) {
        return [];
      }
      const versions = await models.Version.findAll({
        where: {[Op.or]: targets},
      });
      const versionByRecord = new Map(
        versions.map(row => [row.recordId, plain(row)]),
      );
      return records.map(row => ({
        record: plain(row),
        version: versionByRecord.get(row.id) ?? null,
      }));
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
     *   expectedRevision?: number,
     *   versionPatch: object,
     *   recordPatch: object,
     * }} commit `expectedRevision`: only while the version is still at that revision (CB-44), else 409
     * @return {!Promise<{record: object, version: object}>}
     */
    async commit({
      recordId,
      versionNumber,
      expectedRevision,
      versionPatch,
      recordPatch,
    }) {
      const where = {recordId, versionNumber, state: 'in_review'};
      if (expectedRevision !== undefined) {
        where.revision = expectedRevision;
      }
      return inTransaction(sequelize, async transaction => {
        const [n] = await models.Version.update(
          {...versionPatch, state: 'committed'},
          {where, transaction},
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
     * The first entries of the B/Ls a split made (CB-50): those whose previousHash is the
     * parent's `split` entry's hash and whose command is `issue-from-split`.
     * @param {string} splitEntryHash
     * @return {!Promise<!Array<object>>}
     */
    async listSplitChildEntries(splitEntryHash) {
      const rows = await models.TitleEntry.findAll({
        where: {previousHash: splitEntryHash, command: 'issue-from-split'},
      });
      return rows.map(row => entryOf(plain(row)));
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

    /**
     * Connected platforms directory & PINT transfers (CB-55).
     * @return {!Promise<!Array<object>>}
     */
    async listPlatforms() {
      const rows = await models.Platform.findAll({order: [['code', 'ASC']]});
      return rows.map(plain);
    },
    /**
     * @param {string} code
     * @return {!Promise<?object>}
     */
    async getPlatform(code) {
      return plain(await models.Platform.findByPk(code));
    },
    /**
     * @param {object} platform
     * @return {!Promise<object>}
     */
    async createPlatform(platform) {
      return uniqueToConflict(
        `Platform ${platform.code} is already registered`,
        async () => plain(await models.Platform.create(platform)),
      );
    },
    /**
     * @param {string} code
     * @param {object} patch
     * @return {!Promise<?object>}
     */
    async updatePlatform(code, patch) {
      const [n] = await models.Platform.update(patch, {where: {code}});
      return n ? plain(await models.Platform.findByPk(code)) : null;
    },
    /**
     * Finds a B/L record with its title by carrier code and document reference across all
     * organisations (for incoming PINT return/conflict checks, CB-55).
     * @param {string} carrierCode
     * @param {string} recordNo
     * @return {!Promise<?{record: object, title: ?object}>}
     */
    async findRecordByCarrierAndNo(carrierCode, recordNo) {
      const rows = await models.Record.findAll({
        where: {carrierCode, recordNo, status: {[Op.ne]: 'archived'}},
      });
      if (rows.length === 0) {
        return null;
      }
      const candidates = await Promise.all(
        rows.map(async row => {
          const record = plain(row);
          const title = plain(await models.Title.findByPk(record.id));
          return {record, title};
        }),
      );
      return (
        candidates.find(
          item =>
            item.title &&
            item.title.state !== 'void' &&
            item.title.state !== 'split',
        ) ?? candidates[0]
      );
    },
    /**
     * @param {string} envelopeId
     * @return {!Promise<?object>}
     */
    async getTransferByEnvelopeId(envelopeId) {
      return plain(await models.PintTransfer.findOne({where: {envelopeId}}));
    },
    /**
     * @param {string} recordId
     * @return {!Promise<?object>}
     */
    async getPendingTransfer(recordId) {
      return plain(
        await models.PintTransfer.findOne({
          where: {recordId, direction: 'out', status: 'pending'},
          order: [['createdAt', 'DESC']],
        }),
      );
    },
    /**
     * @param {object} transfer
     * @return {!Promise<object>}
     */
    async createTransfer(transfer) {
      return plain(await models.PintTransfer.create(transfer));
    },
    /**
     * @param {string} id
     * @param {object} patch
     * @return {!Promise<?object>}
     */
    async updateTransfer(id, patch) {
      const [n] = await models.PintTransfer.update(patch, {where: {id}});
      return n ? plain(await models.PintTransfer.findByPk(id)) : null;
    },
  };
}
