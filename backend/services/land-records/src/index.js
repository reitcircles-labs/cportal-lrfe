import { createEventBus, createRevocationList, createSequelize, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { RecordsService } from './records.service.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';

const checks = [];
let repo, sequelize;

if (envOneOf('RECORDS_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
    // Dev only: lost on restart.
    repo = createMemoryRepo();
} else {
    sequelize = createSequelize();
    repo = createSequelizeRepo(sequelize);
    checks.push(() => healthCheck(sequelize));
    if (envBool('DB_SYNC', false)) {
        // Dev/UAT convenience only. Replace with real migrations before production.
        checks.push(async () => { await ensureSchema(sequelize, SCHEMA); await repo.sync(); });
    }
}

const events = createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'land-records' });
const service = new RecordsService({ repo, events, config: { country: env('RECORDS_COUNTRY_CODE', 'NA') } });

const app = await buildApp({
    service,
    jwtSecret: env('JWT_SECRET'),
    revocations: createRevocationList({ events }),
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3505), checks, onClose: async () => { await events.close(); await sequelize?.close(); } });
