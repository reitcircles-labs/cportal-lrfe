import { expect } from 'chai';
import { makeService, codeFor, PASSWORD } from './helpers.js';
import { resetPassword } from '../src/reset-password.js';

const ADMIN = 'p.hamutenya@deeds.gov.na';
const NEW_PASSWORD = 'a brand new password 2026';

async function rejects(promise, message) {
    try { await promise; } catch (err) { if (message) expect(err.message).to.include(message); return err; }
    throw new Error('expected a rejection');
}

describe('resetPassword (command line)', () => {
    it('sets the new password: it signs in, the old one no longer does', async () => {
        const { service, repo, clock } = await makeService();
        await resetPassword(repo, { email: ` ${ADMIN.toUpperCase()} `, password: NEW_PASSWORD, clock });
        expect((await service.login({ email: ADMIN, password: NEW_PASSWORD })).next).to.equal('done');
        await rejects(service.login({ email: ADMIN, password: PASSWORD }));
    });

    it('ends existing sessions and records the reset in the access log', async () => {
        const { service, repo, clock } = await makeService();
        const { refreshToken } = await service.login({ email: ADMIN, password: PASSWORD });
        clock.advance(1000);
        await resetPassword(repo, { email: ADMIN, password: NEW_PASSWORD, clock });
        await rejects(service.refresh(refreshToken));
        const { items } = await repo.listAccessEvents({ kind: 'user' });
        expect(items.map(e => e.action)).to.include('Password reset');
        expect(items.find(e => e.action === 'Password reset')).to.include({ target: 'Paulus Hamutenya', actor: 'System (command line)' });
    });

    it('keeps MFA unless asked; with resetMfa the user enrols again', async () => {
        const { service, repo, clock } = await makeService({ mfa: true });
        const first = await service.login({ email: ADMIN, password: PASSWORD });
        await service.verifyMfa({ userId: first.userId, code: codeFor(first.secret, clock) });

        await resetPassword(repo, { email: ADMIN, password: NEW_PASSWORD, clock });
        expect((await service.login({ email: ADMIN, password: NEW_PASSWORD })).next).to.equal('mfa');

        await resetPassword(repo, { email: ADMIN, password: NEW_PASSWORD, resetMfa: true, clock });
        expect((await service.login({ email: ADMIN, password: NEW_PASSWORD })).next).to.equal('mfa-enroll');
        const { items } = await repo.listAccessEvents({ kind: 'user' });
        expect(items.map(e => e.action)).to.include('MFA reset');
    });

    it('refuses an unknown user or a short password, changing nothing', async () => {
        const { service, repo } = await makeService();
        await rejects(resetPassword(repo, { email: 'nobody@deeds.gov.na', password: NEW_PASSWORD }), 'No user');
        await rejects(resetPassword(repo, { email: ADMIN, password: 'short' }), 'at least 12');
        await rejects(resetPassword(repo, { email: '', password: NEW_PASSWORD }), 'email');
        expect((await service.login({ email: ADMIN, password: PASSWORD })).next).to.equal('done');
    });

    it('leaves status alone and warns when the user cannot sign in anyway', async () => {
        const { repo } = await makeService();
        const suspended = await resetPassword(repo, { email: 'f.katjiuongua@deeds.gov.na', password: NEW_PASSWORD });
        expect(suspended.user.status).to.equal('Suspended');
        expect(suspended.warnings[0]).to.include('suspended');
        const invited = await resetPassword(repo, { email: 's.uirab@oag.gov.na', password: NEW_PASSWORD });
        expect(invited.user.status).to.equal('Invited');
        expect(invited.warnings[0]).to.include('invitation');
    });
});
