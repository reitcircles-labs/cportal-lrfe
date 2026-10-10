#!/usr/bin/env node
/**
 * The growing Merkle tree at about a million leaves (API-655): time to build it, time to make and
 * check proofs, and (on PostgreSQL) the storage used.
 *
 *   npm run bench -w @lrfe/audit                                   in memory
 *   BENCH_DB=postgres://… npm run bench -w @lrfe/audit              on PostgreSQL: a throwaway database only
 *                                                                   (it writes schema audit; DB_CONNECTION_STRING is never used)
 *
 * LEAVES (default 1,000,000) and BATCH (default 10,000 leaves per transaction) can be changed.
 */
import { createHash } from 'node:crypto';
import { createSequelize, ensureSchema } from '@lrfe/common';
import { TreeService } from '../src/tree.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { createSequelizeRepo } from '../src/repo/sequelize.js';
import { SCHEMA } from '../src/repo/models.js';
import { LEAF_TYPES, verifyConsistency, verifyInclusion } from '../src/mmr.js';

const LEAVES = Number(process.env.LEAVES || 1_000_000);
const BATCH = Number(process.env.BATCH || 10_000);
const PROOFS = 1000;
const seal = (n) => createHash('sha256').update(`seal ${n}`).digest('hex');
const key = (n) => `document-version:${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000:1`;
const secs = (t) => ((performance.now() - t) / 1000).toFixed(1);

let repo, sequelize;
if (process.env.BENCH_DB) {
    sequelize = createSequelize({ url: process.env.BENCH_DB, logging: false });
    repo = createSequelizeRepo(sequelize);
    await ensureSchema(sequelize, SCHEMA);
    await repo.sync();
} else repo = createMemoryRepo();
const tree = new TreeService({ repo });
const where = sequelize ? 'PostgreSQL' : 'memory';

const start = await tree.size();
console.log(`${where}: adding ${LEAVES.toLocaleString('en')} leaves in batches of ${BATCH.toLocaleString('en')} (tree has ${start})`);
const t0 = performance.now();
for (let n = start; n < start + LEAVES; n += BATCH) {
    const count = Math.min(BATCH, start + LEAVES - n);
    await tree.append(Array.from({ length: count }, (_, k) => ({ key: key(n + k), type: LEAF_TYPES.documentVersion, item: seal(n + k) })));
    if ((n - start + count) % (LEAVES / 10) < BATCH) console.log(`  ${(n - start + count).toLocaleString('en')} leaves, ${secs(t0)} s`);
}
const buildSeconds = secs(t0);
const size = await tree.size();
const { root } = await tree.root();

const t1 = performance.now();
let ok = 0, pathLength = 0;
for (let k = 0; k < PROOFS; k++) {
    const p = await tree.inclusionProof(key(Math.floor(Math.random() * size)));
    pathLength = Math.max(pathLength, p.path.length);
    if (verifyInclusion({ leafHash: p.leaf.hash, leafIndex: p.leaf.index, size: p.size, path: p.path, peaks: p.peaks, root })) ok++;
}
const proofMs = ((performance.now() - t1) / PROOFS).toFixed(2);
const t2 = performance.now();
const c = await tree.consistencyProof(Math.floor(size / 3), size);
const consistent = verifyConsistency(c);
const consistencyMs = (performance.now() - t2).toFixed(1);

console.log(`\n${where}, ${size.toLocaleString('en')} leaves:`);
console.log(`  build:        ${buildSeconds} s (${Math.round(LEAVES / buildSeconds).toLocaleString('en')} leaves/s)`);
console.log(`  inclusion:    ${PROOFS} random proofs made and checked, ${ok} valid, ${proofMs} ms each, path ${pathLength} hashes`);
console.log(`  consistency:  ${c.oldSize.toLocaleString('en')} → ${size.toLocaleString('en')}: ${consistent ? 'valid' : 'INVALID'}, ${consistencyMs} ms, ${c.paths.flat().length} hashes`);
if (sequelize) {
    const [rows] = await sequelize.query(`SELECT relname, pg_size_pretty(pg_table_size(c.oid)) AS "table", pg_size_pretty(pg_indexes_size(c.oid)) AS "indexes", pg_total_relation_size(c.oid) AS total
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${SCHEMA}' AND relname IN ('tree_node', 'tree_leaf') ORDER BY relname`);
    for (const r of rows) console.log(`  storage:      ${r.relname}: table ${r.table}, indexes ${r.indexes}`);
    const total = rows.reduce((a, r) => a + Number(r.total), 0);
    console.log(`  storage:      total ${(total / 2 ** 20).toFixed(0)} MB, ${(total / size).toFixed(0)} bytes per leaf`);
    await sequelize.close();
} else {
    console.log(`  memory:       heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MB`);
}
process.exit(ok === PROOFS && consistent ? 0 : 1);
