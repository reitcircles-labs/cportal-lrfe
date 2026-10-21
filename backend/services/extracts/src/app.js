import {createBaseApp, authPlugin} from '@lrfe/common';
import {extractsRoutes, publicRoutes} from './routes.js';

/**
 * The extracts service: its HTTP app with authentication, the extracts routes and the public
 * check of an extract (`check`, an ExtractCheck).
 */
export async function buildApp({
  service,
  check,
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
  await app.register(publicRoutes, {check});
  return app;
}
