import multipart from '@fastify/multipart';
import { createBaseApp, authPlugin } from '@lrfe/common';
import { createLinkSigner } from '@lrfe/storage';
import { intakeRoutes } from './routes.js';

/**
 *   fileLinkBase: browser-facing path of signed file links (through the gateway)
 *   maxFileBytes: 50 MB by default — Gemini's per-PDF limit
 */
export async function buildApp({
    service, jwtSecret, linkSecret = jwtSecret, fileLinkBase = '/api/intake/files', linkTtlSeconds = 300,
    maxFileBytes = 50 * 1024 * 1024, ...fastifyOptions
}) {
    const app = createBaseApp({ name: 'intake', trustProxy: true, ...fastifyOptions });
    await app.register(authPlugin, { secret: jwtSecret });
    await app.register(multipart, { limits: { fileSize: maxFileBytes, files: 1, fields: 2, fieldSize: 1024 } });
    await app.register(intakeRoutes, { service, links: createLinkSigner(linkSecret), fileLinkBase, linkTtlSeconds });
    return app;
}
