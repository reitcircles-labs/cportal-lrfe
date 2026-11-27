// Create the identity schema/tables (if missing) and seed the fixed catalogue into Postgres.
//   npm run seed -w @lrfe/identity
// Uses DB_CONNECTION_STRING, BOOTSTRAP_ADMIN_* and (optionally) SEED_DEMO_PASSWORD and
// SETUP_CODE_TTL_HOURS. Prints, once, a one-time setup code for each user it creates (the first
// administrator, the demo users): their first sign-in sets up the authenticator with it (CB-102).
import {createSequelize, ensureSchema, env, envPositiveInt} from '@lrfe/common';
import {createSequelizeRepo} from '../src/repo/sequelize.js';
import {SCHEMA} from '../src/repo/models.js';
import {seedIdentity} from '../src/seed.js';
import {DEFAULT_OFFICES} from '../src/catalogue.js';
import {
  DEFAULT_SETUP_CODE_TTL_HOURS,
  issueSetupCode,
  setupCodeLine,
} from '../src/setup-code.js';

const sequelize = createSequelize();
try {
  await ensureSchema(sequelize, SCHEMA);
  const repo = createSequelizeRepo(sequelize);
  await repo.sync();
  const admin = process.env.BOOTSTRAP_ADMIN_EMAIL
    ? {
        name: env('BOOTSTRAP_ADMIN_NAME', 'System administrator'),
        email: env('BOOTSTRAP_ADMIN_EMAIL'),
        password: env('BOOTSTRAP_ADMIN_PASSWORD'),
      }
    : undefined;
  const {created} = await seedIdentity(repo, {
    admin,
    demoPassword: process.env.SEED_DEMO_PASSWORD || undefined,
    offices: DEFAULT_OFFICES,
    log: m => console.log(m),
  });
  const ttlHours = envPositiveInt(
    'SETUP_CODE_TTL_HOURS',
    DEFAULT_SETUP_CODE_TTL_HOURS,
  );
  for (const user of created) {
    const {setupCode} = await issueSetupCode(repo, user.id, {
      now: new Date(),
      ttlHours,
    });
    console.log(setupCodeLine(user.email, setupCode, ttlHours));
  }
  console.log('identity seed complete');
} finally {
  await sequelize.close();
}
