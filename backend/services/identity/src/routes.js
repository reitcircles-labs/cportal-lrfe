import { actorOf, UnauthorizedError } from '@lrfe/common';
import { ACCESS_KINDS, OFFICE_CODE_PATTERN, OFFICE_TYPES, ROLE_IDS } from './catalogue.js';

const MFA_TOKEN_TYPE = 'mfa';

const str = (extra = {}) => ({ type: 'string', ...extra });
const body = (properties, required = Object.keys(properties)) => ({
    body: { type: 'object', additionalProperties: false, required, properties }
});
const idParam = { params: { type: 'object', required: ['id'], properties: { id: str({ format: 'uuid' }) } } };
const roleList = { type: 'array', minItems: 1, uniqueItems: true, items: str({ enum: ROLE_IDS }) };
/** An office id, or null for "no office" (allowed only for administrators; the service decides). */
const officeRef = { type: ['string', 'null'], format: 'uuid' };
const officeFields = {
    name: str({ minLength: 1, maxLength: 200 }), type: str({ enum: OFFICE_TYPES }),
    address: str({ maxLength: 1000 }), contact: str({ maxLength: 200 })
};
const reasonOf = (req) => (typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '');

/**
 * Identity HTTP API. The gateway exposes these under /api (e.g. POST /api/auth/login).
 * Refresh tokens live only in an httpOnly cookie; access tokens are returned in the body.
 */
