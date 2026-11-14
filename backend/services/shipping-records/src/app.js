import {createBaseApp, authPlugin} from '@lrfe/common';
import {recordsRoutes} from './routes.js';

/**
 * The shipping-records service: its HTTP app with authentication and the records routes. The
 * title service is on the app as `app.titles` for the title routes (CB-34).
 * @param {{
 *   service: import('./records.service.js').ShippingRecordsService,
 *   titles?: import('./title.service.js').TitleService,
 *   jwtSecret: string,
 *   revocations?: object,
 * }} options and Fastify's own options
 * @return {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({
  service,
  titles = null,
  jwtSecret,
  revocations,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'shipping-records',
    trustProxy: true,
    ...fastifyOptions,
  });
  app.decorate('titles', titles);
  await app.register(authPlugin, {secret: jwtSecret, revocations});
  await app.register(recordsRoutes, {service});
  return app;
}
