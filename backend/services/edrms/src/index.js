import {
  createAnchoringClient,
  createEventBus,
  createSequelizeOutbox,
  createRevocationList,
  createSequelize,
  createServiceTokenSigner,
  ensureSchema,
  env,
  envBool,
  envInt,
  envOneOf,
  healthCheck,
  startService,
} from '@lrfe/common';
import {createEngine, loadCountryPack} from '@lrfe/search-index';
import {buildApp} from './app.js';
import {EdrmsService} from './edrms.service.js';
import {createIndexSearch} from './index-search.js';
import {createMemoryRepo} from './repo/memory.js';
import {createSequelizeRepo} from './repo/sequelize.js';
import {SCHEMA} from './repo/models.js';
import {createStoreFromEnv} from './storage/index.js';

const checks = [];
let repo;
let sequelize;
let outbox;

if (envOneOf('EDRMS_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
  // Dev only: metadata lost on restart.
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

const store = createStoreFromEnv();
// With EDRMS_ENCRYPTION=bao, start only once the vault answers (waits up to a minute while it starts)
if (store.keyring?.check) checks.push(() => store.keyring.check());

const jwtSecret = env('JWT_SECRET');
const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'edrms',
  outbox,
});
// document search: the database (the default), or the search index (API-803)
let indexSearch = null;
if (
  envOneOf('EDRMS_SEARCH', ['postgres', 'opensearch'], 'postgres') ===
  'opensearch'
) {
  const url = env('OPENSEARCH_URL', '');
  if (!url) throw new Error('EDRMS_SEARCH=opensearch needs OPENSEARCH_URL');
  indexSearch = createIndexSearch({
    request: createEngine({url, loginDir: env('OPENSEARCH_LOGIN_DIR', '')}),
    // the same pack the search service builds the index with
    pack: loadCountryPack(env('EDRMS_COUNTRY_CODE', 'NA')),
  });
}

const service = new EdrmsService({
  repo,
  indexSearch,
  store,
  events,
  // each version's anchoring status, from the audit service (API-658; best effort)
  anchoring: createAnchoringClient({
    baseUrl: env('AUDIT_URL', 'http://localhost:3506'),
    serviceToken: createServiceTokenSigner({
      secret: jwtSecret,
      service: 'edrms',
    }),
  }),
  config: {
    country: env('EDRMS_COUNTRY_CODE', 'NA'),
    registry: env('EDRMS_REGISTRY_CODE', 'WDH'),
    urlTtlSeconds: envInt('EDRMS_URL_TTL_SECONDS', 300),
  },
});

const app = await buildApp({
  service,
  jwtSecret,
  contentUrl: {
    base: env('EDRMS_CONTENT_URL_BASE', '/api/document-content'),
    secret: env('EDRMS_CONTENT_URL_SECRET', jwtSecret),
  },
  maxFileBytes: envInt('EDRMS_MAX_FILE_MB', 200) * 1024 * 1024,
  revocations: createRevocationList({events}),
  logger: {level: env('LOG_LEVEL', 'info')},
});

await startService(app, {
  port: envInt('PORT', 3502),
  checks,
  onClose: async () => {
    await events.close();
    await sequelize?.close();
  },
});
