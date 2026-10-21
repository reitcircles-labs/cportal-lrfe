import {createBaseApp, authPlugin} from '@lrfe/common';
import {extractsRoutes} from './routes.js';

/** The extracts service: its HTTP app with authentication and the extracts routes. */
export async function buildApp({
  service,
  jwtSecret,
  revocations,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'extracts',
    trustProxy: true,
    ...fastifyOptions,
  });
  await app.register(authPlugin, {secret: jwtSecret, revocations});
  await app.register(extractsRoutes, {service});
  return app;
}
