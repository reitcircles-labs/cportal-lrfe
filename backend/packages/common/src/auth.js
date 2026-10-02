import { createHmac } from 'node:crypto';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { ForbiddenError, UnauthorizedError } from './errors.js';

export const ACCESS_TOKEN_TYPE = 'access';

/**
 * Registers @fastify/jwt and decorates the app with route guards:
 *
 *   app.authenticate                       onRequest guard: valid access token required
 *   app.requirePerm('record.link', ...)    onRequest guard: token must carry ALL listed permissions
 *   app.requireAnyPerm('a', 'b')           onRequest guard: token must carry AT LEAST ONE of them
 *
 * Tokens are issued by the identity service; every service verifies them itself with the
 * shared JWT_SECRET, so permission checks never depend on the browser or the gateway.
 * `request.user` is the token payload: { sub, name, email, roles, perms, sid, typ }.
 *
 * `onDenied(request, perm)` is called (best effort, never throws) when a permission check
 * fails, so the caller can write the denial to its access log or publish an event.
 */
export const authPlugin = fp(async function authPlugin(app, { secret, onDenied } = {}) {
    if (!secret) throw new Error('authPlugin: `secret` is required');
    await app.register(fastifyJwt, { secret });

    async function authenticate(request) {
        try {
            await request.jwtVerify();
        } catch {
            throw new UnauthorizedError('Invalid or expired token');
        }
        if (request.user?.typ !== ACCESS_TOKEN_TYPE) throw new UnauthorizedError('Invalid or expired token');
    }

    async function deny(request, perm) {
        if (onDenied) {
            try { await onDenied(request, perm); } catch (err) { request.log.warn({ err }, 'onDenied hook failed'); }
        }
        throw new ForbiddenError('Not permitted', { perm });
    }

    app.decorate('authenticate', describeGuard(authenticate, { kind: 'user' }));
    app.decorate('requirePerm', (...perms) => describeGuard(async function requirePerm(request) {
        await authenticate(request);
        const have = request.user.perms || [];
        const missing = perms.find(p => !have.includes(p));
        if (missing) await deny(request, missing);
    }, { kind: 'user', allOf: perms }));
    app.decorate('requireAnyPerm', (...perms) => describeGuard(async function requireAnyPerm(request) {
        await authenticate(request);
        const have = request.user.perms || [];
        if (!perms.some(p => have.includes(p))) await deny(request, perms.join(' | '));
    }, { kind: 'user', anyOf: perms }));
    // Service-to-service calls (e.g. intake filing into edrms). User tokens never pass this.
    app.decorate('requireService', (...names) => describeGuard(async function requireService(request) {
        try {
            await request.jwtVerify();
        } catch {
            throw new UnauthorizedError('Invalid or expired token');
        }
        if (request.user?.typ !== SERVICE_TOKEN_TYPE) throw new UnauthorizedError('Service token required');
        if (!names.includes(request.user.sub)) throw new ForbiddenError('Not permitted', { service: request.user.sub });
    }, { kind: 'service', services: names }));
});

/**
 * Record who a guard lets through, for the generated API docs (scripts/openapi.js):
 *   { kind: 'user' | 'service', allOf?: [perm], anyOf?: [perm], services?: [name] }
 * A route guarded by a function without this is reported by the generator until its docs
 * describe the access rule.
 */
export function describeGuard(fn, access) {
    fn.access = access;
    return fn;
}

export const SERVICE_TOKEN_TYPE = 'service';

/** Short-lived token a service sends when calling another service: `Authorization: Bearer <token>`. */
export function signServiceToken(app, serviceName, expiresIn = '5m') {
    return app.jwt.sign({ typ: SERVICE_TOKEN_TYPE, sub: serviceName }, { expiresIn });
}

/**
 * The same service token without a Fastify app (e.g. a standalone worker): HS256 with the shared
 * secret, which is what @fastify/jwt verifies. Tokens are reused until a minute before expiry.
 */
export function createServiceTokenSigner({ secret, service, ttlSeconds = 300 }) {
    if (!secret || !service) throw new Error('createServiceTokenSigner: secret and service are required');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    let token = null, expiresAt = 0;
    return () => {
        const now = Math.floor(Date.now() / 1000);
        if (!token || now > expiresAt - 60) {
            expiresAt = now + ttlSeconds;
            const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ typ: SERVICE_TOKEN_TYPE, sub: service, iat: now, exp: expiresAt })}`;
            token = `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
        }
        return token;
    };
}

/** The acting user for logs and events, from a verified request. */
export function actorOf(request) {
    return request.user ? { id: request.user.sub, name: request.user.name } : { id: null, name: 'System' };
}
