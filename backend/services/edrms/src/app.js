import multipart from '@fastify/multipart';
import {createBaseApp, authPlugin} from '@lrfe/common';
import {MAX_TRANSCRIPTION_BYTES, edrmsRoutes} from './routes.js';

/**
 *   contentUrl: { base, secret }  signed /content links for stores without presigned URLs;
 *                                 `base` is the browser-facing path (through the gateway)
 */
export async function buildApp({
  service,
  jwtSecret,
  contentUrl = {base: '/api/document-content', secret: jwtSecret},
  maxFileBytes = 200 * 1024 * 1024,
  revocations,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'edrms',
    trustProxy: true,
    ...fastifyOptions,
  });
  await app.register(authPlugin, {secret: jwtSecret, revocations});
  await app.register(multipart, {
    limits: {
      fileSize: maxFileBytes,
      files: 1,
      fields: 5,
      // `meta` is small; the `transcription` field holds the AI's page text (API-798)
      fieldSize: MAX_TRANSCRIPTION_BYTES,
    },
  });
  await app.register(edrmsRoutes, {service, contentUrl});
  return app;
}
