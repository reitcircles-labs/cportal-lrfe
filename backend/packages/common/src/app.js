import Fastify from 'fastify';
import { errorHandler } from './errors.js';
import { env } from './config.js';

/** Fastify instance with the shared error handler and a public GET /health. */
export function createBaseApp({ name, ...fastifyOptions }) {
    if (!name) throw new Error('createBaseApp: `name` is required');
    const app = Fastify({ logger: false, ...fastifyOptions });
    app.setErrorHandler(errorHandler);
    app.get('/health', async () => ({ status: 'ok', service: name }));
    return app;
}

/**
 * Boot a service: optional fail-fast checks (e.g. DB health), listen, and close cleanly on
 * SIGTERM/SIGINT (Cloud Run sends SIGTERM before stopping an instance).
 *
 * HOST defaults to 0.0.0.0 (all interfaces — what containers need). On a developer machine
 * with a public address, set HOST=127.0.0.1 so the services are not reachable from outside.
 */
export async function startService(app, { port, host = env('HOST', '0.0.0.0'), checks = [], onClose } = {}) {
    for (const check of checks) {
        try {
            await check();
        } catch (err) {
            app.log.fatal({ err }, 'startup check failed');
            process.exit(1);
        }
    }
    const shutdown = async (signal) => {
        app.log.info({ signal }, 'shutting down');
        try {
            await app.close();
            if (onClose) await onClose();
        } finally {
            process.exit(0);
        }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await app.listen({ port, host });
}
