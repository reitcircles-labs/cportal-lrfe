#!/usr/bin/env node
/**
 * The one-time backfill (API-669): seals recorded before the audit service started go into its tree.
 * Run it once on a new installation before the first anchoring (the service also runs it by itself
 * when its tree is empty and anchoring is on). Safe to run again: it adds only what is missing.
 *
 *   npm run audit:backfill            (from backend/; uses services/audit/.env)
 *
 * Needs land-records (RECORDS_URL) and edrms (EDRMS_URL) running, and the shared JWT_SECRET.
 */
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) {
  for (const [k, v] of Object.entries(dotenv.parse(readFileSync(envFile)))) {
    process.env[k] ??= v;
  }
}
const {createSequelize, createServiceTokenSigner, ensureSchema, env, envOneOf} =
  await import('@lrfe/common');
const {TrailService} = await import('../src/trail.service.js');
const {TreeService} = await import('../src/tree.service.js');
const {BackfillService, createSealSources} =
  await import('../src/backfill.service.js');
const {createSequelizeRepo} = await import('../src/repo/sequelize.js');
const {SCHEMA} = await import('../src/repo/models.js');

if (envOneOf('AUDIT_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
  console.error(
    'AUDIT_STORE=memory: a backfill would be lost at once. Run it against PostgreSQL.',
  );
  process.exit(2);
}
const sequelize = createSequelize();
try {
  const repo = createSequelizeRepo(sequelize);
  await ensureSchema(sequelize, SCHEMA);
  await repo.sync();
  const quiet = {
    info() {},
    warn: (o, m) => console.warn(m),
    error: (o, m) => console.error(m),
  };
  const before = await repo.tree.leafCount();
  const result = await new BackfillService({
    trail: new TrailService({repo, logger: quiet}),
    tree: new TreeService({repo, logger: quiet}),
    logger: quiet,
    sources: createSealSources({
      recordsUrl: env('RECORDS_URL', 'http://localhost:3505'),
      edrmsUrl: env('EDRMS_URL', 'http://localhost:3502'),
      serviceToken: createServiceTokenSigner({
        secret: env('JWT_SECRET'),
        service: 'audit',
      }),
    }),
  }).run();
  console.log(
    `Backfill: ${result.records} land record versions and ${result.documents} document versions read; ${result.added} added to the tree, ${result.alreadyInTree} were already in it (tree: ${before} → ${await repo.tree.leafCount()} leaves, ${result.seconds} s).`,
  );
} catch (err) {
  console.error(`Backfill failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
