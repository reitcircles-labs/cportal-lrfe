import {resolve} from 'node:path';
import {
  createEventBus,
  createSequelizeOutbox,
  createRevocationList,
  createSequelize,
  ensureSchema,
  env,
  envBool,
  envInt,
  envOneOf,
  envPositiveInt,
  healthCheck,
  orgFromEnv,
  startService,
} from '@lrfe/common';
import {buildApp} from './app.js';
import {DEFAULT_CODE_GUARD_LIMITS} from './code-guard.js';
import {IdentityService} from './identity.service.js';
import {createMailer} from './mailer.js';
import {createMemoryRepo} from './repo/memory.js';
import {createSequelizeRepo} from './repo/sequelize.js';
import {SCHEMA} from './repo/models.js';
import {seedIdentity} from './seed.js';
import {
  DEFAULT_SETUP_CODE_TTL_HOURS,
  appendSetupCodeFile,
  issueSetupCode,
  setupCodeLine,
} from './setup-code.js';
import {CATALOGUE, DEFAULT_OFFICES, parseOffices} from './catalogue.js';

const store = envOneOf('IDENTITY_STORE', ['postgres', 'memory'], 'postgres');
const checks = [];
let repo;
let sequelize;
let outbox;

if (store === 'memory') {
  // Dev only: no database, everything is lost on restart.
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

const admin = process.env.BOOTSTRAP_ADMIN_EMAIL
  ? {
      name: env('BOOTSTRAP_ADMIN_NAME', 'System administrator'),
      email: env('BOOTSTRAP_ADMIN_EMAIL'),
      password: env('BOOTSTRAP_ADMIN_PASSWORD'),
    }
  : undefined;
// The offices created on an empty database: the site's (IDENTITY_OFFICES; set but empty: none), or
// the domain pack's when not set at all (development)
const offices =
  process.env.IDENTITY_OFFICES === undefined
    ? DEFAULT_OFFICES
    : parseOffices(process.env.IDENTITY_OFFICES, 'IDENTITY_OFFICES');
// How long an administrator's one-time setup code works (CB-102).
const setupCodeTtlHours = envPositiveInt(
  'SETUP_CODE_TTL_HOURS',
  DEFAULT_SETUP_CODE_TTL_HOURS,
);
// Where the setup codes given at start are written, readable only by identity's user (CB-102).
const setupCodeFile = resolve(env('SETUP_CODE_FILE', './tmp/setup-codes.txt'));
// End-to-end tests only: the demo users get their authenticators directly (CB-102).
const demoMfaKey = process.env.SEED_DEMO_MFA_KEY || undefined;
if (demoMfaKey && process.env.NODE_ENV !== 'test') {
  throw new Error(
    'SEED_DEMO_MFA_KEY is only for the end-to-end tests (NODE_ENV=test)',
  );
}
checks.push(async () => {
  const {created} = await seedIdentity(repo, {
    admin,
    demoPassword: process.env.SEED_DEMO_PASSWORD || undefined,
    demoMfaKey,
    offices,
  });
  // The first administrator and the demo users set up their authenticator with a one-time setup
  // code, written to the setup-code file only: never to the console or the service's log, which
  // say only where the file is (CB-102, design decision 9).
  if (created.length === 0) {
    return;
  }
  const lines = [];
  for (const user of created) {
    const {setupCode} = await issueSetupCode(repo, user.id, {
      now: new Date(),
      ttlHours: setupCodeTtlHours,
    });
    lines.push(setupCodeLine(user.email, setupCode, setupCodeTtlHours));
  }
  try {
    await appendSetupCodeFile(setupCodeFile, lines);
    app.log.info(
      `setup codes for ${lines.length} new user(s) written to ${setupCodeFile}`,
    );
  } catch (err) {
    // The codes are stored already; starting again would not give them twice. The way back is
    // the command-line reset (README), so identity starts and says what went wrong.
    app.log.error(
      `setup codes for ${lines.length} new user(s) could not be written to ${setupCodeFile} ` +
        `(${err.code || err.message}); give new ones with scripts/reset-password.js --reset-mfa`,
    );
  }
});

// Outgoing email (invitations): MAIL_TRANSPORT=smtp | file | none. See the identity README.
const mailer = createMailer({
  transport: envOneOf('MAIL_TRANSPORT', ['smtp', 'file', 'none'], 'none'),
  from: process.env.MAIL_FROM,
  replyTo: process.env.MAIL_REPLY_TO || undefined,
  host: process.env.SMTP_HOST,
  port: envInt('SMTP_PORT', 587),
  secure:
    process.env.SMTP_SECURE === undefined
      ? undefined
      : envBool('SMTP_SECURE', false),
  user: process.env.SMTP_USER || undefined,
  password: process.env.SMTP_PASSWORD,
  // only for a relay on the same machine (e.g. a local Postfix on port 25 without TLS)
  requireTls: envBool('SMTP_REQUIRE_TLS', true),
  // this server's FQDN for EHLO, and 4 to always send over IPv4 (an IP-allowlisted relay)
  heloName: process.env.SMTP_HELO_NAME || undefined,
  family: process.env.SMTP_FAMILY ? envInt('SMTP_FAMILY', 4) : undefined,
  dir: env('MAIL_FILE_DIR', './tmp/mail'),
});

const events = createEventBus({
  driver: env('EVENT_BUS_DRIVER', 'log'),
  source: 'identity',
  outbox,
});
const accessTtlSeconds = envInt('ACCESS_TOKEN_TTL_SECONDS', 900);
// Limits on guessing authenticator codes (CB-101), counted in this process's memory: a restart
// clears the counts. A value that is not a whole number above 0 stops identity here.
const codeGuard = {
  maxWrongCodesPerChallenge: envPositiveInt(
    'MFA_MAX_WRONG_CODES_PER_CHALLENGE',
    DEFAULT_CODE_GUARD_LIMITS.maxWrongCodesPerChallenge,
  ),
  lockoutWrongCodes: envPositiveInt(
    'MFA_LOCKOUT_WRONG_CODES',
    DEFAULT_CODE_GUARD_LIMITS.lockoutWrongCodes,
  ),
  lockoutWindowMinutes: envPositiveInt(
    'MFA_LOCKOUT_WINDOW_MINUTES',
    DEFAULT_CODE_GUARD_LIMITS.lockoutWindowMinutes,
  ),
  lockoutMinutes: envPositiveInt(
    'MFA_LOCKOUT_MINUTES',
    DEFAULT_CODE_GUARD_LIMITS.lockoutMinutes,
  ),
};
const service = new IdentityService({
  repo,
  mailer,
  events,
  config: {
    accessTtlSeconds,
    codeGuard,
    setupCodeTtlHours,
    // end-to-end tests only (NODE_ENV=test): the demo users it seeded may reuse a code (CB-104)
    demoMfaKey,
    // in invitation emails and as the authenticator app's entry (API-712), the pack's when unset
    issuer: orgFromEnv(process.env, CATALOGUE.organisation).fullName,
    exposeInviteLinks: envBool('IDENTITY_EXPOSE_INVITE_LINKS', false),
    inviteUrlBase: env(
      'IDENTITY_INVITE_URL_BASE',
      'http://localhost:4200/#/invite',
    ),
  },
});

const app = await buildApp({
  service,
  jwtSecret: env('JWT_SECRET'),
  accessTtlSeconds,
  revocations: createRevocationList({events}),
  cookie: {
    name: 'lrfe_rt',
    path: env('REFRESH_COOKIE_PATH', '/api/auth'),
    secure: envBool('COOKIE_SECURE', true),
  },
  logger: {level: env('LOG_LEVEL', 'info')},
});

await startService(app, {
  port: envInt('PORT', 3501),
  checks,
  onClose: async () => {
    await events.close();
    await sequelize?.close();
  },
});

// Report the email setup once, without blocking start-up (a mail server outage must not stop sign-in).
if (!mailer.enabled) {
  app.log.info(
    'email: not configured (MAIL_TRANSPORT=none); invitation links are not emailed',
  );
} else if (!mailer.verify) {
  app.log.info(`email: writing messages to ${mailer.describe}`);
} else {
  mailer.verify().then(
    () =>
      app.log.info(
        `email: ${mailer.describe} accepted the connection and login`,
      ),
    err =>
      app.log.warn(
        `email: ${mailer.describe} is not working (${err.code || err.message}); invitations will show the reason to the admin`,
      ),
  );
}
