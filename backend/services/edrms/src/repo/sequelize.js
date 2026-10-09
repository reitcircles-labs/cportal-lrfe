import { Op, UniqueConstraintError } from 'sequelize';
import { ConflictError } from '@lrfe/common';
import { defineModels, SCHEMA } from './models.js';
import { PREFIX_MIN, SIMILARITY, fuzzy, normalizeSearch, searchTextOf } from '../search.js';
import { normalizeRef } from '../catalogue.js';

const plain = (row) => (row ? row.get({ plain: true }) : null);
const version = (row) => row && { ...plain(row), size: Number(row.size) };

/** Postgres edrms repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const m = defineModels(sequelize);
    let trigram = null;
    const hasTrigram = async () => {
        if (trigram === null) {
            const [rows] = await sequelize.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
            trigram = rows.length > 0;
        }
        return trigram;
    };

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
            await sequelize.query(`ALTER TABLE "${SCHEMA}"."document_version" ADD COLUMN IF NOT EXISTS "encryption" JSONB`);   // API-638
            // Search (API-645): the normalised text, a full-text vector generated from it, their indexes
            const doc = `"${SCHEMA}"."document"`;
            await sequelize.query(`ALTER TABLE ${doc} ADD COLUMN IF NOT EXISTS "searchText" TEXT NOT NULL DEFAULT ''`);
            await sequelize.query(`ALTER TABLE ${doc} ADD COLUMN IF NOT EXISTS "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "searchText")) STORED`);
            await sequelize.query(`CREATE INDEX IF NOT EXISTS "document_search_vector" ON ${doc} USING gin ("searchVector")`);
            // Spelling variants need pg_trgm (a trusted extension the database owner may create);
            // without it, search still works, only without similarity.
            try {
                await sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
                await sequelize.query(`CREATE INDEX IF NOT EXISTS "document_search_trgm" ON ${doc} USING gin ("searchText" gin_trgm_ops)`);
            } catch (err) {
                console.warn(`edrms search: pg_trgm not available (${err.message}); searching without spelling variants`);
            }
            trigram = null;
            // documents filed before search text existed
            const [rows] = await sequelize.query(`SELECT "id", "title", "instrumentRef", "edrmsNo", "fields" FROM ${doc} WHERE "searchText" = ''`);
            for (const r of rows) await m.Document.update({ searchText: searchTextOf(r) }, { where: { id: r.id } });
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
        /**
         * Full-text search over the normalised text (words, and word starts from 3 letters), plus
         * spelling variants by trigram word similarity when pg_trgm is available; best matches first.
         */
        async listDocuments({ q, docType, batchId, props = {}, limit = 50, offset = 0 } = {}) {
            const where = {};
            if (docType) where.docType = docType;
            if (batchId) where.batchId = batchId;
            if (Object.keys(props).length) where.props = { [Op.contains]: props };
            const words = q ? normalizeSearch(q).split(' ').filter(Boolean) : [];
            if (!words.length) {
                const { rows, count } = await m.Document.findAndCountAll({ where, order: [['edrmsNo', 'DESC']], limit, offset });
                return { items: rows.map(plain), total: count };
            }
            // every word must match: as a word, as a word start (3+ letters), or, for a name with
            // pg_trgm, as a spelling variant; numbers only exactly or as a start
            const term = (w) => sequelize.escape(w.length >= PREFIX_MIN ? `${w}:*` : w);
            const trgm = await hasTrigram();
            const perWord = words.map(w => {
                const exact = `"searchVector" @@ to_tsquery('simple', ${term(w)})`;
                return trgm && fuzzy(w) ? `(${exact} OR word_similarity(${sequelize.escape(w)}, "searchText") >= ${SIMILARITY})` : exact;
            });
            const fts = `to_tsquery('simple', ${sequelize.escape(words.map(w => (w.length >= PREFIX_MIN ? `${w}:*` : w)).join(' & '))})`;
            const fuzzyWords = trgm ? words.filter(fuzzy) : [];
            const similar = fuzzyWords.length ? fuzzyWords.map(w => `word_similarity(${sequelize.escape(w)}, "searchText")`).join(' + ') : null;
            where[Op.and] = [sequelize.literal(`(${perWord.join(' AND ')})`)];
            // the document's own reference or EDRMS number first, then the best matches
            const own = sequelize.escape(normalizeRef(q));
            const order = [[sequelize.literal(`("instrumentRef" = ${own} OR "edrmsNo" = ${own})`), 'DESC'], [sequelize.literal(`ts_rank_cd("searchVector", ${fts})`), 'DESC'], ...(similar ? [[sequelize.literal(similar), 'DESC']] : []), ['edrmsNo', 'DESC']];
            const { rows, count } = await m.Document.findAndCountAll({ where, order, limit, offset });
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
