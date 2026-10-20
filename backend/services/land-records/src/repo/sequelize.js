import {Op, UniqueConstraintError} from 'sequelize';
import {ConflictError, inTransaction} from '@lrfe/common';
import {defineModels, SCHEMA} from './models.js';

const plain = row => (row ? row.get({plain: true}) : null);

/** The document versions a land record version pins: { id, version, edrmsNo, docType, ref }. */
const pinnedOf = v =>
  (v.data?.documents || []).map(d => ({
    id: d.edrmsDocumentId,
    version: d.version,
    edrmsNo: d.edrmsNo,
    docType: d.docType,
    ref: d.ref ?? null,
  }));

/** Postgres land-records repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
  const m = defineModels(sequelize);

  async function uniqueToConflict(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        const field = err.errors?.[0]?.path;
        throw new ConflictError(
          `A land record with this ${field} already exists`,
          {field},
        );
      }
      throw err;
    }
  }

  return {
    models: m,
    /** Create missing tables (idempotent, safe on every start). */
    async sync() {
      await sequelize.sync();
      // columns added after the table was first created
      await sequelize.query(
        `ALTER TABLE "${SCHEMA}"."record_version" ADD COLUMN IF NOT EXISTS "reviewInstanceId" UUID`,
      );
      await sequelize.query(
        `ALTER TABLE "${SCHEMA}"."land_record" ADD COLUMN IF NOT EXISTS "flagLog" JSONB NOT NULL DEFAULT '[]'::jsonb`,
      );
      // the audit service's backfill reads committed seals in this order (API-669)
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "record_version_seal_order" ON "${SCHEMA}"."record_version" ("committedAt", "recordId", "versionNumber") WHERE "seal" IS NOT NULL`,
      );
    },

    async createRecord({year, build}) {
      return uniqueToConflict(() =>
        inTransaction(sequelize, async transaction => {
          // Row-locked increment: the number is only consumed if the whole insert commits.
          const [[{last}]] = await sequelize.query(
            `INSERT INTO "${SCHEMA}"."counter" ("year", "last") VALUES (:year, 1)
                     ON CONFLICT ("year") DO UPDATE SET "last" = "counter"."last" + 1 RETURNING "last"`,
            {replacements: {year}, transaction},
          );
          const {record, version} = await build(last);
          await m.Record.create(record, {transaction});
          await m.Version.create(version, {transaction});
          return record;
        }),
      );
    },
    async getRecord(id) {
      return plain(await m.Record.findByPk(id));
    },
    async findRecord(where) {
      return plain(await m.Record.findOne({where}));
    },
    async listRecords({q, status, match, limit = 50, offset = 0} = {}) {
      const where = {};
      if (status) where.status = status;
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        // `parcel`: never the owners' names and ID numbers in searchText (API-697)
        const fields =
          match === 'parcel'
            ? ['recordNo', 'label']
            : ['recordNo', 'label', 'searchText'];
        where[Op.or] = fields.map(f => ({[f]: {[Op.iLike]: like}}));
      }
      const {rows, count} = await m.Record.findAndCountAll({
        where,
        order: [['recordNo', 'DESC']],
        limit,
        offset,
      });
      return {items: rows.map(plain), total: count};
    },
    async updateRecord(id, patch) {
      const [n] = await m.Record.update(patch, {where: {id}});
      return n ? plain(await m.Record.findByPk(id)) : null;
    },

    async getVersion(recordId, versionNumber) {
      return plain(await m.Version.findOne({where: {recordId, versionNumber}}));
    },
    /** Every committed version's seal (superseded ones too), oldest first, after the cursor `after` (API-669). */
    async listSeals({after = null, limit = 500} = {}) {
      const sealed = {seal: {[Op.ne]: null}};
      const where = after
        ? {
            [Op.and]: [
              sealed,
              sequelize.literal(
                `("committedAt", "recordId", "versionNumber") > (${sequelize.escape(new Date(after.at))}, ${sequelize.escape(after.id)}::uuid, ${Number(after.version)})`,
              ),
            ],
          }
        : sealed;
      const rows = await m.Version.findAll({
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
    async listVersions(recordId) {
      return (
        await m.Version.findAll({
          where: {recordId},
          order: [['versionNumber', 'ASC']],
        })
      ).map(plain);
    },
    async addVersion(version) {
      return uniqueToConflict(async () =>
        plain(await m.Version.create(version)),
      );
    },
    async updateVersion(
      recordId,
      versionNumber,
      patch,
      {expectedRevision} = {},
    ) {
      const where = {
        recordId,
        versionNumber,
        ...(expectedRevision !== undefined ? {revision: expectedRevision} : {}),
      };
      const [n] = await m.Version.update(patch, {where});
      return n
        ? plain(await m.Version.findOne({where: {recordId, versionNumber}}))
        : null;
    },
    async findRecordsPinning(documentIds) {
      const out = new Map();
      if (!documentIds.length) return out;
      const [rows] = await sequelize.query(
        `SELECT d->>'edrmsDocumentId' AS "documentId", r."id" AS "recordId", r."recordNo", r."label", v."versionNumber", v."state"
                   FROM "${SCHEMA}"."record_version" v
                   JOIN "${SCHEMA}"."land_record" r ON r."id" = v."recordId"
                   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v."data"->'documents', '[]'::jsonb)) d
                  WHERE v."state" <> 'superseded' AND d->>'edrmsDocumentId' IN (:ids)`,
        {replacements: {ids: documentIds}},
      );
      for (const {documentId, ...rest} of rows) {
        out.set(documentId, [...(out.get(documentId) || []), rest]);
      }
      return out;
    },
    /** Number and label of each land record by id (the Anchorings screens, API-696). */
    async recordLabels(ids) {
      if (!ids.length) return [];
      return (
        await m.Record.findAll({
          where: {id: ids},
          attributes: ['id', 'recordNo', 'label'],
        })
      ).map(r => ({id: r.id, recordNo: r.recordNo, label: r.label}));
    },
    /** The committed versions (current or superseded) that pin any version of these documents: [{ documentId, version, recordId, versionNumber }]. */
    async findCommittedPinning(documentIds) {
      if (!documentIds.length) return [];
      const [rows] = await sequelize.query(
        `SELECT d->>'edrmsDocumentId' AS "documentId", (d->>'version')::int AS "version", v."recordId", v."versionNumber"
                   FROM "${SCHEMA}"."record_version" v
                   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v."data"->'documents', '[]'::jsonb)) d
                  WHERE v."state" IN ('committed', 'superseded') AND d->>'edrmsDocumentId' IN (:ids)`,
        {replacements: {ids: documentIds}},
      );
      return rows;
    },
    /** The documents each committed version (current or superseded) is made of: [{ recordId, versionNumber, documents: [{ id, version }] }]. */
    async versionDocuments(pairs) {
      if (!pairs.length) return [];
      const rows = await m.Version.findAll({
        where: {
          state: ['committed', 'superseded'],
          [Op.or]: pairs.map(p => ({
            recordId: p.recordId,
            versionNumber: p.versionNumber,
          })),
        },
        attributes: ['recordId', 'versionNumber', 'data'],
      });
      return rows.map(v => ({
        recordId: v.recordId,
        versionNumber: v.versionNumber,
        documents: pinnedOf(v),
      }));
    },
    async commit({
      recordId,
      versionNumber,
      versionPatch,
      recordPatch,
      supersede,
    }) {
      return inTransaction(sequelize, async transaction => {
        const [n] = await m.Version.update(
          {...versionPatch, state: 'committed'},
          {where: {recordId, versionNumber, state: 'in_review'}, transaction},
        );
        if (!n) throw new ConflictError('The version is not in review');
        if (supersede) {
          await m.Version.update(
            {state: 'superseded'},
            {where: {recordId, versionNumber: supersede}, transaction},
          );
        }
        await m.Record.update(recordPatch, {
          where: {id: recordId},
          transaction,
        });
        return {
          record: plain(await m.Record.findByPk(recordId, {transaction})),
          version: plain(
            await m.Version.findOne({
              where: {recordId, versionNumber},
              transaction,
            }),
          ),
        };
      });
    },

    async addComment(comment) {
      return plain(await m.Comment.create(comment));
    },
    async listComments(recordId) {
      return (
        await m.Comment.findAll({
          where: {recordId},
          order: [['createdAt', 'ASC']],
        })
      ).map(plain);
    },
  };
}
