import { Op, UniqueConstraintError } from 'sequelize';
import { ConflictError } from '@lrfe/common';
import { defineModels, SCHEMA } from './models.js';

const plain = (row) => (row ? row.get({ plain: true }) : null);

/** Postgres land-records repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const m = defineModels(sequelize);

    async function uniqueToConflict(fn) {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof UniqueConstraintError) {
                const field = err.errors?.[0]?.path;
                throw new ConflictError(`A land record with this ${field} already exists`, { field });
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
            await sequelize.query(`ALTER TABLE "${SCHEMA}"."record_version" ADD COLUMN IF NOT EXISTS "reviewInstanceId" UUID`);
        },

        async createRecord({ year, build }) {
            return uniqueToConflict(() => sequelize.transaction(async (transaction) => {
                // Row-locked increment: the number is only consumed if the whole insert commits.
                const [[{ last }]] = await sequelize.query(
                    `INSERT INTO "${SCHEMA}"."counter" ("year", "last") VALUES (:year, 1)
                     ON CONFLICT ("year") DO UPDATE SET "last" = "counter"."last" + 1 RETURNING "last"`,
                    { replacements: { year }, transaction }
                );
                const { record, version } = await build(last);
                await m.Record.create(record, { transaction });
                await m.Version.create(version, { transaction });
                return record;
            }));
        },
        async getRecord(id) { return plain(await m.Record.findByPk(id)); },
        async findRecord(where) { return plain(await m.Record.findOne({ where })); },
        async listRecords({ q, status, limit = 50, offset = 0 } = {}) {
            const where = {};
            if (status) where.status = status;
            if (q) {
                const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
                where[Op.or] = [{ recordNo: { [Op.iLike]: like } }, { label: { [Op.iLike]: like } }, { searchText: { [Op.iLike]: like } }];
            }
            const { rows, count } = await m.Record.findAndCountAll({ where, order: [['recordNo', 'DESC']], limit, offset });
            return { items: rows.map(plain), total: count };
        },
        async updateRecord(id, patch) {
            const [n] = await m.Record.update(patch, { where: { id } });
            return n ? plain(await m.Record.findByPk(id)) : null;
        },

        async getVersion(recordId, versionNumber) { return plain(await m.Version.findOne({ where: { recordId, versionNumber } })); },
        async listVersions(recordId) {
            return (await m.Version.findAll({ where: { recordId }, order: [['versionNumber', 'ASC']] })).map(plain);
        },
        async addVersion(version) {
            return uniqueToConflict(async () => plain(await m.Version.create(version)));
        },
        async updateVersion(recordId, versionNumber, patch, { expectedRevision } = {}) {
            const where = { recordId, versionNumber, ...(expectedRevision !== undefined ? { revision: expectedRevision } : {}) };
            const [n] = await m.Version.update(patch, { where });
            return n ? plain(await m.Version.findOne({ where: { recordId, versionNumber } })) : null;
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
                { replacements: { ids: documentIds } }
            );
            for (const { documentId, ...rest } of rows) out.set(documentId, [...(out.get(documentId) || []), rest]);
            return out;
        },
        async commit({ recordId, versionNumber, versionPatch, recordPatch, supersede }) {
            return sequelize.transaction(async (transaction) => {
                const [n] = await m.Version.update({ ...versionPatch, state: 'committed' }, { where: { recordId, versionNumber, state: 'in_review' }, transaction });
                if (!n) throw new ConflictError('The version is not in review');
                if (supersede) await m.Version.update({ state: 'superseded' }, { where: { recordId, versionNumber: supersede }, transaction });
                await m.Record.update(recordPatch, { where: { id: recordId }, transaction });
                return {
                    record: plain(await m.Record.findByPk(recordId, { transaction })),
                    version: plain(await m.Version.findOne({ where: { recordId, versionNumber }, transaction }))
                };
            });
        },

        async addComment(comment) { return plain(await m.Comment.create(comment)); },
        async listComments(recordId) {
            return (await m.Comment.findAll({ where: { recordId }, order: [['createdAt', 'ASC']] })).map(plain);
        }
    };
}
