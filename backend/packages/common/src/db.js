import pg from 'pg';
import { Sequelize } from 'sequelize';
import { env, envInt } from './config.js';

/**
 * One Sequelize instance per service. The constructor never touches the network (it connects
 * lazily), so call healthCheck() at boot to fail fast on a bad connection string.
 */
export function createSequelize({ url = env('DB_CONNECTION_STRING'), poolSize = envInt('DB_POOL_SIZE', 5), logging = false } = {}) {
    return new Sequelize(url, {
        dialect: 'postgres',
        dialectModule: pg,
        logging,
        pool: { max: poolSize, min: 0, acquire: 30000, idle: 10000 }
    });
}

export async function healthCheck(sequelize) {
    try {
        await sequelize.authenticate();
    } catch (error) {
        throw new Error(`Database connection failed: ${error.message}`, { cause: error });
    }
}

/**
 * Create the service's own Postgres schema if missing. Each service owns exactly one schema.
 * Checks first: Postgres refuses CREATE SCHEMA IF NOT EXISTS without the CREATE privilege even
 * when the schema already exists, and a DBA may have pre-created it for a less privileged user.
 */
export async function ensureSchema(sequelize, schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name "${schema}"`);
    const [rows] = await sequelize.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = :schema', { replacements: { schema } });
    if (rows.length) return;
    try {
        await sequelize.query(`CREATE SCHEMA "${schema}"`);
    } catch (err) {
        if (err.original?.code === '42501') {
            throw new Error(`Schema "${schema}" does not exist and this database user may not create it. ` +
                `Ask the database owner to run: CREATE SCHEMA ${schema} AUTHORIZATION <this user>;`, { cause: err });
        }
        throw err;
    }
}
