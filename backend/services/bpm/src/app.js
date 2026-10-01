import { createBaseApp, authPlugin } from '@lrfe/common';
import { bpmRoutes } from './routes.js';

/** Build the bpm app around an engine (tests pass one over the in-memory repo). */
export async function buildApp({ engine, jwtSecret, ...fastifyOptions }) {
    const app = createBaseApp({ name: 'bpm', trustProxy: true, ...fastifyOptions });
    await app.register(authPlugin, { secret: jwtSecret });
    await app.register(bpmRoutes, { engine });
    return app;
}
