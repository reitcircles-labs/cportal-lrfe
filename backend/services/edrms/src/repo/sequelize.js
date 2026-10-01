import { Op, UniqueConstraintError } from 'sequelize';
import { ConflictError } from '@lrfe/common';
import { defineModels, SCHEMA } from './models.js';

const plain = (row) => (row ? row.get({ plain: true }) : null);
const version = (row) => row && { ...plain(row), size: Number(row.size) };

/** Postgres edrms repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const m = defineModels(sequelize);

    async function uniqueToConflict(fn) {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof UniqueConstraintError) {
                const field = err.errors?.[0]?.path;
                throw new ConflictError(`A document with this ${field} already exists`, { field });
            }
            throw err;
        }
    }

    return {
        models: m,
        async sync() {
            await sequelize.sync();
            // sync() creates missing tables but never alters existing ones. Columns added after a
            // table first existed are added here, idempotently, until real migrations exist.
            await sequelize.query(`ALTER TABLE "${SCHEMA}"."document_version" ADD COLUMN IF NOT EXISTS "provenance" JSONB`);
        },

        async createDocument({ year, build }) {
            return uniqueToConflict(() => sequelize.transaction(async (transaction) => {
                // Row-locked increment: the number is only consumed if the whole insert commits.
                const [[{ last }]] = await sequelize.query(
                    `INSERT INTO "${SCHEMA}"."counter" ("year", "last") VALUES (:year, 1)
                     ON CONFLICT ("year") DO UPDATE SET "last" = "counter"."last" + 1 RETURNING "last"`,
                    { replacements: { year }, transaction }
                );
                const { document, version: v } = await build(last);
                await m.Document.create(document, { transaction });
                await m.Version.create(v, { transaction });
                return document;
            }));
        },
        async getDocument(id) { return plain(await m.Document.findByPk(id)); },
        async findDocument(where) { return plain(await m.Document.findOne({ where })); },
        async listDocuments({ q, docType, batchId, props = {}, limit = 50, offset = 0 } = {}) {
            const where = {};
            if (docType) where.docType = docType;
            if (batchId) where.batchId = batchId;
            if (Object.keys(props).length) where.props = { [Op.contains]: props };
            if (q) {
                const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
                where[Op.or] = [
                    { title: { [Op.iLike]: like } },
                    { instrumentRef: { [Op.iLike]: like } },
                    { edrmsNo: { [Op.iLike]: like } },
                    sequelize.where(sequelize.cast(sequelize.col('props'), 'text'), { [Op.iLike]: like })
                ];
            }
            const { rows, count } = await m.Document.findAndCountAll({ where, order: [['edrmsNo', 'DESC']], limit, offset });
            return { items: rows.map(plain), total: count };
        },
        async listVersions(documentId) {
            return (await m.Version.findAll({ where: { documentId }, order: [['versionNumber', 'ASC']] })).map(version);
        },
        async getVersion(documentId, versionNumber) {
            return version(await m.Version.findOne({ where: { documentId, versionNumber } }));
        },
        async addVersion(documentId, expectedCurrent, v, patch) {
            return uniqueToConflict(() => sequelize.transaction(async (transaction) => {
                const [count] = await m.Document.update(patch, { where: { id: documentId, currentVersion: expectedCurrent }, transaction });
                if (count !== 1) throw new ConflictError('The document was changed by someone else. Reload and try again.');
                await m.Version.create(v, { transaction });
                return plain(await m.Document.findByPk(documentId, { transaction }));
            }));
        }
    };
}
