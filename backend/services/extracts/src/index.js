import {
  createAnchoringClient,
  createEventBus,
  createRevocationList,
  createSequelize,
  createSequelizeOutbox,
  createServiceTokenSigner,
  ensureSchema,
  env,
  envBool,
  envInt,
  envOneOf,
  healthCheck,
  startService,
} from '@lrfe/common';
import {buildApp} from './app.js';
import {ExtractsService} from './extracts.service.js';
import {createRecordsClient} from './records-client.js';
import {createMemoryRepo} from './repo/memory.js';
import {createSequelizeRepo} from './repo/sequelize.js';
import {SCHEMA} from './repo/models.js';

const checks = [];
let repo;
let sequelize;
let outbox;

if (
  envOneOf('EXTRACTS_STORE', ['postgres', 'memory'], 'postgres') === 'memory'
) {
  // Dev only: lost on restart.
  repo = createMemoryRepo();
} else {
  sequelize = createSequelize();
  repo = createSequelizeRepo(sequelize);
  // events are written in the same transaction as the register row, then published (API-613)
  outbox = createSequelizeOutbox(sequelize, SCHEMA);
  checks.push(() => healthCheck(sequelize));
  if (envBool('DB_SYNC', false)) {
    // Dev/UAT convenience only. Replace with real migrations before production.
    checks.push(async () => {
      await ensureSchema(sequelize, SCHEMA);
      await repo.sync();
      await outbox.sync();
    });
  }
}

const jwtSecret = env('JWT_SECRET');
const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'extracts',
  outbox,
});
// the record's current version and its owners are read from land-records with an extracts service token
const records = createRecordsClient({
  baseUrl: env('RECORDS_URL', 'http://localhost:3505'),
  serviceToken: createServiceTokenSigner({
    secret: jwtSecret,
    service: 'extracts',
  }),
});
// whether a version is on the blockchain yet, from the audit service
const anchoring = createAnchoringClient({
  baseUrl: env('AUDIT_URL', 'http://localhost:3506'),
  serviceToken: createServiceTokenSigner({
    secret: jwtSecret,
    service: 'extracts',
  }),
});
const service = new ExtractsService({repo, events, records, anchoring});

const app = await buildApp({
  service,
  jwtSecret,
  revocations: createRevocationList({events}),
  logger: {level: env('LOG_LEVEL', 'info')},
});

await startService(app, {
  port: envInt('PORT', 3507),
  checks,
  onClose: async () => {
    await events.close();
    await sequelize?.close();
  },
});
