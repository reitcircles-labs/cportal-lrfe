import { createEventBus, createRevocationList, createSequelize, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { TrailService } from './trail.service.js';
import { TreeService } from './tree.service.js';
import { cardanoFromEnv } from './cardano/adapter.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';

const checks = [];
let repo, sequelize;

if (envOneOf('AUDIT_STORE', ['postgres', 'memory'], 'postgres') === 'memory') {
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

const events = createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'audit' });
const service = new TrailService({ repo });

const app = await buildApp({
    service,
    jwtSecret: env('JWT_SECRET'),
    revocations: createRevocationList({ events }),
    logger: { level: env('LOG_LEVEL', 'info') }
});

const tree = new TreeService({ repo, logger: app.log });
// anchoring on Cardano (README.md section 3), when CARDANO_PROVIDER is set; a wrong setting stops the start
const cardano = cardanoFromEnv(process.env, { logger: app.log, events });

await startService(app, { port: envInt('PORT', 3506), checks, onClose: async () => { await events.close(); await sequelize?.close(); } });

// every durable event of every service becomes one trail entry (README.md section 1), and a
// committed land record version or a filed document version also a leaf of the tree (section 2).
// Acknowledged once both are written, so an event published while the audit service is down is
// recorded when it is back; both steps skip what they already have. Started once the tables exist.
events.consume('>', async (event) => {
    await service.record(event);
    await tree.fromEvent(event);
}, { durable: 'audit-trail' });

// the wallet at start: its address, and a warning when it is low (an outage is only logged)
if (cardano) {
    cardano.address()
        .then(async (address) => app.log.info({ network: cardano.network, provider: cardano.provider, address, ...(await cardano.balance()) }, 'audit: anchoring wallet'))
        .catch(err => app.log.warn({ err: err.message, code: err.code }, 'audit: the anchoring wallet could not be read yet'));
}
