import {createBaseApp} from '@lrfe/common';
import {searchRoutes} from './routes.js';

/** The search service: its HTTP app (health and event lag; it has no other routes yet). */
export async function buildApp({service, ...fastifyOptions}) {
  const app = createBaseApp({name: 'search', ...fastifyOptions});
  await app.register(searchRoutes, {service});
  return app;
}
