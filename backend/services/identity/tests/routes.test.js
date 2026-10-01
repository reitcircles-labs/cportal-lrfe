import { expect } from 'chai';
import { makeApp, codeFor, PASSWORD } from './helpers.js';

describe('identity HTTP API', () => {
    it('login → me → refresh (cookie) → logout', async () => {
        const { app, login, auth } = await makeApp();
        const { token, cookie, body } = await login('j.gawaseb@deeds.gov.na');
        expect(body.expiresIn).to.equal(900);
        expect(body.me.home).to.equal('/link');
        expect(cookie).to.be.a('string');

        const me = await app.inject({ url: '/auth/me', headers: auth(token) });
        expect(me.statusCode).to.equal(200);
        expect(me.json().perms).to.include('record.finalize');

        const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', cookies: { lrfe_rt: cookie } });
        expect(refreshed.statusCode).to.equal(200);
        const setCookie = refreshed.cookies.find(c => c.name === 'lrfe_rt');
        expect(setCookie).to.include({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });

        const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { lrfe_rt: setCookie.value } });
        expect(out.statusCode).to.equal(200);
        const after = await app.inject({ method: 'POST', url: '/auth/refresh', cookies: { lrfe_rt: setCookie.value } });
        expect(after.statusCode).to.equal(401);
    });

    it('two-step MFA sign-in with a challenge token', async () => {
        const { app, clock } = await makeApp({ mfa: true });
        const step1 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'm.nakale@oag.gov.na', password: PASSWORD } });
        expect(step1.json()).to.include({ next: 'mfa-enroll' });
        expect(step1.json()).to.not.have.property('userId');

        const bad = await app.inject({ method: 'POST', url: '/auth/mfa', payload: { challenge: 'not-a-jwt', code: '123456' } });
        expect(bad.statusCode).to.equal(401);

        const step2 = await app.inject({ method: 'POST', url: '/auth/mfa', payload: { challenge: step1.json().challenge, code: codeFor(step1.json().secret, clock) } });
        expect(step2.statusCode).to.equal(200);
        expect(step2.json().me.user.mfa).to.equal(true);
    });

    it('the MFA challenge cannot be used as an access token', async () => {
        const { app } = await makeApp({ mfa: true });
        const step1 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'm.nakale@oag.gov.na', password: PASSWORD } });
        const res = await app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${step1.json().challenge}` } });
        expect(res.statusCode).to.equal(401);
    });

    it('enforces permissions server-side and writes denials to the access log', async () => {
        const { app, login, auth } = await makeApp();
        const scan = await login('k.iipinge@deeds.gov.na');
        const denied = await app.inject({ url: '/users', headers: auth(scan.token) });
        expect(denied.statusCode).to.equal(403);

        const admin = await login('p.hamutenya@deeds.gov.na');
        const log = await app.inject({ url: '/access-log?kind=denied', headers: auth(admin.token) });
        expect(log.json().items[0]).to.include({ action: 'Access denied', target: 'Kristofina Iipinge', detail: 'Manage users' });
    });

    it('admin flows: list, invite, change roles, suspend, policies, matrix', async () => {
        const { app, login, auth } = await makeApp();
        const { token } = await login('p.hamutenya@deeds.gov.na');
        const h = auth(token);

        const list = await app.inject({ url: '/users', headers: h });
        expect(list.json().users).to.have.length(14);

        const invite = await app.inject({ method: 'POST', url: '/users', headers: h, payload: { name: 'Nelao Amutenya', email: 'n.amutenya@deeds.gov.na', roles: ['rev'] } });
        expect(invite.statusCode).to.equal(201);
        const id = invite.json().user.id;

        const badRole = await app.inject({ method: 'PUT', url: `/users/${id}/roles`, headers: h, payload: { roles: ['wizard'] } });
        expect(badRole.statusCode).to.equal(400);
        const roles = await app.inject({ method: 'PUT', url: `/users/${id}/roles`, headers: h, payload: { roles: ['rev', 'aud'] } });
        expect(roles.json().conflicts).to.deep.equal(['sod1']);

        const suspend = await app.inject({ method: 'POST', url: `/users/${id}/suspend`, headers: h });
        expect(suspend.json().status).to.equal('Suspended');

        const policies = await app.inject({ url: '/policies', headers: h });
        expect(policies.json().sod).to.have.length(4);

        const matrix = await app.inject({ method: 'PUT', url: '/roles/permissions', headers: h, payload: { matrix: { scan: ['dashboard.view', 'capture.view'] } } });
        expect(matrix.json().changes).to.equal(2);
    });

    it('registrar can manage users but not roles or policies', async () => {
        const { app, login, auth } = await makeApp();
        const { token } = await login('e.shivute@deeds.gov.na');
        expect((await app.inject({ url: '/users', headers: auth(token) })).statusCode).to.equal(200);
        expect((await app.inject({ url: '/policies', headers: auth(token) })).statusCode).to.equal(200);
        expect((await app.inject({ method: 'PUT', url: '/roles/permissions', headers: auth(token), payload: { matrix: {} } })).statusCode).to.equal(403);
    });

    it('accepts an invitation publicly', async () => {
        const { app, login, auth } = await makeApp();
        const { token } = await login('p.hamutenya@deeds.gov.na');
        const invite = await app.inject({ method: 'POST', url: '/users', headers: auth(token), payload: { name: 'N A', email: 'na@deeds.gov.na', roles: ['scan'] } });
        const inviteToken = invite.json().inviteUrl.split('token=')[1];
        const res = await app.inject({ method: 'POST', url: '/invitations/accept', payload: { token: decodeURIComponent(inviteToken), password: 'a long enough passphrase' } });
        expect(res.statusCode).to.equal(200);
        expect(res.json()).to.deep.equal({ email: 'na@deeds.gov.na' });
    });
});
