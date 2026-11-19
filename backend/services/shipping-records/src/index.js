import {
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
  signerFromEnv,
  startService,
} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {
  maxSplitFromSettings,
  modulesFromSettings,
} from '@lrfe/domain-shipping/title';
import {buildApp} from './app.js';
import {
  DEFAULT_CARRIER_LIST_FILE,
  loadCarrierList,
} from '@lrfe/domain-shipping/carriers';
import {
  DEFAULT_PORT_LIST_FILE,
  loadPortList,
} from '@lrfe/domain-shipping/ports';
import {createAuditClient} from './audit-client.js';
import {createIdentityClient} from './identity-client.js';
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
// maximum new B/Ls per split (LRFE_BL_SPLIT_MAX, default 10, CB-73)
const maxSplitChildren = maxSplitFromSettings(process.env);

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
const jwtSecret = env('JWT_SECRET');
// the port list (CB-63): the pack's UN/LOCODE sea ports, or the install's own file (PORT_LIST_FILE)
const ports = loadPortList(env('PORT_LIST_FILE', '') || DEFAULT_PORT_LIST_FILE);
// the SMDG carrier code list (CB-68): the pack's SMDG liner codes, or CARRIER_LIST_FILE
const carriers = loadCarrierList(
  env('CARRIER_LIST_FILE', '') || DEFAULT_CARRIER_LIST_FILE,
);
const service = new ShippingRecordsService({
  repo,
  events,
  formats,
  ports,
  carriers,
});
// the trail-entry proof of a chain entry's event, from the audit service (CB-33): title proofs
const audit = createAuditClient({
  baseUrl: env('AUDIT_URL', 'http://localhost:3506'),
  serviceToken: createServiceTokenSigner({
    secret: jwtSecret,
    service: 'shipping-records',
  }),
});
// the platform signer of the chain of title (TITLE_SIGNER, README.md "Settings"): none in
// production without the key store, and title commands are then refused (503)
const signer = await signerFromEnv(process.env);
// whether an organisation a B/L goes to is registered and active, from identity (CB-34); in
// production IDENTITY_URL must be set, else the start stops here
const identityUrl =
  process.env.NODE_ENV === 'production'
    ? env('IDENTITY_URL')
    : env('IDENTITY_URL', 'http://localhost:3501');
const organisations = createIdentityClient({
  baseUrl: identityUrl,
  serviceToken: createServiceTokenSigner({
    secret: jwtSecret,
    service: 'shipping-records',
  }),
});
const titles = new TitleService({
  repo,
  events,
  modules,
  formats,
  signer,
  audit,
  organisations,
  ports,
  carriers,
  maxSplitChildren,
});

const app = await buildApp({
  service,
  titles,
  jwtSecret,
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
