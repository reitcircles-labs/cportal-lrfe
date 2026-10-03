import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { createBaseApp, authPlugin, createEventBus, createRevocationList, SESSION_REVOKED } from '../src/index.js';

const SECRET = 'test-secret-test-secret-test-secret';
const iso = (ms) => new Date(ms).toISOString();

describe('createRevocationList', () => {
    it("refuses a suspended user's tokens issued up to the revocation, not later ones", () => {
        const now = Date.parse('2026-10-02T12:00:00Z');
        const list = createRevocationList({ clock: () => now });
        list.add({ userId: 'u1', revokedAt: iso(now), expiresAt: iso(now + 900_000) });
        expect(list.isRevoked({ sub: 'u1', iat: now / 1000 - 60 })).to.equal(true);
        expect(list.isRevoked({ sub: 'u1', iat: now / 1000 + 5 })).to.equal(false);   // signed in again after reactivation
        expect(list.isRevoked({ sub: 'u2', iat: now / 1000 - 60 })).to.equal(false);
    });

    it("refuses a signed-out session's tokens", () => {
        const now = Date.now();
        const list = createRevocationList({ clock: () => now });
        list.add({ sid: 's1', revokedAt: iso(now), expiresAt: iso(now + 900_000) });
        expect(list.isRevoked({ sub: 'u1', sid: 's1', iat: now / 1000 + 100 })).to.equal(true);
        expect(list.isRevoked({ sub: 'u1', sid: 's2', iat: now / 1000 })).to.equal(false);
    });

    it('forgets a revocation once the tokens it covers have expired', () => {
        let now = Date.now();
        const list = createRevocationList({ clock: () => now });
        list.add({ userId: 'u1', sid: 's1', revokedAt: iso(now), expiresAt: iso(now + 1000) });
        expect(list.size).to.equal(2);
        now += 1001;
        expect(list.size).to.equal(0);
        expect(list.isRevoked({ sub: 'u1', sid: 's1', iat: now / 1000 - 10 })).to.equal(false);
    });

    it('fills itself from the event bus', async () => {
        const events = createEventBus({ driver: 'memory', source: 'test' });
        const list = createRevocationList({ events });
        const now = Date.now();
        await events.publish(SESSION_REVOKED, { userId: 'u1', revokedAt: iso(now), expiresAt: iso(now + 60_000), reason: 'suspended' });
        expect(list.isRevoked({ sub: 'u1', iat: Math.floor(now / 1000) - 1 })).to.equal(true);
    });
});

describe('authPlugin with revocations', () => {
    it('answers 401 for a revoked token and lets others through', async () => {
        const revocations = createRevocationList();
        const app = createBaseApp({ name: 'test' });
        await app.register(authPlugin, { secret: SECRET, revocations });
        app.get('/me', { onRequest: app.authenticate }, async (req) => ({ sub: req.user.sub }));
        await app.ready();
        const sign = (sub) => app.jwt.sign({ typ: 'access', sub, perms: [] });
        const before = sign('u1'), other = sign('u2');
        revocations.add({ userId: 'u1', revokedAt: iso(Date.now() + 1000), expiresAt: iso(Date.now() + 900_000) });
        const refused = await app.inject({ url: '/me', headers: { authorization: `Bearer ${before}` } });
        expect(refused.statusCode).to.equal(401);
        expect(refused.json().message).to.equal('Session ended, sign in again');
        const ok = await app.inject({ url: '/me', headers: { authorization: `Bearer ${other}` } });
        expect(ok.statusCode).to.equal(200);
    });
});

// ---------------------------------------------------------------- nats driver, against a real server

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.tools');
const natsBinary = existsSync(TOOLS) && readdirSync(TOOLS).filter(d => d.startsWith('nats-server-')).map(d => join(TOOLS, d, 'nats-server')).find(existsSync);

const freePort = () => new Promise(resolve => {
    const srv = createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

(natsBinary ? describe : describe.skip)('createEventBus nats driver (needs `npm run nats` once to download the server)', () => {
    let server, url;
    const quiet = { info() {}, warn() {}, error() {} };

    before(async () => {
        const port = await freePort();
        url = `nats://127.0.0.1:${port}`;
        server = spawn(natsBinary, ['-a', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 300));
    });
    after(() => server?.kill());

    it('delivers an event to subscribers in other services', async () => {
        const identity = createEventBus({ driver: 'nats', source: 'identity', url, logger: quiet });
        const edrms = createEventBus({ driver: 'nats', source: 'edrms', url, logger: quiet });
        const got = [];
        edrms.subscribe(SESSION_REVOKED, e => got.push(e));
        await Promise.all([identity.ready(), edrms.ready()]);
        await identity.publish(SESSION_REVOKED, { userId: 'u1' }, { actor: { id: 'a1', name: 'Admin' } });
        for (let i = 0; i < 50 && !got.length; i++) await new Promise(r => setTimeout(r, 20));
        expect(got).to.have.length(1);
        expect(got[0]).to.include({ type: SESSION_REVOKED, source: 'identity' });
        expect(got[0].data).to.deep.equal({ userId: 'u1' });
        await identity.close();
        await edrms.close();
    });

    it('keeps working without a server: events stay in this service', async () => {
        const bus = createEventBus({ driver: 'nats', source: 'lonely', url: `nats://127.0.0.1:${await freePort()}`, logger: quiet });
        const got = [];
        bus.subscribe('x.y', e => got.push(e));
        await bus.publish('x.y', { n: 1 });
        expect(got).to.have.length(1);
        await bus.close();
    });
});
