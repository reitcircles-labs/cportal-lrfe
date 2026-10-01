import { createEventBus, createSequelize, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { IdentityService } from './identity.service.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';
import { seedIdentity } from './seed.js';

const store = envOneOf('IDENTITY_STORE', ['postgres', 'memory'], 'postgres');
const checks = [];
let repo, sequelize;

if (store === 'memory') {
    // Dev only: no database, everything is lost on restart.
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

const admin = process.env.BOOTSTRAP_ADMIN_EMAIL
    ? { name: env('BOOTSTRAP_ADMIN_NAME', 'System administrator'), email: env('BOOTSTRAP_ADMIN_EMAIL'), password: env('BOOTSTRAP_ADMIN_PASSWORD') }
    : undefined;
checks.push(() => seedIdentity(repo, { admin, demoPassword: process.env.SEED_DEMO_PASSWORD || undefined }));

const service = new IdentityService({
    repo,
    events: createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'identity' }),
    config: {
        exposeInviteLinks: envBool('IDENTITY_EXPOSE_INVITE_LINKS', false),
        inviteUrlBase: env('IDENTITY_INVITE_URL_BASE', 'http://localhost:4200/#/invite')
    }
});

const app = await buildApp({
    service,
    jwtSecret: env('JWT_SECRET'),
    accessTtlSeconds: envInt('ACCESS_TOKEN_TTL_SECONDS', 900),
    cookie: {
        name: 'lrfe_rt',
        path: env('REFRESH_COOKIE_PATH', '/api/auth'),
        secure: envBool('COOKIE_SECURE', true)
    },
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3501), checks, onClose: () => sequelize?.close() });
