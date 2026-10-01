import { createEventBus, createSequelize, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { EdrmsService } from './edrms.service.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';
import { createStoreFromEnv } from './storage/index.js';

const checks = [];
let repo, sequelize;

if (envOneOf('EDRMS_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
    // Dev only: metadata lost on restart.
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

const jwtSecret = env('JWT_SECRET');
const service = new EdrmsService({
    repo,
    store: createStoreFromEnv(),
    events: createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'edrms' }),
    config: {
        country: env('EDRMS_COUNTRY_CODE', 'NA'),
        registry: env('EDRMS_REGISTRY_CODE', 'WDH'),
        urlTtlSeconds: envInt('EDRMS_URL_TTL_SECONDS', 300)
    }
});

const app = await buildApp({
    service,
    jwtSecret,
    contentUrl: { base: env('EDRMS_CONTENT_URL_BASE', '/api/document-content'), secret: env('EDRMS_CONTENT_URL_SECRET', jwtSecret) },
    maxFileBytes: envInt('EDRMS_MAX_FILE_MB', 200) * 1024 * 1024,
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3502), checks, onClose: () => sequelize?.close() });
