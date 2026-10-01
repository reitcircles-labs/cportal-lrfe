import cors from '@fastify/cors';
import proxy from '@fastify/http-proxy';
import { createBaseApp } from '@lrfe/common';

/**
 * Public path prefix → upstream service. The prefix is stripped except for the part the
 * service expects (e.g. /api/auth/login → identity /auth/login). Add a row per new service.
 */
export const ROUTES = [
    { prefix: '/api/auth', service: 'identity', rewritePrefix: '/auth' },
    { prefix: '/api/invitations', service: 'identity', rewritePrefix: '/invitations' },
    { prefix: '/api/catalogue', service: 'identity', rewritePrefix: '/catalogue' },
    { prefix: '/api/users', service: 'identity', rewritePrefix: '/users' },
    { prefix: '/api/roles', service: 'identity', rewritePrefix: '/roles' },
    { prefix: '/api/policies', service: 'identity', rewritePrefix: '/policies' },
    { prefix: '/api/access-log', service: 'identity', rewritePrefix: '/access-log' },
    { prefix: '/api/offices', service: 'identity', rewritePrefix: '/offices' },
    { prefix: '/api/documents', service: 'edrms', rewritePrefix: '/documents' },
    { prefix: '/api/document-content', service: 'edrms', rewritePrefix: '/content' },
    { prefix: '/api/document-catalogue', service: 'edrms', rewritePrefix: '/catalogue' },
    { prefix: '/api/processes', service: 'bpm', rewritePrefix: '/processes' },
    { prefix: '/api/process-instances', service: 'bpm', rewritePrefix: '/instances' },
    { prefix: '/api/tasks', service: 'bpm', rewritePrefix: '/tasks' },
    { prefix: '/api/intake', service: 'intake', rewritePrefix: '' }
    // Next: land-records (/api/records), audit (/api/audit), search (/api/search).
];

/**
 * `Expect: 100-continue` (sent by curl and many clients on large uploads) is answered by the
 * gateway's own HTTP server; forwarding it makes the upstream client (undici) fail the request.
 */
function dropHopHeaders(_req, headers) {
    const { expect, ...rest } = headers;
    return rest;
}

/**
 * The gateway does not verify tokens itself: every service verifies the JWT and checks
 * permissions, so a request that bypasses the gateway gets no extra access.
 *
 *   upstreams:   { identity: 'http://localhost:3501', ... }
 *   corsOrigins: allowed browser origins (not needed when the app is served from the same origin)
 */
export async function buildApp({ upstreams, corsOrigins = [], ...fastifyOptions }) {
    const app = createBaseApp({ name: 'gateway', trustProxy: true, ...fastifyOptions });
    if (corsOrigins.length) await app.register(cors, { origin: corsOrigins, credentials: true });

    for (const route of ROUTES) {
        const upstream = upstreams[route.service];
        if (!upstream) throw new Error(`gateway: no upstream URL configured for service "${route.service}"`);
        await app.register(proxy, {
            upstream, prefix: route.prefix, rewritePrefix: route.rewritePrefix, http2: false,
            replyOptions: { rewriteRequestHeaders: dropHopHeaders }
        });
    }
    return app;
}
