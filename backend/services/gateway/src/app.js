import cors from '@fastify/cors';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import {createBaseApp, domain, recordServiceOf} from '@lrfe/common';

/**
 * The routing table of an install: public path prefix → upstream service. The prefix is stripped
 * except for the part the service expects (e.g. /api/auth/login → identity /auth/login). Add a
 * row per new service. `/api/records` goes to the product's record service, as the domain pack
 * names it (CB-4: land-records for land, shipping-records for shipping); a pack without records
 * has no such route.
 * @param {{name: string} | null} recordService
 * @return {Array<{prefix: string, service: string, rewritePrefix: string}>}
 */
export function routesOf(recordService) {
  const records = recordService
    ? [
        {
          prefix: '/api/records',
          service: recordService.name,
          rewritePrefix: '/records',
        },
      ]
    : [];
  return [
    {prefix: '/api/auth', service: 'identity', rewritePrefix: '/auth'},
    {
      prefix: '/api/invitations',
      service: 'identity',
      rewritePrefix: '/invitations',
    },
    {
      prefix: '/api/catalogue',
      service: 'identity',
      rewritePrefix: '/catalogue',
    },
    {prefix: '/api/users', service: 'identity', rewritePrefix: '/users'},
    {prefix: '/api/roles', service: 'identity', rewritePrefix: '/roles'},
    {prefix: '/api/policies', service: 'identity', rewritePrefix: '/policies'},
    {
      prefix: '/api/access-log',
      service: 'identity',
      rewritePrefix: '/access-log',
    },
    {prefix: '/api/offices', service: 'identity', rewritePrefix: '/offices'},
    {
      prefix: '/api/organisations',
      service: 'identity',
      rewritePrefix: '/organisations',
    },
    {prefix: '/api/documents', service: 'edrms', rewritePrefix: '/documents'},
    {
      prefix: '/api/document-content',
      service: 'edrms',
      rewritePrefix: '/content',
    },
    {
      prefix: '/api/document-catalogue',
      service: 'edrms',
      rewritePrefix: '/catalogue',
    },
    {prefix: '/api/processes', service: 'bpm', rewritePrefix: '/processes'},
    {
      prefix: '/api/process-instances',
      service: 'bpm',
      rewritePrefix: '/instances',
    },
    {prefix: '/api/tasks', service: 'bpm', rewritePrefix: '/tasks'},
    {prefix: '/api/intake', service: 'intake', rewritePrefix: ''},
    ...records,
    {prefix: '/api/audit', service: 'audit', rewritePrefix: '/audit'},
    {prefix: '/api/extracts', service: 'extracts', rewritePrefix: '/extracts'},
    // Next: search (/api/search).
  ];
}

/** This install's routing table, from its domain pack's record service. */
export const ROUTES = routesOf(recordServiceOf(domain));

/**
 * Routes anyone may call without signing in, rate-limited per client address: only these, only
 * GET. The public check of an ownership extract (API-693) is the only one.
 */
export const PUBLIC_ROUTES = [
  {
    prefix: '/api/public/extracts',
    service: 'extracts',
    rewritePrefix: '/public/extracts',
  },
];

/** How many public requests one client address may make in `timeWindow` ms, by default. */
export const PUBLIC_RATE_LIMIT = {max: 10, timeWindow: 60_000};

/**
 * `Expect: 100-continue` (sent by curl and many clients on large uploads) is answered by the
 * gateway's own HTTP server; forwarding it makes the upstream client (undici) fail the request.
 */
function dropHopHeaders(_req, headers) {
  const {expect, ...rest} = headers;
  return rest;
}

/** A public request goes on without the caller's credentials: it never acts as a signed-in user. */
function dropCredentials(req, headers) {
  const {authorization, cookie, ...rest} = dropHopHeaders(req, headers);
  return rest;
}

/** Too many public requests from one address: a neutral 429, in the shared error shape. */
function tooManyRequests(_req, context) {
  return {
    statusCode: 429,
    message: `Too many requests: try again in ${context.after}.`,
  };
}

/**
 * The public routes, in their own scope so the rate limit applies to them only. The store is in
 * memory, per gateway instance.
 */
async function publicRoutes(scope, {upstreams, rateLimit: limit}) {
  await scope.register(rateLimit, {
    max: limit.max,
    timeWindow: limit.timeWindow,
    errorResponseBuilder: tooManyRequests,
  });
  for (const route of PUBLIC_ROUTES) {
    await scope.register(proxy, {
      upstream: upstreams[route.service],
      prefix: route.prefix,
      rewritePrefix: route.rewritePrefix,
      httpMethods: ['GET'],
      http2: false,
      // the proxy's own lines name the upstream URL, token and all; the request logs (redacted) stay
      disableRequestLogging: true,
      replyOptions: {rewriteRequestHeaders: dropCredentials},
    });
  }
}

/**
 * The gateway does not verify tokens itself: every service verifies the JWT and checks
 * permissions, so a request that bypasses the gateway gets no extra access.
 *
 *   upstreams:   { identity: 'http://localhost:3501', ... }
 *   corsOrigins: allowed browser origins (not needed when the app is served from the same origin)
 *   publicRateLimit: { max, timeWindow } for PUBLIC_ROUTES, per client address
 *   routes:      the routing table (this install's ROUTES by default)
 */
export async function buildApp({
  upstreams,
  corsOrigins = [],
  publicRateLimit = PUBLIC_RATE_LIMIT,
  routes = ROUTES,
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'gateway',
    trustProxy: true,
    ...fastifyOptions,
  });
  if (corsOrigins.length) {
    await app.register(cors, {origin: corsOrigins, credentials: true});
  }

  for (const route of [...routes, ...PUBLIC_ROUTES]) {
    if (!upstreams[route.service]) {
      throw new Error(
        `gateway: no upstream URL configured for service "${route.service}"`,
      );
    }
  }
  await app.register(publicRoutes, {upstreams, rateLimit: publicRateLimit});

  for (const route of routes) {
    await app.register(proxy, {
      upstream: upstreams[route.service],
      prefix: route.prefix,
      rewritePrefix: route.rewritePrefix,
      http2: false,
      replyOptions: {rewriteRequestHeaders: dropHopHeaders},
    });
  }
  return app;
}
