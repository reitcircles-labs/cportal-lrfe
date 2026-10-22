import Fastify from 'fastify';
import {errorHandler} from './errors.js';
import {env} from './config.js';

/** The token in the path of the public check of an extract (API-693): what follows /public/extracts/. */
const PUBLIC_EXTRACT_TOKEN = /(\/public\/extracts\/)[^/?#]+/;

/** A request path as the logs show it: the token of an extract's public check replaced. */
export const redactUrl = url =>
  String(url ?? '').replace(PUBLIC_EXTRACT_TOKEN, '$1<token>');

/** Fastify's own request serializer, with the path through redactUrl. */
function requestForLog(req) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Fastify instance with the shared error handler and a public GET /health.
 * `onRoute(routeOptions)` sees every route as it is registered (the API docs generator uses it).
 * A `logger` given as options logs request paths without the token of an extract's public check:
 * the token is what lets anyone check the extract.
 */
export function createBaseApp({name, onRoute, logger, ...fastifyOptions}) {
  if (!name) throw new Error('createBaseApp: `name` is required');
  const app = Fastify({
    logger:
      logger && typeof logger === 'object'
        ? {...logger, serializers: {req: requestForLog, ...logger.serializers}}
        : (logger ?? false),
    ...fastifyOptions,
  });
  if (onRoute) app.addHook('onRoute', onRoute);
  app.setErrorHandler(errorHandler);
  app.get('/health', async () => ({status: 'ok', service: name}));
  return app;
}

/**
 * Boot a service: optional fail-fast checks (e.g. DB health), listen, and close cleanly on
 * SIGTERM/SIGINT (Cloud Run sends SIGTERM before stopping an instance).
 *
 * HOST defaults to 0.0.0.0 (all interfaces — what containers need). On a developer machine
 * with a public address, set HOST=127.0.0.1 so the services are not reachable from outside.
 */
export async function startService(
  app,
  {port, host = env('HOST', '0.0.0.0'), checks = [], onClose} = {},
) {
  for (const check of checks) {
    try {
      await check();
    } catch (err) {
      app.log.fatal({err}, 'startup check failed');
      process.exit(1);
    }
  }
  const shutdown = async signal => {
    app.log.info({signal}, 'shutting down');
    try {
      await app.close();
      if (onClose) await onClose();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await app.listen({port, host});
}
