import { Op, UniqueConstraintError } from 'sequelize';
import { inTransaction } from '@lrfe/common';
import { defineModels, SCHEMA } from './models.js';

// pg returns BIGINT as a string
const plain = (row) => (row ? { ...row.get({ plain: true }), seq: Number(row.seq) } : null);
// one writer at a time, also across instances: transaction-scoped advisory locks
const TRAIL_LOCK = 6540001;
const TREE_LOCK = 6550001;
const CHUNK = 5000;
const leafOf = (row) => (row ? { ...row.get({ plain: true }), leafIndex: Number(row.leafIndex) } : null);

/** Postgres audit repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const { TrailEntry, TreeLeaf, TreeNode, Anchor, JobLease } = defineModels(sequelize);
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const anchorOf = (row) => (row ? { ...row.get({ plain: true }), size: Number(row.size), checkpointSeq: num(row.checkpointSeq), ttl: num(row.ttl), fee: row.fee === null ? null : String(row.fee) } : null);

    const treeOps = (transaction) => ({
        // the last index + 1 (an index lookup; count(*) would read the whole table)
        async leafCount() { const last = await TreeLeaf.max('leafIndex', { transaction }); return last === null || last === undefined ? 0 : Number(last) + 1; },
        async existingKeys(keys) {
            const out = [];
            for (let i = 0; i < keys.length; i += CHUNK) {
                const rows = await TreeLeaf.findAll({ where: { key: keys.slice(i, i + CHUNK) }, attributes: ['key'], transaction });
                out.push(...rows.map(r => r.key));
            }
            return out;
        },
        async getNodes(positions) {
            if (!positions.length) return new Map();
            const rows = await TreeNode.findAll({ where: { pos: [...new Set(positions)] }, transaction });
            return new Map(rows.map(r => [Number(r.pos), r.hash]));
        },
        async leafByKey(key) { return leafOf(await TreeLeaf.findOne({ where: { key }, transaction })); },
        /** key → item for the keys that are in the tree, a chunk per query. */
        async itemsByKeys(keys) {
            const out = new Map();
            for (let i = 0; i < keys.length; i += CHUNK) {
                for (const r of await TreeLeaf.findAll({ where: { key: keys.slice(i, i + CHUNK) }, attributes: ['key', 'item'], transaction })) out.set(r.key, r.item);
            }
            return out;
        },
        async insert(leaves, nodes) {
            for (let i = 0; i < nodes.length; i += CHUNK) await TreeNode.bulkCreate(nodes.slice(i, i + CHUNK), { transaction });
            for (let i = 0; i < leaves.length; i += CHUNK) await TreeLeaf.bulkCreate(leaves.slice(i, i + CHUNK), { transaction });
        }
    });

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
        async sync() {
            await sequelize.sync();
            // columns added after the table was first created (API-657)
            for (const [col, type] of [['ttl', 'BIGINT'], ['lastSentAt', 'TIMESTAMPTZ'], ['inputTxHash', 'VARCHAR(64)'], ['inputIndex', 'INTEGER'], ['expiredSeenHeight', 'INTEGER'], ['spentSeenHeight', 'INTEGER']]) {
                await sequelize.query(`ALTER TABLE "${SCHEMA}"."anchor" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
            }
        },

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
        },

        async head() { return plain(await TrailEntry.findOne({ order: [['seq', 'DESC']] })); },

        async lastAnchor() { return anchorOf(await Anchor.findOne({ order: [['batch', 'DESC']] })); },
        async lastAnchorWhere(statuses) { return anchorOf(await Anchor.findOne({ where: { status: statuses }, order: [['batch', 'DESC']] })); },
        async createAnchor(row) { return anchorOf(await Anchor.create(row)); },
        async updateAnchor(batch, patch) { await Anchor.update(patch, { where: { batch } }); },
        async listAnchors({ limit = 50 } = {}) { return (await Anchor.findAll({ order: [['batch', 'DESC']], limit })).map(anchorOf); },
        /** Given-up anchorings that spent this wallet output, oldest first. */
        async anchorsSpending(txHash, index) { return (await Anchor.findAll({ where: { inputTxHash: txHash, inputIndex: index, status: 'failed' }, order: [['batch', 'ASC']] })).map(anchorOf); },
        async anchorCovering(index) { return anchorOf(await Anchor.findOne({ where: { status: 'confirmed', size: { [Op.gt]: index } }, order: [['batch', 'ASC']] })); },
        async claimLease(name, holder, ms) {
            // insert, or take over an expired lease, or renew our own: one statement, so two instances
            // cannot both win; on the database's clock, so the instances' clocks do not matter
            const [rows] = await sequelize.query(
                `INSERT INTO "${SCHEMA}"."job_lease" ("name", "holder", "expiresAt") VALUES (:name, :holder, now() + :ms * interval '1 millisecond')
                 ON CONFLICT ("name") DO UPDATE SET "holder" = EXCLUDED."holder", "expiresAt" = EXCLUDED."expiresAt"
                 WHERE "job_lease"."holder" = EXCLUDED."holder" OR "job_lease"."expiresAt" < now()
                 RETURNING "holder"`,
                { replacements: { name, holder, ms } }
            );
            return rows.length === 1;
        },

        tree: treeOps(undefined),
        withTreeLock(fn) {
            return inTransaction(sequelize, async (transaction) => {
                await sequelize.query(`SELECT pg_advisory_xact_lock(${TREE_LOCK})`, { transaction });
                return fn(treeOps(transaction));
            });
        }
    };
}
