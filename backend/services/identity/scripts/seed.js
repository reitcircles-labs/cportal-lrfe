// Create the identity schema/tables (if missing) and seed the fixed catalogue into Postgres.
//   npm run seed -w @lrfe/identity
// Uses DB_CONNECTION_STRING, BOOTSTRAP_ADMIN_* and (optionally) SEED_DEMO_PASSWORD.
import { createSequelize, ensureSchema, env } from '@lrfe/common';
import { createSequelizeRepo } from '../src/repo/sequelize.js';
import { SCHEMA } from '../src/repo/models.js';
import { seedIdentity } from '../src/seed.js';

const sequelize = createSequelize();
try {
    await ensureSchema(sequelize, SCHEMA);
    const repo = createSequelizeRepo(sequelize);
    await repo.sync();
    const admin = process.env.BOOTSTRAP_ADMIN_EMAIL
        ? { name: env('BOOTSTRAP_ADMIN_NAME', 'System administrator'), email: env('BOOTSTRAP_ADMIN_EMAIL'), password: env('BOOTSTRAP_ADMIN_PASSWORD') }
        : undefined;
    await seedIdentity(repo, { admin, demoPassword: process.env.SEED_DEMO_PASSWORD || undefined, log: (m) => console.log(m) });
    console.log('identity seed complete');
} finally {
    await sequelize.close();
}
