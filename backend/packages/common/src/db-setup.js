import { createSequelize, ensureSchema } from './db.js';
import { createSequelizeOutbox } from './outbox.js';

/** @param {number} ms */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Errors waiting cannot fix: a wrong user or password (SQLSTATE class 28) or no such database
 * (3D000). Everything else, such as a refused connection or a server starting up, may pass.
 * @param {!Error} error
 * @return {boolean}
 */
function isPermanent(error) {
    const code = error.original?.code ?? '';
    return code.startsWith('28') || code === '3D000';
}

/**
 * Wait until the database answers: a database container may still be starting, a server
 * restarting. Tries every `intervalMs` for up to `timeoutMs`, then fails with the last error; only
 * a wrong user, password or database name (isPermanent) fails at once.
 * @param {!Sequelize} sequelize
 * @param {{timeoutMs?: number, intervalMs?: number, onRetry?: function(!Error): void}=} options
 *     onRetry is called with the error before each new try
 * @return {!Promise<void>}
 */
export async function waitForDatabase(sequelize, { timeoutMs = 120_000, intervalMs = 2_000, onRetry = () => {} } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await sequelize.authenticate();
            return;
        } catch (error) {
            if (isPermanent(error) || Date.now() + intervalMs > deadline) {
                throw new Error(`Database connection failed: ${error.message}`, { cause: error });
            }
            onRetry(error);
            await sleep(intervalMs);
        }
    }
}

/**
 * Set up the schema and tables of every service, one after the other, before any service starts
 * (API-711). First waits for the database to answer. Then, for each service, on its own connection:
 * its schema, then the same idempotent steps the service runs on start with DB_SYNC (its tables,
 * the columns added since, its outbox). Run again on a set-up database, it only adds what is missing.
 * @param {!Array<{name: string, schema: string, createRepo: function(!Sequelize): {sync: function(): !Promise<void>}}>} services
 * @param {{connect?: function(): !Sequelize, wait?: {timeoutMs?: number, intervalMs?: number}, log?: function(string): void}=} options
 *     connect: a new Sequelize instance (one connection is enough); wait: the limits of
 *     waitForDatabase; log: progress messages
 * @return {!Promise<void>}
 */
export async function setUpDatabase(services, { connect = () => createSequelize({ poolSize: 1 }), wait = {}, log = () => {} } = {}) {
    const probe = connect();
    let lastRetry = '';
    try {
        await waitForDatabase(probe, {
            ...wait,
            // the same message every few seconds is logged once
            onRetry: (error) => {
                if (error.message !== lastRetry) log(`waiting for the database: ${error.message}`);
                lastRetry = error.message;
            }
        });
    } finally {
        await probe.close();
    }

    for (const { name, schema, createRepo } of services) {
        const sequelize = connect();
        try {
            const repo = createRepo(sequelize);
            const outbox = createSequelizeOutbox(sequelize, schema);
            await ensureSchema(sequelize, schema);
            await repo.sync();
            await outbox.sync();
            log(`${name}: schema "${schema}" ready`);
        } catch (error) {
            throw new Error(`${name}: ${error.message}`, { cause: error });
        } finally {
            await sequelize.close();
        }
    }
}
