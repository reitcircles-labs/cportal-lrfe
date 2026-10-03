import { createEventBus, createRevocationList, createSequelize, ensureSchema, env, envBool, envInt, envOneOf, healthCheck, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { IdentityService } from './identity.service.js';
import { createMailer } from './mailer.js';
import { createMemoryRepo } from './repo/memory.js';
import { createSequelizeRepo } from './repo/sequelize.js';
import { SCHEMA } from './repo/models.js';
import { seedIdentity } from './seed.js';
import { DEFAULT_OFFICES } from './catalogue.js';

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
checks.push(() => seedIdentity(repo, { admin, demoPassword: process.env.SEED_DEMO_PASSWORD || undefined, offices: DEFAULT_OFFICES }));

// Outgoing email (invitations): MAIL_TRANSPORT=smtp | file | none. See the identity README.
const mailer = createMailer({
    transport: envOneOf('MAIL_TRANSPORT', ['smtp', 'file', 'none'], 'none'),
    from: process.env.MAIL_FROM, replyTo: process.env.MAIL_REPLY_TO || undefined,
    host: process.env.SMTP_HOST, port: envInt('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === undefined ? undefined : envBool('SMTP_SECURE', false),
    user: process.env.SMTP_USER || undefined, password: process.env.SMTP_PASSWORD,
    // only for a relay on the same machine (e.g. a local Postfix on port 25 without TLS)
    requireTls: envBool('SMTP_REQUIRE_TLS', true),
    // this server's FQDN for EHLO, and 4 to always send over IPv4 (an IP-allowlisted relay)
    heloName: process.env.SMTP_HELO_NAME || undefined,
    family: process.env.SMTP_FAMILY ? envInt('SMTP_FAMILY', 4) : undefined,
    dir: env('MAIL_FILE_DIR', './tmp/mail')
});

const events = createEventBus({ driver: env('EVENT_BUS_DRIVER', 'log'), source: 'identity' });
const accessTtlSeconds = envInt('ACCESS_TOKEN_TTL_SECONDS', 900);
const service = new IdentityService({
    repo,
    mailer,
    events,
    config: {
        accessTtlSeconds,
        exposeInviteLinks: envBool('IDENTITY_EXPOSE_INVITE_LINKS', false),
        inviteUrlBase: env('IDENTITY_INVITE_URL_BASE', 'http://localhost:4200/#/invite')
    }
});

const app = await buildApp({
    service,
    jwtSecret: env('JWT_SECRET'),
    accessTtlSeconds,
    revocations: createRevocationList({ events }),
    cookie: {
        name: 'lrfe_rt',
        path: env('REFRESH_COOKIE_PATH', '/api/auth'),
        secure: envBool('COOKIE_SECURE', true)
    },
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3501), checks, onClose: async () => { await events.close(); await sequelize?.close(); } });

// Report the email setup once, without blocking start-up (a mail server outage must not stop sign-in).
if (!mailer.enabled) app.log.info('email: not configured (MAIL_TRANSPORT=none); invitation links are not emailed');
else if (!mailer.verify) app.log.info(`email: writing messages to ${mailer.describe}`);
else mailer.verify().then(
    () => app.log.info(`email: ${mailer.describe} accepted the connection and login`),
    (err) => app.log.warn(`email: ${mailer.describe} is not working (${err.code || err.message}); invitations will show the reason to the admin`)
);
