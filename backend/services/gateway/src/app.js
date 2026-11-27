import {isIP} from 'node:net';
import cors from '@fastify/cors';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import {AppError, createBaseApp, domain, recordServiceOf} from '@lrfe/common';

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
 * How many requests one client address may make in `timeWindow` ms on the password step and, apart,
 * on the code step of sign-in, by default (CB-101).
 */
export const SIGN_IN_RATE_LIMIT = {max: 60, timeWindow: 60_000};

/**
 * How many session refreshes one client address may make in `timeWindow` ms, by default (CB-101):
 * higher than sign-in, since an office's users may all reach the server from one address and each
 * open tab refreshes its session.
 */
export const REFRESH_RATE_LIMIT = {max: 600, timeWindow: 60_000};

/** The sign-in endpoints whose requests are counted per client address, by their path (CB-101). */
const SIGN_IN_ENDPOINTS = new Map([
  ['/api/auth/login', 'login'],
  ['/api/auth/mfa', 'mfa'],
  // the setup code of a user without an authenticator (CB-102), with its own allowance
  ['/api/auth/setup-code', 'setup-code'],
  ['/api/auth/refresh', 'refresh'],
]);

/**
 * The sign-in endpoint a request is for ('login', 'mfa', 'setup-code' or 'refresh'), or null. The
 * path is read as the services will route it, so another spelling of it (percent-encoded, dot
 * segments, repeated or trailing slashes, upper case, a query string) is counted the same.
 * @param {string} url the request URL as received
 * @return {?string}
 */
function signInEndpointOf(url) {
  let path = url.split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // not valid percent-encoding: the services will not route it either; read it as written
  }
  // repeated slashes first: "//api/…" would otherwise read as a host name
  const single = path.replace(/[/\\]+/g, '/');
  let resolved;
  try {
    resolved = new URL(single, 'http://gateway').pathname;
  } catch {
    return null;
  }
  const normalised = resolved.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return SIGN_IN_ENDPOINTS.get(normalised.toLowerCase()) ?? null;
}

/** The proxies trusted when TRUST_PROXY is not set: only one on this machine (loopback). */
export const LOOPBACK_PROXIES = Object.freeze(['127.0.0.1', '::1']);

/**
 * Whether `entry` is an IP address or a CIDR range of one (e.g. 10.0.0.0/8, fd00::/8).
 * @param {string} entry
 * @return {boolean}
 */
function isAddressOrRange(entry) {
  const [address, prefix, ...extra] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || extra.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const maxPrefix = version === 4 ? 32 : 128;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix;
}

/**
 * The proxies whose X-Forwarded-For the gateway believes (CB-105), from the setting TRUST_PROXY:
 * a hop count (e.g. 2: the site's nginx and the web container), or a comma-separated list of
 * addresses and CIDR ranges. Not set: only a proxy on this machine. `true` (every caller) would let
 * any client choose its own address, so it is refused like any other value that is neither.
 * @param {string | undefined} value the setting as written, undefined or empty when not set
 * @return {number | !Array<string>} Fastify's trustProxy option
 * @throws {Error} when the value is unsafe or not valid
 */
export function trustProxyFrom(value) {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    return [...LOOPBACK_PROXIES];
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const entries = trimmed
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  const invalid = entries.filter(entry => !isAddressOrRange(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `TRUST_PROXY must be a hop count or a comma-separated list of proxy addresses or CIDR ` +
        `ranges, got "${trimmed}" (trusting every caller, "true", is unsafe: any client could ` +
        `choose its own address)`,
    );
  }
  return entries;
}

/**
 * Fastify's trustProxy as a function for a hop count: the caller and the `hops - 1` addresses it
 * appended last are proxies. Fastify (5.12) given the number itself believes no X-Forwarded-For.
 * @param {number | !Array<string> | function(string, number): boolean} trustProxy
 * @return {!Array<string> | function(string, number): boolean}
 */
function trustProxyOption(trustProxy) {
  if (typeof trustProxy !== 'number') {
    return trustProxy;
  }
  return (_address, hop) => hop < trustProxy;
}

/**
 * `Expect: 100-continue` (sent by curl and many clients on large uploads) is answered by the
 * gateway's own HTTP server; forwarding it makes the upstream client (undici) fail the request.
 * The services believe X-Forwarded-For (they only take requests from the gateway): it is replaced
 * by the client address the gateway trusts, so nothing a client wrote in it reaches them (CB-105).
 * @param {!Object} req the request on the gateway
 * @param {!Object<string, string>} headers the headers to send on
 * @return {!Object<string, string>} the headers the service gets
 */
