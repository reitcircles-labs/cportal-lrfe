import { Op, UniqueConstraintError } from 'sequelize';
import { inTransaction } from '@lrfe/common';
import { defineModels, SCHEMA } from './models.js';

// pg returns BIGINT as a string
const plain = (row) => (row ? { ...row.get({ plain: true }), seq: Number(row.seq) } : null);
// one writer at a time, also across instances: transaction-scoped advisory locks
const TRAIL_LOCK = 6540001;
const TREE_LOCK = 6550001;
const CHUNK = 5000;
const SENT = ['submitted', 'onChain', 'confirmed'];
const leafOf = (row) => (row ? { ...row.get({ plain: true }), leafIndex: Number(row.leafIndex) } : null);

/** Postgres audit repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const { TrailEntry, TreeLeaf, TreeNode, Anchor, JobLease, Signoff, Finding, ChangedAlert } = defineModels(sequelize);
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
            // columns added for the audit checkpoint and finding answers (API-680)
            for (const [table, col, type] of [['signoff', 'kind', "VARCHAR(255) NOT NULL DEFAULT 'item'"], ['signoff', 'fromVersion', 'INTEGER'], ['signoff', 'toVersion', 'INTEGER'],
                ['signoff', 'items', 'JSONB'], ['finding', 'outcome', 'VARCHAR(255)'], ['finding', 'answers', "JSONB NOT NULL DEFAULT '[]'::jsonb"]]) {
                await sequelize.query(`ALTER TABLE "${SCHEMA}"."${table}" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
            }
            await sequelize.query(`ALTER TABLE "${SCHEMA}"."signoff" ALTER COLUMN "comment" DROP NOT NULL`);
            // the Anchorings screens (API-671): when it reached the blockchain or failed, why, and its depth
            for (const [col, type] of [['reason', 'VARCHAR(255)'], ['confirmations', 'INTEGER'], ['onChainAt', 'TIMESTAMPTZ'], ['failedAt', 'TIMESTAMPTZ']]) {
                await sequelize.query(`ALTER TABLE "${SCHEMA}"."anchor" ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
            }
            // failed before the reason was stored: read from the error text, once
            await sequelize.query(`UPDATE "${SCHEMA}"."anchor" SET "reason" = CASE
                    WHEN "error" LIKE 'rolled back, and expired%' THEN 'rolledBackExpired'
                    WHEN "error" LIKE 'expired%' THEN 'expired'
                    ELSE 'refused' END
                WHERE "status" = 'failed' AND "reason" IS NULL`);
            // one sign-off per auditor and item, also for two requests at the same moment (API-659)
            await sequelize.query(`DROP INDEX IF EXISTS "${SCHEMA}"."signoff_once"`);
            await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "signoff_item_once" ON "${SCHEMA}"."signoff"
                ("signedById", "recordId", "recordVersion", COALESCE("documentId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "kind" = 'item'`);
            // one audit sign-off per checkpoint, whoever signs it (API-680)
            // and once per starting version: two checkpoints built while a version was committed cannot overlap
            await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "signoff_checkpoint_once" ON "${SCHEMA}"."signoff"
                ("recordId", "toVersion") WHERE "kind" = 'checkpoint'`);
            await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "signoff_checkpoint_from_once" ON "${SCHEMA}"."signoff"
                ("recordId", "fromVersion") WHERE "kind" = 'checkpoint'`);
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

        /** Entries of `type` with after < seq ≤ upTo, in order (what a batch covers, API-696). */
        async entriesOfType(type, after, upTo) {
            return (await TrailEntry.findAll({ where: { type, seq: { [Op.gt]: after, [Op.lte]: upTo } }, order: [['seq', 'ASC']] })).map(plain);
        },
        /** The keys of the leaves with from ≤ index < to, in order (what a batch covers, API-696). */
        async leafKeys(from, to) {
            const rows = await TreeLeaf.findAll({ where: { leafIndex: { [Op.gte]: from, [Op.lt]: to } }, attributes: ['key'], order: [['leafIndex', 'ASC']], raw: true });
            return rows.map(r => r.key);
        },

        async head() { return plain(await TrailEntry.findOne({ order: [['seq', 'DESC']] })); },
        async entryBySeq(seq) { return plain(await TrailEntry.findOne({ where: { seq } })); },
        async contentHashes(from, to) {
            return (await TrailEntry.findAll({ where: { seq: { [Op.between]: [from, to] } }, attributes: ['seq', 'contentHash'], order: [['seq', 'ASC']], raw: true }))
                .map(r => ({ seq: Number(r.seq), contentHash: r.contentHash }));
        },

        async lastAnchor() { return anchorOf(await Anchor.findOne({ order: [['batch', 'DESC']] })); },
        async lastAnchorWhere(statuses) { return anchorOf(await Anchor.findOne({ where: { status: statuses }, order: [['batch', 'DESC']] })); },
        async createAnchor(row) { return anchorOf(await Anchor.create(row)); },
        async updateAnchor(batch, patch) { await Anchor.update(patch, { where: { batch } }); },
        /** Newest first; only those with one of `statuses` when given. */
        async listAnchors({ statuses, limit = 50, offset = 0 } = {}) {
            return (await Anchor.findAll({ where: statuses ? { status: statuses } : {}, order: [['batch', 'DESC']], limit, offset })).map(anchorOf);
        },
        /** How many anchorings there are of each status. */
        async countAnchors() {
            const rows = await Anchor.findAll({ attributes: ['status', [sequelize.fn('COUNT', sequelize.col('batch')), 'n']], group: ['status'], raw: true });
            return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
        },
        /** The newest anchoring before `batch` with one of `statuses`, or null. */
        async anchorBefore(batch, statuses) {
            return anchorOf(await Anchor.findOne({ where: { batch: { [Op.lt]: batch }, status: statuses }, order: [['batch', 'DESC']] }));
        },
        /** Given-up anchorings that spent this wallet output, oldest first. */
        async anchorsSpending(txHash, index) { return (await Anchor.findAll({ where: { inputTxHash: txHash, inputIndex: index, status: 'failed' }, order: [['batch', 'ASC']] })).map(anchorOf); },
        async anchorCovering(index) { return anchorOf(await Anchor.findOne({ where: { status: 'confirmed', size: { [Op.gt]: index } }, order: [['batch', 'ASC']] })); },
        async anchorByBatch(batch) { return anchorOf(await Anchor.findOne({ where: { batch } })); },
        async anchorForLeaf(index) { return anchorOf(await Anchor.findOne({ where: { status: SENT, size: { [Op.gt]: index } }, order: [['batch', 'ASC']] })); },
        async anchorForEntry(seq) { return anchorOf(await Anchor.findOne({ where: { status: SENT, checkpointSeq: { [Op.gte]: seq } }, order: [['checkpointSeq', 'ASC'], ['batch', 'ASC']] })); },
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

        async createSignoff(row) {
            try { return (await Signoff.create(row)).get({ plain: true }); } catch (err) {
                if (err instanceof UniqueConstraintError) return null;          // signed off already (signoff_item_once, signoff_checkpoint_once, signoff_checkpoint_from_once)
                throw err;
            }
        },
        async listSignoffs({ recordId, documentId } = {}) {
            return (await Signoff.findAll({ where: { ...(recordId ? { recordId } : {}), ...(documentId ? { documentId } : {}) }, order: [['signedAt', 'ASC']] })).map(r => r.get({ plain: true }));
        },
        async createFinding(row) { return (await Finding.create(row)).get({ plain: true }); },
        async getFinding(id) { return (await Finding.findByPk(id))?.get({ plain: true }) ?? null; },
        async listFindings({ recordId, documentId, status } = {}) {
            return (await Finding.findAll({ where: { ...(recordId ? { recordId } : {}), ...(documentId ? { documentId } : {}), ...(status ? { status } : {}) }, order: [['raisedAt', 'ASC']] })).map(r => r.get({ plain: true }));
        },
        async updateOpenFinding(id, patch) {
            const [n] = await Finding.update(patch, { where: { id, status: 'open' } });
            return n === 1;
        },
        /** Append in one statement, so two auditors answering at the same moment both keep their answer. */
        async addAnswer(id, answer) {
            const [rows] = await sequelize.query(
                `UPDATE "${SCHEMA}"."finding" SET "answers" = "answers" || jsonb_build_array(CAST(:answer AS jsonb)) WHERE "id" = :id AND "status" = 'open' RETURNING "id"`,
                { replacements: { id, answer: JSON.stringify(answer) } }
            );
            return rows.length === 1;
        },
        async getAlert(key) { return (await ChangedAlert.findByPk(key))?.get({ plain: true }) ?? null; },
        async listAlerts() { return (await ChangedAlert.findAll({ order: [['foundAt', 'ASC']] })).map(r => r.get({ plain: true })); },
        async createAlert(row) {
            try { return (await ChangedAlert.create(row)).get({ plain: true }); } catch (err) {
                if (err instanceof UniqueConstraintError) return null;          // found by another check at the same moment
                throw err;
            }
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
