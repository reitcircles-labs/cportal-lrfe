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
import {ExtractCheck} from './public-check.js';
import {createPdfStoreFromEnv} from './pdf-store.js';
import {createProofClient} from './proof-client.js';
import {createRecordsClient} from './records-client.js';
import {sealerFromEnv} from './seal/sealers.js';
import {extractSettingsFromEnv} from './settings.js';
import {createVersionCheckClient} from './version-check-client.js';
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
// the PDF's texts that belong to the site: the organisation, the check page, the legal wording
const settings = extractSettingsFromEnv();
// the organisation seal: its key in OpenBao (EXTRACTS_SEAL=bao), a test seal outside production
const sealer = await sealerFromEnv({name: settings.org.name});
// the sealed PDFs; with EXTRACTS_ENCRYPTION=bao, start only once the vault answers (as edrms)
const files = createPdfStoreFromEnv();
if (files.keyring?.check) checks.push(() => files.keyring.check());
const service = new ExtractsService({
  repo,
  events,
  records,
  anchoring,
  // the version's proof, attached inside the PDF
  proofs: createProofClient({
    baseUrl: env('AUDIT_URL', 'http://localhost:3506'),
    serviceToken: createServiceTokenSigner({
      secret: jwtSecret,
      service: 'extracts',
    }),
  }),
  files,
  sealer,
  settings,
});
// the public check: the version checked now by the audit service (seal, tree, blockchain)
const check = new ExtractCheck({
  repo,
  records,
  versions: createVersionCheckClient({
    baseUrl: env('AUDIT_URL', 'http://localhost:3506'),
    serviceToken: createServiceTokenSigner({
      secret: jwtSecret,
      service: 'extracts',
    }),
  }),
});

const app = await buildApp({
  service,
  check,
  jwtSecret,
  revocations: createRevocationList({events}),
  logger: {level: env('LOG_LEVEL', 'info')},
});

if (!sealer) {
  app.log.warn(
    'No organisation seal is set up (EXTRACTS_SEAL): extracts cannot be issued until it is',
  );
} else if (sealer.kind === 'test') {
  app.log.warn(
    'Extracts are sealed with a test seal made at start: for development and tests only',
  );
}

await startService(app, {
  port: envInt('PORT', 3507),
  checks,
  onClose: async () => {
    await events.close();
    await sequelize?.close();
  },
});
