import { createEventBus, createSequelize, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, signServiceToken, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { BpmEngine } from './engine/engine.js';
import { createConnectors } from './connectors/index.js';
import { deployAll } from './definitions/index.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';

const checks = [];
let repo, sequelize;

if (envOneOf('BPM_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
    // Dev only: processes and tasks are lost on restart.
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

// Connectors need a service token, and tokens are signed by the app's JWT plugin: the engine
// gets its connectors once the app exists.
const engine = new BpmEngine({ repo, events: createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'bpm' }) });
const app = await buildApp({ engine, jwtSecret: env('JWT_SECRET'), logger: { level: env('LOG_LEVEL', 'info') } });
engine.connectors = createConnectors({
    urls: { edrms: env('EDRMS_URL', 'http://localhost:3502') },
    serviceToken: () => signServiceToken(app, 'bpm')
});
checks.push(() => deployAll(engine, { log: (m) => app.log.info(m) }));

await startService(app, { port: envInt('PORT', 3503), checks, onClose: () => sequelize?.close() });
