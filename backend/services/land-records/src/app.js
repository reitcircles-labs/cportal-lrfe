import {createBaseApp, authPlugin} from '@lrfe/common';
import {recordsRoutes} from './routes.js';

/** The land-records service: its HTTP app with authentication and the records routes. */
export async function buildApp({
  service,
  jwtSecret,
  revocations,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'land-records',
    trustProxy: true,
    ...fastifyOptions,
  });
  await app.register(authPlugin, {secret: jwtSecret, revocations});
  await app.register(recordsRoutes, {service});
  return app;
}
