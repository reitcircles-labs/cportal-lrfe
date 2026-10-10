import { Op, UniqueConstraintError } from 'sequelize';
import { inTransaction } from '@lrfe/common';
import { defineModels } from './models.js';

// pg returns BIGINT as a string
const plain = (row) => (row ? { ...row.get({ plain: true }), seq: Number(row.seq) } : null);
// one writer at a time, also across instances: a transaction-scoped advisory lock
const TRAIL_LOCK = 6540001;

/** Postgres audit repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const { TrailEntry } = defineModels(sequelize);

    function where({ subjects, type, from, to, exceptRecord }) {
        const and = [];
        if (subjects) and.push(sequelize.literal(`"subjects" ?| ARRAY[${subjects.map(s => sequelize.escape(s)).join(',')}]::text[]`));
        if (type) and.push(type.endsWith('.') ? { type: { [Op.startsWith]: type } } : { type });
        if (from) and.push({ time: { [Op.gte]: from } });
        if (to) and.push({ time: { [Op.lt]: to } });
        if (exceptRecord) {
            and.push(sequelize.literal(`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text("subjects") s
                WHERE s LIKE 'record:%' AND s <> ${sequelize.escape(exceptRecord)})`));
        }
        return { [Op.and]: and };
    }

    return {
        models: { TrailEntry },
        async sync() { await sequelize.sync(); },

        async append(eventId, build) {
            try {
                return await inTransaction(sequelize, async (transaction) => {
                    await sequelize.query(`SELECT pg_advisory_xact_lock(${TRAIL_LOCK})`, { transaction });
                    if (await TrailEntry.findOne({ where: { eventId }, attributes: ['seq'], transaction })) return null;
                    const last = plain(await TrailEntry.findOne({ order: [['seq', 'DESC']], transaction }));
                    const entry = build(last);
                    await TrailEntry.create(entry, { transaction });
                    return entry;
                });
            } catch (err) {
                // written by another instance between our check and insert
                if (err instanceof UniqueConstraintError && err.errors?.some(e => e.path === 'eventId')) return null;
                throw err;
            }
        },

        async list(filter, { limit, offset }) {
            const { rows, count } = await TrailEntry.findAndCountAll({ where: where(filter), order: [['seq', 'ASC']], limit, offset });
            return { total: count, entries: rows.map(plain) };
        },

        async linkedSubjects(subjects, { exceptRecord } = {}) {
            const rows = await TrailEntry.findAll({ where: where({ subjects, exceptRecord }), attributes: ['subjects'] });
            return [...new Set(rows.flatMap(r => r.subjects))];
        },

        async page(after, limit) {
            return (await TrailEntry.findAll({ where: { seq: { [Op.gt]: after } }, order: [['seq', 'ASC']], limit })).map(plain);
        }
    };
}