export async function identityRoutes(app, { service, accessTtlSeconds, cookie }) {
    const cookieOptions = { httpOnly: true, secure: cookie.secure, sameSite: 'strict', path: cookie.path };

    function signedIn(reply, { refreshToken, claims, me }) {
        reply.setCookie(cookie.name, refreshToken, cookieOptions);
        return { accessToken: app.jwt.sign(claims, { expiresIn: `${accessTtlSeconds}s` }), expiresIn: accessTtlSeconds, me };
    }

    // ------------------------------------------------------------------ public: sign-in

    app.post('/auth/login', { schema: body({ email: str({ maxLength: 320 }), password: str({ maxLength: 1024 }) }) }, async (req, reply) => {
        const result = await service.login({ ...req.body, ip: req.ip });
        if (result.next === 'done') return signedIn(reply, result);
        const challenge = app.jwt.sign({ typ: MFA_TOKEN_TYPE, sub: result.userId }, { expiresIn: '5m' });
        const { userId, ...rest } = result;
        return { ...rest, challenge };
    });

    app.post('/auth/mfa', { schema: body({ challenge: str(), code: str({ pattern: '^\\d{6}$' }) }) }, async (req, reply) => {
        let payload;
        try {
            payload = app.jwt.verify(req.body.challenge);
        } catch {
            throw new UnauthorizedError('Sign-in expired, start again');
        }
        if (payload.typ !== MFA_TOKEN_TYPE) throw new UnauthorizedError('Sign-in expired, start again');
        return signedIn(reply, await service.verifyMfa({ userId: payload.sub, code: req.body.code, ip: req.ip }));
    });

    app.post('/auth/refresh', async (req, reply) => {
        try {
            return signedIn(reply, await service.refresh(req.cookies[cookie.name]));
        } catch (err) {
            reply.clearCookie(cookie.name, cookieOptions);
            throw err;
        }
    });

    app.post('/auth/logout', async (req, reply) => {
        const sid = String(req.cookies[cookie.name] || '').split('.')[0];
        await service.logout({ sid });
        reply.clearCookie(cookie.name, cookieOptions);
        return { ok: true };
    });

    app.post('/invitations/accept', { schema: body({ token: str({ maxLength: 200 }), password: str({ maxLength: 1024 }) }) },
        async (req) => service.acceptInvite(req.body));

    // ------------------------------------------------------------------ signed in

    app.get('/auth/me', { onRequest: app.authenticate }, async (req) => service.me(req.user.sub));
    app.get('/catalogue', { onRequest: app.authenticate }, async () => service.catalogue());
    app.get('/roles', { onRequest: app.authenticate }, async () => ({ roles: await service.listRoles() }));

    // ------------------------------------------------------------------ administration

    const users = { onRequest: app.requirePerm('admin.users') };
    app.get('/users', users, async () => ({ users: await service.listUsers() }));
    app.post('/users', { ...users, schema: body({ name: str({ minLength: 1, maxLength: 200 }), email: str({ format: 'email', maxLength: 320 }), officeId: officeRef, roles: roleList }, ['name', 'email', 'roles']) },
        async (req, reply) => reply.status(201).send(await service.invite(req.body, actorOf(req))));
    app.put('/users/:id/roles', { ...users, schema: { ...idParam, ...body({ roles: roleList }) } },
        async (req) => service.setUserRoles(req.params.id, req.body.roles, actorOf(req)));
    // The reason is optional, so these accept an empty request as well as { reason }.
    app.post('/users/:id/suspend', { ...users, schema: idParam },
        async (req) => service.setStatus(req.params.id, 'Suspended', reasonOf(req), actorOf(req)));
    app.post('/users/:id/reactivate', { ...users, schema: idParam },
        async (req) => service.setStatus(req.params.id, 'Active', reasonOf(req), actorOf(req)));
    app.post('/users/:id/mfa-reset', { ...users, schema: idParam },
        async (req) => service.resetMfa(req.params.id, actorOf(req)));
    app.post('/users/:id/invitation', { ...users, schema: idParam },
        async (req) => service.resendInvite(req.params.id, actorOf(req)));
    app.put('/users/:id/office', { ...users, schema: { ...idParam, ...body({ officeId: officeRef }) } },
        async (req) => service.setUserOffice(req.params.id, req.body.officeId, actorOf(req)));

    // Offices: listed for whoever invites users or manages offices; changed only with admin.offices.
    app.get('/offices', { onRequest: app.requireAnyPerm('admin.users', 'admin.offices') }, async () => ({ offices: await service.listOffices() }));
    const offices = { onRequest: app.requirePerm('admin.offices') };
    app.post('/offices', { ...offices, schema: body({ code: str({ pattern: OFFICE_CODE_PATTERN }), ...officeFields }, ['code', 'name']) },
        async (req, reply) => reply.status(201).send(await service.createOffice(req.body, actorOf(req))));
    app.put('/offices/:id', { ...offices, schema: { ...idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: officeFields } } },
        async (req) => service.updateOffice(req.params.id, req.body, actorOf(req)));
    app.post('/offices/:id/suspend', { ...offices, schema: idParam },
        async (req) => service.setOfficeStatus(req.params.id, 'Suspended', reasonOf(req), actorOf(req)));
    app.post('/offices/:id/reactivate', { ...offices, schema: idParam },
        async (req) => service.setOfficeStatus(req.params.id, 'Active', reasonOf(req), actorOf(req)));

    app.put('/roles/permissions', {
        onRequest: app.requirePerm('admin.roles'),
        schema: body({ matrix: { type: 'object', additionalProperties: { type: 'array', items: str() } } })
    }, async (req) => service.saveMatrix(req.body.matrix, actorOf(req)));

    app.get('/policies', { onRequest: app.requireAnyPerm('admin.policies', 'admin.users') }, async () => service.getPolicySettings());
    app.put('/policies', {
        onRequest: app.requirePerm('admin.policies'),
        schema: body({
            policies: {
                type: 'object', additionalProperties: false, required: ['mfa', 'eid', 'ipAllow', 'timeout', 'fourEyes'],
                properties: { mfa: { type: 'boolean' }, eid: { type: 'boolean' }, ipAllow: { type: 'boolean' }, timeout: { type: 'integer' }, fourEyes: { type: 'boolean' } }
            },
            sod: { type: 'array', items: { type: 'object', required: ['id', 'on'], properties: { id: str(), on: { type: 'boolean' } } } }
        }, ['policies'])
    }, async (req) => service.savePolicies(req.body, actorOf(req)));

    app.get('/access-log', {
        onRequest: app.requirePerm('admin.users'),
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: { kind: str({ enum: ACCESS_KINDS }), limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } }
            }
        }
    }, async (req) => service.listAccessLog(req.query));
}
