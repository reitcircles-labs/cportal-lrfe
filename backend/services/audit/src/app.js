import { createBaseApp, authPlugin } from '@lrfe/common';
import { auditRoutes } from './routes.js';

export async function buildApp({ service, proofs, signoffs, evidence, auditList, anchorings, jwtSecret, revocations, ...fastifyOptions }) {
    const app = createBaseApp({ name: 'audit', trustProxy: true, ...fastifyOptions });
    await app.register(authPlugin, { secret: jwtSecret, revocations });
    await app.register(auditRoutes, { service, proofs, signoffs, evidence, auditList, anchorings });
    return app;
}
