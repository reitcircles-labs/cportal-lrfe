import {DataTypes, Op, UniqueConstraintError} from 'sequelize';
import {ConflictError, inTransaction} from '@lrfe/common';
import {defineModels, SCHEMA} from './models.js';

const plain = row => (row ? row.get({plain: true}) : null);
// DECIMAL and BIGINT come back from pg as strings
const doc = row =>
  row && {
    ...plain(row),
    size: Number(row.size),
    extractionCostUsd: Number(row.extractionCostUsd),
  };
const extraction = row =>
  row && {
    ...plain(row),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
  };

/** Postgres intake repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
  const m = defineModels(sequelize);

  return {
    models: m,
    /** Create missing tables, then bring older ones up to date (idempotent, safe on every start). */
    async sync() {
      await sequelize.sync();
      // 'crosscheck' (API-622) came after the table was first created
      await sequelize.query(
        `ALTER TYPE "${SCHEMA}"."enum_extraction_role" ADD VALUE IF NOT EXISTS 'crosscheck'`,
      );
      const q = sequelize.getQueryInterface();
      const document = {tableName: 'document', schema: SCHEMA};
      const columns = await q.describeTable(document);
      if (!columns.crosscheck) {
        await q.addColumn(document, 'crosscheck', {type: DataTypes.JSONB});
      } // API-624
      if (!columns.encryption) {
        await q.addColumn(document, 'encryption', {type: DataTypes.JSONB});
      } // API-639
      if (!columns.transcription) {
        await q.addColumn(document, 'transcription', {type: DataTypes.JSONB});
      } // API-798
      if (!columns.filedRecord) {
        await q.addColumn(document, 'filedRecord', {type: DataTypes.JSONB});
      } // API-815
      // the search service's re-index reads documents in this order (API-804)
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "document_changed_order" ON "${SCHEMA}"."document" ("updatedAt", "id")`,
      );
    },

    async nextBatchNumber(registry) {
      const [[{last}]] = await sequelize.query(
        `INSERT INTO "${SCHEMA}"."counter" ("key", "last") VALUES (:key, 1)
                 ON CONFLICT ("key") DO UPDATE SET "last" = "counter"."last" + 1 RETURNING "last"`,
        {replacements: {key: `batch:${registry}`}},
      );
      return last;
    },
    async createBatch(b) {
      return plain(await m.Batch.create(b));
    },
    async getBatch(id) {
      return plain(await m.Batch.findByPk(id));
    },
    async listBatches() {
      return (await m.Batch.findAll({order: [['createdAt', 'DESC']]})).map(
        plain,
      );
    },
    async countByBatch() {
      const rows = await m.Document.findAll({
        attributes: [
          'batchId',
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'n'],
        ],
        group: ['batchId', 'status'],
        raw: true,
      });
      const out = {};
      for (const r of rows) {
        out[r.batchId] ??= {};
        out[r.batchId][r.status] = Number(r.n);
      }
      return out;
    },

    async createDocument(d) {
      try {
        return doc(await m.Document.create(d));
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new ConflictError('This file was already captured', {
            field: 'sha256',
          });
        }
        throw err;
      }
    },
    async getDocument(id) {
      return doc(await m.Document.findByPk(id));
    },
    async findBySha(sha256) {
      return doc(await m.Document.findOne({where: {sha256}}));
    },
    async updateDocument(id, patch, expectedVersion) {
      const where =
        expectedVersion === undefined ? {id} : {id, version: expectedVersion};
      const [n] = await m.Document.update(
        {...patch, version: sequelize.literal('"version" + 1')},
        {where},
      );
      return n === 1 ? doc(await m.Document.findByPk(id)) : null;
    },
    async listDocuments({batchId, status, q, limit = 100, offset = 0} = {}) {
      const where = {};
      if (batchId) where.batchId = batchId;
      if (status) where.status = {[Op.in]: [].concat(status)};
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        where[Op.or] = [
          {fileName: {[Op.iLike]: like}},
          {docType: {[Op.iLike]: like}},
          {edrmsNo: {[Op.iLike]: like}},
          sequelize.where(sequelize.cast(sequelize.col('fields'), 'text'), {
            [Op.iLike]: like,
          }),
          // a cleared document's reference and property (API-815)
          sequelize.where(
            sequelize.cast(sequelize.col('filedRecord'), 'text'),
            {[Op.iLike]: like},
          ),
        ];
      }
      const {rows, count} = await m.Document.findAndCountAll({
        where,
        // id breaks ties, so that pages of the list never skip or repeat a document
        order: [
          ['capturedAt', 'ASC'],
          ['id', 'ASC'],
        ],
        limit,
        offset,
      });
      return {items: rows.map(doc), total: count};
    },

    /**
     * Documents changed at or after `since` (all when null), oldest change first, after the
     * position `after` ({ at, id }): an index range scan however deep. `total` on the first page.
     */
    async listChanged({since = null, after = null, limit = 200} = {}) {
      const where = {
        [Op.and]: [
          ...(since ? [{updatedAt: {[Op.gte]: new Date(since)}}] : []),
          ...(after
            ? [
                sequelize.literal(
                  `("updatedAt", "id") > (${sequelize.escape(new Date(after.at))}, ${sequelize.escape(after.id)}::uuid)`,
                ),
              ]
            : []),
        ],
      };
      const rows = await m.Document.findAll({
        where,
        attributes: ['id', 'status', 'updatedAt'],
        // id breaks ties, so that the list never skips or repeats a document
        order: [
          ['updatedAt', 'ASC'],
          ['id', 'ASC'],
        ],
        limit,
      });
      const total = after
        ? null
        : await m.Document.count({
            where: since ? {updatedAt: {[Op.gte]: new Date(since)}} : {},
          });
      return {items: rows.map(plain), total};
    },

    async addExtraction(e) {
      await m.Extraction.create(e);
    },
    async listExtractions(documentId) {
      return (
        await m.Extraction.findAll({
          where: {documentId},
          order: [['createdAt', 'ASC']],
        })
      ).map(extraction);
    },
    async getExtraction(id) {
      return extraction(await m.Extraction.findByPk(id));
    },
    /** Documents whose stored model answers still hold page text (written before API-798). */
    async listDocumentIdsWithPageText(limit = 100) {
      const [rows] = await sequelize.query(
        `SELECT DISTINCT "documentId" FROM "${SCHEMA}"."extraction"
                 WHERE jsonb_exists("answer", 'pages') LIMIT :limit`,
        {replacements: {limit}},
      );
      return rows.map(r => r.documentId);
    },
    /** Remove the page text from a document's stored model answers (it now lives in a file). */
    async removePageText(documentId) {
      await sequelize.query(
        `UPDATE "${SCHEMA}"."extraction" SET "answer" = "answer" - 'pages'
                 WHERE "documentId" = :documentId AND jsonb_exists("answer", 'pages')`,
        {replacements: {documentId}},
      );
    },
    /** Remove the model answers of a document's readings (a cleared filed document, API-807). */
    async clearAnswers(documentId) {
      await m.Extraction.update({answer: null}, {where: {documentId}});
    },
    async usageSince(since) {
      return (
        await m.Extraction.findAll({
          where: {createdAt: {[Op.gte]: since}},
          attributes: {exclude: ['answer']},
        })
      ).map(extraction);
    },

    async enqueueJob(j) {
      return plain(await m.Job.create(j));
    },
    async hasOpenJob(documentId) {
      return (
        (await m.Job.count({
          where: {documentId, status: {[Op.in]: ['queued', 'running']}},
        })) > 0
      );
    },
    async claimJob({workerId, now, staleMs}) {
      return inTransaction(sequelize, async transaction => {
        // SKIP LOCKED: several workers can poll the same table without taking the same job.
        const [rows] = await sequelize.query(
          `SELECT "id" FROM "${SCHEMA}"."job"
                     WHERE ("status" = 'queued' AND "runAfter" <= :now) OR ("status" = 'running' AND "lockedAt" < :stale)
                     ORDER BY "runAfter" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
          {
            replacements: {now, stale: new Date(now.getTime() - staleMs)},
            transaction,
          },
        );
        if (!rows.length) return null;
        await m.Job.update(
          {
            status: 'running',
            lockedBy: workerId,
            lockedAt: now,
            attempts: sequelize.literal('"attempts" + 1'),
            updatedAt: now,
          },
          {where: {id: rows[0].id}, transaction},
        );
        return plain(await m.Job.findByPk(rows[0].id, {transaction}));
      });
    },
    async updateJob(id, patch) {
      await m.Job.update(patch, {where: {id}});
    },
    async listJobs(documentId) {
      return (await m.Job.findAll({where: {documentId}})).map(plain);
    },

    async addEvent(e) {
      await m.Event.create(e);
    },
    async listEvents(documentId) {
      return (
        await m.Event.findAll({where: {documentId}, order: [['id', 'ASC']]})
      ).map(r => ({...plain(r), id: Number(r.id)}));
    },
  };
}
