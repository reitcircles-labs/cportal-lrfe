import multipart from '@fastify/multipart';
import { createBaseApp, authPlugin } from '@lrfe/common';
import { edrmsRoutes } from './routes.js';

/**
 *   contentUrl: { base, secret }  signed /content links for stores without presigned URLs;
 *                                 `base` is the browser-facing path (through the gateway)
 */
export async function buildApp({
    service,
    jwtSecret,
    contentUrl = { base: '/api/document-content', secret: jwtSecret },
    maxFileBytes = 200 * 1024 * 1024,
    revocations,
    ...fastifyOptions
}) {
    const app = createBaseApp({ name: 'edrms', trustProxy: true, ...fastifyOptions });
    await app.register(authPlugin, { secret: jwtSecret, revocations });
    await app.register(multipart, {
        limits: { fileSize: maxFileBytes, files: 1, fields: 5, fieldSize: 1024 * 1024 }
    });
    await app.register(edrmsRoutes, { service, contentUrl });
    return app;
}
