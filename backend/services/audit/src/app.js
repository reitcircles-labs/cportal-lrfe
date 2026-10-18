import {createBaseApp, authPlugin} from '@lrfe/common';
import {auditRoutes} from './routes.js';

/** The audit service: its HTTP app with authentication and the audit routes. */
export async function buildApp({
  service,
  proofs,
  signoffs,
  evidence,
  auditList,
  anchorings,
  lookup,
  testAnchorings = null,
  health = null,
  jwtSecret,
  revocations,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'audit',
    trustProxy: true,
    ...fastifyOptions,
  });
  await app.register(authPlugin, {secret: jwtSecret, revocations});
  await app.register(auditRoutes, {
    service,
    proofs,
    signoffs,
    evidence,
    auditList,
    anchorings,
    lookup,
    testAnchorings,
    health,
  });
  return app;
}