function dropHopHeaders(req, headers) {
  const {expect, ...rest} = headers;
  return {...rest, 'x-forwarded-for': req.ip};
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
 * Counts requests per key in fixed windows, in memory. Each call counts and decides in one
 * synchronous step, so requests sent at the same time are counted exactly: the first `max` pass.
 */
class WindowCounter {
  /**
   * @param {function(): number=} now the current time in ms
   */
  constructor(now = Date.now) {
    this.now = now;
    /** @type {!Map<string, {count: number, resetAt: number}>} */
    this.windows = new Map();
    this.nextSweepAt = 0;
  }

  /**
   * Counts one request for `key` and says whether it is within `max` per `timeWindow` ms.
   * @param {string} key
   * @param {{max: number, timeWindow: number}} limit
   * @return {{allowed: boolean, retryAfterMs: number}} retryAfterMs: until the window starts again
   */
  hit(key, {max, timeWindow}) {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      window = {count: 0, resetAt: now + timeWindow};
      this.windows.set(key, window);
    }
    window.count++;
    return {allowed: window.count <= max, retryAfterMs: window.resetAt - now};
  }

  /**
   * Forgets ended windows, at most once a minute, so the map does not grow with every address seen.
   * @param {number} now
   */
  sweep(now) {
    if (now < this.nextSweepAt) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
    this.nextSweepAt = now + 60_000;
  }
}

/**
 * A wait in words for the 429 message: whole minutes from a minute on (rounded up), otherwise
 * seconds.
 * @param {number} ms
 * @return {string}
 */
function waitInWords(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * The sign-in rate limit (CB-101) as an onRequest hook: each sign-in endpoint (POST) has its own
 * allowance per client address, the address the gateway trusts (CB-105); a request over it gets a
 * neutral 429 in the shared error shape and never reaches identity. Counted in memory, per gateway
 * instance.
 * @param {{signIn: {max: number, timeWindow: number},
 *     refresh: {max: number, timeWindow: number}}} limits
 * @return {function(!Object, !Object): !Promise<void>}
 */
function signInRateLimitHook({signIn, refresh}) {
  const counter = new WindowCounter();
  return async (req, reply) => {
    if (req.method !== 'POST') {
      return;
    }
    const endpoint = signInEndpointOf(req.url);
    if (endpoint === null) {
      return;
    }
    const limit = endpoint === 'refresh' ? refresh : signIn;
    const {allowed, retryAfterMs} = counter.hit(`${endpoint}|${req.ip}`, limit);
    if (!allowed) {
      reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
      throw new AppError(
        429,
        `Too many requests: try again in ${waitInWords(retryAfterMs)}.`,
      );
    }
  };
}

/**
 * The gateway does not verify tokens itself: every service verifies the JWT and checks
 * permissions, so a request that bypasses the gateway gets no extra access.
 *
 *   upstreams:   { identity: 'http://localhost:3501', ... }
 *   corsOrigins: allowed browser origins (not needed when the app is served from the same origin)
 *   publicRateLimit: { max, timeWindow } for PUBLIC_ROUTES, per client address
 *   signInRateLimit: { max, timeWindow } for each of POST /api/auth/login, /api/auth/mfa and
 *                    /api/auth/setup-code, per client address
 *   refreshRateLimit: { max, timeWindow } for /api/auth/refresh, per client address
 *   routes:      the routing table (this install's ROUTES by default)
 *   trustProxy:  the proxies whose X-Forwarded-For is believed (trustProxyFrom; loopback by default)
 */
export async function buildApp({
  upstreams,
  corsOrigins = [],
  publicRateLimit = PUBLIC_RATE_LIMIT,
  signInRateLimit = SIGN_IN_RATE_LIMIT,
  refreshRateLimit = REFRESH_RATE_LIMIT,
  routes = ROUTES,
  trustProxy = [...LOOPBACK_PROXIES],
  ...fastifyOptions
}) {
  const app = createBaseApp({
    name: 'gateway',
    trustProxy: trustProxyOption(trustProxy),
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
  app.addHook(
    'onRequest',
    signInRateLimitHook({signIn: signInRateLimit, refresh: refreshRateLimit}),
  );
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
