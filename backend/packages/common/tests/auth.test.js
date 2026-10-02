import { expect } from 'chai';
import { createBaseApp, authPlugin, signServiceToken, createServiceTokenSigner } from '../src/index.js';

const SECRET = 'test-secret-test-secret-test-secret';

async function buildApp(onDenied) {
    const app = createBaseApp({ name: 'test' });
    await app.register(authPlugin, { secret: SECRET, onDenied });
    app.get('/me', { onRequest: app.authenticate }, async (req) => ({ sub: req.user.sub }));
    app.get('/link', { onRequest: app.requirePerm('record.view', 'record.link') }, async () => ({ ok: true }));
    app.get('/any', { onRequest: app.requireAnyPerm('admin.users', 'admin.policies') }, async () => ({ ok: true }));
    await app.ready();
    return app;
}

const token = (app, claims) => app.jwt.sign({ typ: 'access', sub: 'u1', name: 'Tester', perms: [], ...claims });

describe('authPlugin', () => {
    it('rejects requests without a token (401)', async () => {
        const app = await buildApp();
        const res = await app.inject({ url: '/me' });
        expect(res.statusCode).to.equal(401);
        expect(res.json().status).to.equal('Unauthorized');
    });

    it('rejects tokens that are not access tokens', async () => {
        const app = await buildApp();
        const t = app.jwt.sign({ typ: 'mfa', sub: 'u1' });
        const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${t}` } });
        expect(res.statusCode).to.equal(401);
    });

    it('accepts a valid access token', async () => {
        const app = await buildApp();
        const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token(app)}` } });
        expect(res.statusCode).to.equal(200);
        expect(res.json()).to.deep.equal({ sub: 'u1' });
    });

    it('requirePerm needs every listed permission and reports the denial', async () => {
        const denied = [];
        const app = await buildApp(async (req, perm) => denied.push([req.user.sub, perm]));
        const partial = token(app, { perms: ['record.view'] });
        const res = await app.inject({ url: '/link', headers: { authorization: `Bearer ${partial}` } });
        expect(res.statusCode).to.equal(403);
        expect(res.json().details).to.deep.equal({ perm: 'record.link' });
        expect(denied).to.deep.equal([['u1', 'record.link']]);

        const full = token(app, { perms: ['record.view', 'record.link'] });
        const ok = await app.inject({ url: '/link', headers: { authorization: `Bearer ${full}` } });
        expect(ok.statusCode).to.equal(200);
    });

    it('requireAnyPerm needs at least one listed permission', async () => {
        const app = await buildApp();
        const none = await app.inject({ url: '/any', headers: { authorization: `Bearer ${token(app)}` } });
        expect(none.statusCode).to.equal(403);
        const one = await app.inject({ url: '/any', headers: { authorization: `Bearer ${token(app, { perms: ['admin.policies'] })}` } });
        expect(one.statusCode).to.equal(200);
    });

    it('requireService accepts only service tokens for the named services', async () => {
        const app = createBaseApp({ name: 'test' });
        await app.register(authPlugin, { secret: SECRET });
        app.post('/file', { onRequest: app.requireService('intake') }, async (req) => ({ by: req.user.sub }));
        app.get('/me', { onRequest: app.authenticate }, async () => ({}));
        await app.ready();
        const call = (t) => app.inject({ method: 'POST', url: '/file', headers: { authorization: `Bearer ${t}` } });

        expect((await call(signServiceToken(app, 'intake'))).json()).to.deep.equal({ by: 'intake' });
        expect((await call(signServiceToken(app, 'land-records'))).statusCode).to.equal(403);
        expect((await call(token(app, { perms: ['verify.file'] }))).statusCode).to.equal(401);
        // and a service token is not a user token
        const me = await app.inject({ url: '/me', headers: { authorization: `Bearer ${signServiceToken(app, 'intake')}` } });
        expect(me.statusCode).to.equal(401);
    });

    it('as onRequest guards, auth is checked before the body is parsed or validated', async () => {
        const app = createBaseApp({ name: 'test' });
        await app.register(authPlugin, { secret: SECRET });
        app.post('/x', {
            onRequest: app.requirePerm('record.link'),
            schema: { body: { type: 'object', required: ['must'], properties: { must: { type: 'string' } } } }
        }, async () => ({ ok: true }));
        await app.ready();
        const res = await app.inject({ method: 'POST', url: '/x', payload: {} });
        expect(res.statusCode).to.equal(401);
        expect(res.body).to.not.include('must');
    });

    it('createServiceTokenSigner makes tokens @fastify/jwt accepts as service tokens', async () => {
        const app = createBaseApp({ name: 'test' });
        await app.register(authPlugin, { secret: SECRET });
        app.post('/file', { onRequest: app.requireService('intake') }, async (req) => ({ by: req.user.sub }));
        await app.ready();
        const sign = createServiceTokenSigner({ secret: SECRET, service: 'intake' });
        expect(sign()).to.equal(sign()); // reused until close to expiry
        const res = await app.inject({ method: 'POST', url: '/file', headers: { authorization: `Bearer ${sign()}` } });
        expect(res.json()).to.deep.equal({ by: 'intake' });
        const wrong = createServiceTokenSigner({ secret: 'another-secret-another-secret-xx', service: 'intake' });
        expect((await app.inject({ method: 'POST', url: '/file', headers: { authorization: `Bearer ${wrong()}` } })).statusCode).to.equal(401);
    });

    it('a failing onDenied hook does not change the 403', async () => {
        const app = await buildApp(async () => { throw new Error('log down'); });
        const res = await app.inject({ url: '/link', headers: { authorization: `Bearer ${token(app)}` } });
        expect(res.statusCode).to.equal(403);
    });
});
