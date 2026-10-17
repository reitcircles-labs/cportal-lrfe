import {
  createEventBus,
  createSequelizeOutbox,
  createRevocationList,
  createSequelize,
  ensureSchema,
  env,
  envBool,
  envInt,
  envOneOf,
  healthCheck,
  signServiceToken,
  startService,
} from '@lrfe/common';
import {buildApp} from './app.js';
import {BpmEngine} from './engine/engine.js';
import {createConnectors} from './connectors/index.js';
import {deployAll} from './definitions/index.js';
import {createMemoryRepo} from './repo/memory.js';
import {createSequelizeRepo} from './repo/sequelize.js';
import {SCHEMA} from './repo/models.js';

const checks = [];
let repo;
let sequelize;
let outbox;

if (envOneOf('BPM_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
  // Dev only: processes and tasks are lost on restart.
  repo = createMemoryRepo();
} else {
  sequelize = createSequelize();
  repo = createSequelizeRepo(sequelize);
  // events are written in the same transaction as the change, then published (API-613)
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

// Connectors need a service token, and tokens are signed by the app's JWT plugin: the engine
// gets its connectors once the app exists.
const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'bpm',
  outbox,
});
const engine = new BpmEngine({repo, events});
const app = await buildApp({
  engine,
  jwtSecret: env('JWT_SECRET'),
  revocations: createRevocationList({events}),
  logger: {level: env('LOG_LEVEL', 'info')},
});
engine.connectors = createConnectors({
  urls: {
    edrms: env('EDRMS_URL', 'http://localhost:3502'),
    records: env('RECORDS_URL', 'http://localhost:3505'),
  },
  serviceToken: () => signServiceToken(app, 'bpm'),
});
checks.push(() => deployAll(engine, {log: m => app.log.info(m)}));

await startService(app, {
  port: envInt('PORT', 3503),
  checks,
  onClose: async () => {
    await events.close();
    await sequelize?.close();
  },
});
