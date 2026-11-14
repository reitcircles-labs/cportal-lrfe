import {
  createEventBus,
  createRevocationList,
  createSequelize,
  createSequelizeOutbox,
  ensureSchema,
  env,
  envBool,
  envInt,
  envOneOf,
  healthCheck,
  startService,
} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {buildApp} from './app.js';
import {ShippingRecordsService} from './records.service.js';
import {TitleService} from './title.service.js';
import {createMemoryRepo} from './repo/memory.js';
import {createSequelizeRepo} from './repo/sequelize.js';
import {SCHEMA} from './repo/models.js';

// the B/L formats on in this install (LRFE_BL_FORMATS): an unknown name stops the start here
const formats = formatsFromSettings(process.env);
// the B/L title modules on in this install (LRFE_BL_MODULES): an unknown name or a module without
// the one it needs stops the start here
const modules = modulesFromSettings(process.env);

const checks = [];
let repo;
let sequelize;
let outbox;

if (
  envOneOf('RECORDS_STORE', ['postgres', 'memory'], 'postgres') === 'memory'
) {
  // Dev only: lost on restart.
  repo = createMemoryRepo();
} else {
  sequelize = createSequelize();
  repo = createSequelizeRepo(sequelize);
  // events are written in the same transaction as the change, then published
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

const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'shipping-records',
  outbox,
});
const service = new ShippingRecordsService({repo, events, formats});
const titles = new TitleService({repo, events, modules});

const app = await buildApp({
  service,
  titles,
  jwtSecret: env('JWT_SECRET'),
  revocations: createRevocationList({events}),
  logger: {level: env('LOG_LEVEL', 'info')},
});

await startService(app, {
  port: envInt('PORT', 3509),
  checks,
  onClose: async () => {
    await events.close();
    await sequelize?.close();
  },
});
