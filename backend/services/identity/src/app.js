import fastifyCookie from '@fastify/cookie';
import { createBaseApp, authPlugin } from '@lrfe/common';
import { identityRoutes } from './routes.js';

/**
 * Build the identity app around an already-constructed IdentityService (so tests can pass one
 * backed by the in-memory repo).
 */
export async function buildApp({
    service,
    jwtSecret,
    accessTtlSeconds = 900,
    revocations,
    cookie = { name: 'lrfe_rt', path: '/api/auth', secure: true },
    ...fastifyOptions
}) {
    const app = createBaseApp({ name: 'identity', trustProxy: true, ...fastifyOptions });
    await app.register(fastifyCookie);
    await app.register(authPlugin, {
        secret: jwtSecret,
        onDenied: (req, perm) => service.recordDenied(req.user, perm),
        revocations
    });
    await app.register(identityRoutes, { service, accessTtlSeconds, cookie });
    return app;
}
