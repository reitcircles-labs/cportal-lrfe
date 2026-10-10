import { createEventBus, createSequelizeOutbox, createRevocationList, createSequelize, createServiceTokenSigner, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { createEdrmsClient } from './edrms-client.js';
import { createBpmClient } from './bpm-client.js';
import { buildApp } from './app.js';
import { RecordsService } from './records.service.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';

const checks = [];
let repo, sequelize, outbox;

if (envOneOf('RECORDS_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
    // Dev only: lost on restart.
    repo = createMemoryRepo();
} else {
    sequelize = createSequelize();
    repo = createSequelizeRepo(sequelize);
    // events are written in the same transaction as the change, then published (API-613)
    outbox = createSequelizeOutbox(sequelize, SCHEMA);
    checks.push(() => healthCheck(sequelize));
    if (envBool('DB_SYNC', false)) {
        // Dev/UAT convenience only. Replace with real migrations before production.
        checks.push(async () => { await ensureSchema(sequelize, SCHEMA); await repo.sync(); await outbox.sync(); });
    }
}

const jwtSecret = env('JWT_SECRET');
const events = createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'land-records', outbox });
// documents are read from edrms with a land-records service token
const edrms = createEdrmsClient({ baseUrl: env('EDRMS_URL', 'http://localhost:3502'), serviceToken: createServiceTokenSigner({ secret: jwtSecret, service: 'land-records' }) });
// a submitted version is reviewed in the bpm process "land-record-review"
const bpm = createBpmClient({ baseUrl: env('BPM_URL', 'http://localhost:3503'), serviceToken: createServiceTokenSigner({ secret: jwtSecret, service: 'land-records' }) });
const service = new RecordsService({ repo, events, edrms, bpm, config: { country: env('RECORDS_COUNTRY_CODE', 'NA') } });

// a correction filed in edrms flags every record that pins an older version of the document; a
// durable consumer (API-613), so a correction approved while land-records is down is not missed
events.consume('edrms.document.amended', (event) => service.onDocumentAmended(event.data), { durable: 'land-records-document-amended' });

const app = await buildApp({
    service,
    jwtSecret,
    revocations: createRevocationList({ events }),
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3505), checks, onClose: async () => { await events.close(); await sequelize?.close(); } });
