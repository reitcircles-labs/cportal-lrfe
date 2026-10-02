import { expect } from 'chai';
import { makeService, codeFor, PASSWORD } from './helpers.js';

const ADMIN = 'p.hamutenya@deeds.gov.na';
const SCAN = 'k.iipinge@deeds.gov.na';

async function rejects(promise, statusCode, messagePart) {
    try {
        await promise;
    } catch (err) {
        expect(err.statusCode, err.message).to.equal(statusCode);
        if (messagePart) expect(err.message).to.include(messagePart);
        return err;
    }
    throw new Error(`expected a ${statusCode} error`);
}

describe('IdentityService', () => {
    describe('sign-in', () => {
        it('signs in with password when MFA is not required and returns perms for the role', async () => {
            const { service, published } = await makeService();
            const res = await service.login({ email: ' K.Iipinge@deeds.gov.na ', password: PASSWORD });
            expect(res.next).to.equal('done');
            expect(res.claims).to.include({ typ: 'access', name: 'Kristofina Iipinge' });
            expect(res.claims.perms).to.deep.equal(['dashboard.view', 'capture.view', 'capture.scan', 'capture.rescan']);
            expect(res.me.home).to.equal('/capture');
            expect(res.refreshToken).to.match(/^[0-9a-f-]{36}\.[\w-]+$/);
            expect(published.map(e => e.type)).to.include('identity.session');
        });

        it('rejects a wrong password and a suspended user, and logs both', async () => {
            const { service, repo } = await makeService();
            await rejects(service.login({ email: SCAN, password: 'nope' }), 401);
            await rejects(service.login({ email: 'nobody@x.na', password: 'nope' }), 401);
            await rejects(service.login({ email: 'f.katjiuongua@deeds.gov.na', password: PASSWORD }), 403);
            const { items } = await repo.listAccessEvents({ kind: 'denied' });
            expect(items.map(e => e.action)).to.deep.equal(['Sign-in blocked', 'Sign-in failed', 'Sign-in failed']);
        });

        it('invited users cannot sign in', async () => {
            const { service } = await makeService();
            await rejects(service.login({ email: 's.uirab@oag.gov.na', password: PASSWORD }), 401);
        });

        it('enrols MFA on first sign-in when policy requires it, then asks for a code', async () => {
            const { service, clock, user } = await makeService({ mfa: true });
            const first = await service.login({ email: SCAN, password: PASSWORD });
            expect(first.next).to.equal('mfa-enroll');
            expect(first.otpauthUrl).to.include('otpauth://totp/');
            await rejects(service.verifyMfa({ userId: first.userId, code: '000000' }), 401);

            const done = await service.verifyMfa({ userId: first.userId, code: codeFor(first.secret, clock) });
            expect(done.claims.sub).to.equal(first.userId);
            expect((await user(SCAN)).mfaEnrolled).to.equal(true);

            const second = await service.login({ email: SCAN, password: PASSWORD });
            expect(second).to.deep.equal({ next: 'mfa', userId: first.userId });
            const secret = (await user(SCAN)).mfaSecret;
            expect(secret).to.equal(first.secret);
        });
    });

    describe('sessions', () => {
        it('rotates the refresh token and rejects the old one (and then the whole session)', async () => {
            const { service } = await makeService();
            const { refreshToken } = await service.login({ email: SCAN, password: PASSWORD });
            const next = await service.refresh(refreshToken);
            expect(next.refreshToken).to.not.equal(refreshToken);
            await rejects(service.refresh(refreshToken), 401);
            await rejects(service.refresh(next.refreshToken), 401, 'Session expired');
        });

        it('expires a session idle for longer than the policy timeout', async () => {
            const { service, clock } = await makeService();
            const { refreshToken } = await service.login({ email: SCAN, password: PASSWORD });
            clock.advance(29 * 60_000);
            const next = await service.refresh(refreshToken);
            clock.advance(31 * 60_000);
            await rejects(service.refresh(next.refreshToken), 401);
        });

        it('suspending a user ends their sessions', async () => {
            const { service, user } = await makeService();
            const admin = await user(ADMIN);
            const { refreshToken } = await service.login({ email: SCAN, password: PASSWORD });
            await service.setStatus((await user(SCAN)).id, 'Suspended', 'Left the registry', { id: admin.id, name: admin.name });
            await rejects(service.refresh(refreshToken), 401);
        });

        it('logout revokes the session', async () => {
            const { service } = await makeService();
            const { refreshToken, claims } = await service.login({ email: SCAN, password: PASSWORD });
            await service.logout({ sid: claims.sid });
            await rejects(service.refresh(refreshToken), 401);
        });
    });

    describe('users', () => {
        it('lists users with SoD conflicts flagged', async () => {
            const { service } = await makeService();
            const users = await service.listUsers();
            expect(users).to.have.length(14);
            // Willem Beukes is reviewer + auditor: verify.file and audit.signoff (sod1)
            expect(users.find(u => u.name === 'Willem Beukes').conflicts).to.deep.equal(['sod1']);
            expect(users.find(u => u.name === 'Aina Mwandingi').conflicts).to.deep.equal([]);
            expect(users[0]).to.not.have.any.keys('passwordHash', 'mfaSecret', 'inviteHash');
        });

        it('invites a user who can then accept and sign in', async () => {
            const { service, user, office } = await makeService();
            const admin = await user(ADMIN);
            const { user: invited, inviteUrl } = await service.invite(
                { name: 'Nelao Amutenya', email: 'N.Amutenya@deeds.gov.na', officeId: office.id, roles: ['rev'] },
                { id: admin.id, name: admin.name });
            expect(invited).to.include({ status: 'Invited', email: 'n.amutenya@deeds.gov.na' });
            const token = new URL(inviteUrl.replace('#/', '')).searchParams.get('token');

            await rejects(service.acceptInvite({ token, password: 'short' }), 400);
            await service.acceptInvite({ token, password: 'a long enough passphrase' });
            await rejects(service.acceptInvite({ token, password: 'a long enough passphrase' }), 400);
            const res = await service.login({ email: 'n.amutenya@deeds.gov.na', password: 'a long enough passphrase' });
            expect(res.next).to.equal('done');
        });

        it('rejects duplicate emails, unknown roles and expired invitations', async () => {
            const { service, user, clock, office } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            await rejects(service.invite({ name: 'X', email: SCAN, officeId: office.id, roles: ['scan'] }, actor), 409);
            await rejects(service.invite({ name: 'X', email: 'x@x.na', officeId: office.id, roles: ['wizard'] }, actor), 400);
            const { inviteUrl } = await service.invite({ name: 'X', email: 'x@x.na', officeId: office.id, roles: ['scan'] }, actor);
            clock.advance(73 * 3_600_000);
            const token = new URL(inviteUrl.replace('#/', '')).searchParams.get('token');
            await rejects(service.acceptInvite({ token, password: 'a long enough passphrase' }), 400, 'expired');
        });

        it('changes roles and logs the difference; refuses self-changes', async () => {
            const { service, user, repo } = await makeService();
            const admin = await user(ADMIN), scan = await user(SCAN);
            const actor = { id: admin.id, name: admin.name };
            const updated = await service.setUserRoles(scan.id, ['scan', 'rev'], actor);
            expect(updated.roles).to.deep.equal(['scan', 'rev']);
            const { items } = await repo.listAccessEvents({ kind: 'user' });
            expect(items[0]).to.include({ action: 'Roles changed', target: 'Kristofina Iipinge', detail: '+ Metadata reviewer' });
            await rejects(service.setUserRoles(admin.id, ['sup'], actor), 403);
            await rejects(service.setStatus(admin.id, 'Suspended', '', actor), 403);
        });

        it('logs a role change that breaks a duty rule as an accepted exception', async () => {
            const { service, user, repo } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            await service.setUserRoles((await user('a.mwandingi@deeds.gov.na')).id, ['rev', 'aud'], actor);
            const { items } = await repo.listAccessEvents({ kind: 'user' });
            expect(items[0]).to.include({
                action: 'Roles changed', target: 'Aina Mwandingi',
                detail: '+ Auditor · read-only · duty conflict accepted: Reviewers cannot audit documents they can file'
            });
            // Someone already in conflict who gains a role that breaks no further rule: no new exception.
            // (Records officer would: finalizing + signing off audits is another rule.)
            await service.setUserRoles((await user('w.beukes@deeds.gov.na')).id, ['rev', 'aud', 'scan'], actor);
            const after = await repo.listAccessEvents({ kind: 'user' });
            expect(after.items[0].detail).to.not.include('duty conflict');
        });

        it('notes the duty rules broken by an invitation', async () => {
            const { service, user, repo, office } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            await service.invite({ name: 'Both Hats', email: 'both@deeds.gov.na', officeId: office.id, roles: ['rev', 'aud'] }, actor);
            const { items } = await repo.listAccessEvents({ kind: 'user' });
            expect(items[0].action).to.equal('Invited');
            expect(items[0].detail).to.include('Roles: Metadata reviewer, Auditor · read-only · duty conflict accepted: Reviewers cannot audit documents they can file');
        });

        it('never leaves the system without an active roles administrator', async () => {
            const { service, user } = await makeService();
            const admin = await user(ADMIN), sup = await user('e.shivute@deeds.gov.na');
            // Registrar has admin.users, so can act on the only admin — but not strip the last admin.roles holder.
            await rejects(service.setUserRoles(admin.id, ['sup'], { id: sup.id, name: sup.name }), 409);
            await rejects(service.setStatus(admin.id, 'Suspended', '', { id: sup.id, name: sup.name }), 409);
        });

        it('reactivates a suspended user; a never-activated user goes back to Invited', async () => {
            const { service, user } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            const frieda = await service.setStatus((await user('f.katjiuongua@deeds.gov.na')).id, 'Active', '', actor);
            expect(frieda.status).to.equal('Active');
            const simon = await user('s.uirab@oag.gov.na');
            await service.setStatus(simon.id, 'Suspended', '', actor);
            expect((await service.setStatus(simon.id, 'Active', '', actor)).status).to.equal('Invited');
            await rejects(service.setStatus(simon.id, 'Active', '', actor), 409);
        });

        it('resets MFA', async () => {
            const { service, user } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            await service.repo.updateUser((await user(SCAN)).id, { mfaEnrolled: true, mfaSecret: 'ABC' });
            const res = await service.resetMfa((await user(SCAN)).id, actor);
            expect(res.mfa).to.equal(false);
            expect((await user(SCAN)).mfaSecret).to.equal(null);
        });
    });

    describe('roles & policies', () => {
        it('has exactly the six fixed roles', async () => {
            const { service } = await makeService();
            expect((await service.listRoles()).map(r => r.id)).to.deep.equal(['sup', 'scan', 'rev', 'rec', 'aud', 'adm']);
        });

        it('saves the permission matrix, logging per role', async () => {
            const { service, user, repo } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            const rev = (await service.listRoles()).find(r => r.id === 'rev');
            const res = await service.saveMatrix({ rev: rev.perms.filter(p => p !== 'capture.rescan') }, actor);
            expect(res.changes).to.equal(1);
            const { items } = await repo.listAccessEvents({ kind: 'role' });
            expect(items[0]).to.include({ action: 'Permissions changed', target: 'Metadata reviewer', detail: '− Flag pages for rescan' });
            // Takes effect at the next sign-in / token refresh:
            const login = await service.login({ email: 'a.mwandingi@deeds.gov.na', password: PASSWORD });
            expect(login.claims.perms).to.not.include('capture.rescan');
        });

        it('logs the users a permission change puts in conflict', async () => {
            const { service, user, repo } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            const rev = (await service.listRoles()).find(r => r.id === 'rev');
            await service.saveMatrix({ rev: [...rev.perms, 'audit.signoff'] }, actor);
            const { items } = await repo.listAccessEvents({ kind: 'role' });
            expect(items[0].action).to.equal('Duty conflict accepted');
            // every active or invited reviewer, but not Willem Beukes, who was in conflict already
            expect(items[0].detail).to.include('Aina Mwandingi (Reviewers cannot audit documents they can file)');
            expect(items[0].detail).to.not.include('Willem Beukes');
            expect(items[1]).to.include({ action: 'Permissions changed', target: 'Metadata reviewer', detail: '+ Sign off & raise findings' });
        });

        it('rejects unknown roles/permissions and removing admin.roles from everyone', async () => {
            const { service, user } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            await rejects(service.saveMatrix({ wizard: [] }, actor), 400);
            await rejects(service.saveMatrix({ rev: ['fly'] }, actor), 400);
            await rejects(service.saveMatrix({ adm: ['dashboard.view'] }, actor), 409);
        });

        it('saves policies and SoD switches with a change summary', async () => {
            const { service, user, repo } = await makeService();
            const actor = { id: (await user(ADMIN)).id, name: 'Admin' };
            const res = await service.savePolicies({
                policies: { mfa: false, eid: true, ipAllow: false, timeout: 45, fourEyes: true },
                sod: [{ id: 'sod4', on: true }, { id: 'sod1', on: true }]
            }, actor);
            expect(res.changes).to.equal(2);
            expect(res.sod.find(r => r.id === 'sod4').on).to.equal(true);
            const { items } = await repo.listAccessEvents({ kind: 'policy' });
            // David Garoeb (scan + review) already breaks the rule being enabled: logged as an exception (API-611)
            expect(items[0].detail).to.equal('Session timeout 30 → 45 min · Enabled: Scan operators cannot file what they capture (duty conflict accepted for 1 user: David Garoeb)');
            await rejects(service.savePolicies({ policies: { ...res.policies, timeout: 1 } }, actor), 400);
            await rejects(service.savePolicies({ policies: res.policies, sod: [{ id: 'sod99', on: true }] }, actor), 400);
        });
    });
});
