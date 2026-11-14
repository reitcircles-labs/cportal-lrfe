import {createBaseApp, authPlugin} from '@lrfe/common';
import {recordsRoutes} from './routes.js';

/**
 * The shipping-records service: its HTTP app with authentication and the records routes.
 * @param {{
 *   service: import('./records.service.js').ShippingRecordsService,
 *   jwtSecret: string,
 *   revocations?: object,
 * }} options and Fastify's own options
 * @return {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({
  service,
  jwtSecret,
  revocations,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'shipping-records',
    trustProxy: true,
    ...fastifyOptions,
  });
  await app.register(authPlugin, {secret: jwtSecret, revocations});
  await app.register(recordsRoutes, {service});
  return app;
}
