import { expect } from 'chai';
import { makeService, makeApp } from './helpers.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { seedIdentity } from '../src/seed.js';
import { ROLES, DEFAULT_OFFICES } from '../src/catalogue.js';

const ADMIN = 'p.hamutenya@deeds.gov.na';

async function rejects(promise, status, message) {
    try { await promise; } catch (err) {
        if (status) expect(err.statusCode).to.equal(status);
        if (message) expect(err.message).to.include(message);
        return err;
    }
    throw new Error('expected a rejection');
}

describe('offices', () => {
    async function setup() {
        const ctx = await makeService();
        const admin = await ctx.user(ADMIN);
        return { ...ctx, actor: { id: admin.id, name: admin.name } };
    }

    it('adds an office with a fixed, upper-case code; refuses bad or duplicate codes', async () => {
        const { service, actor, repo } = await setup();
        const kmp = await service.createOffice({ code: 'kmp', name: ' Keetmanshoop sub-registry ', type: 'registry', contact: '063 222 000' }, actor);
        expect(kmp).to.include({ code: 'KMP', name: 'Keetmanshoop sub-registry', status: 'Active', users: 0 });
        await rejects(service.createOffice({ code: 'KMP', name: 'Again' }, actor), 409, 'already exists');
        await rejects(service.createOffice({ code: 'K', name: 'Too short' }, actor), 400, '2 to 5 letters');
        await rejects(service.createOffice({ code: 'AB12', name: 'Digits' }, actor), 400);
        await rejects(service.createOffice({ code: 'OAG', name: '' }, actor), 400, 'Name');
        const { items } = await repo.listAccessEvents({ kind: 'office' });
        expect(items.map(e => e.action)).to.deep.equal(['Office added']);
        expect(items[0]).to.include({ target: 'KMP · Keetmanshoop sub-registry', detail: 'Registry office', actor: 'Paulus Hamutenya' });
    });

    it('renames an office but never changes its code', async () => {
        const { service, actor, office } = await setup();
        const res = await service.updateOffice(office.id, { name: 'Windhoek Deeds Registry', code: 'XXX' }, actor);
        expect(res).to.include({ code: 'WDH', name: 'Windhoek Deeds Registry' });
    });

    it('invites into an active office; only administrators may have no office', async () => {
        const { service, actor, office } = await setup();
        const { user } = await service.invite({ name: 'Ndapewa Shikongo', email: 'n.s@deeds.gov.na', officeId: office.id, roles: ['scan'] }, actor);
        expect(user).to.include({ officeId: office.id, officeCode: 'WDH', office: 'Deeds Registry · Windhoek' });
        await rejects(service.invite({ name: 'No Office', email: 'no@deeds.gov.na', roles: ['rev'] }, actor), 400, 'Choose an office');
        const { user: admin } = await service.invite({ name: 'National Admin', email: 'nat@deeds.gov.na', roles: ['adm'] }, actor);
        expect(admin).to.include({ officeId: null, office: '' });
        await rejects(service.invite({ name: 'Bad', email: 'bad@deeds.gov.na', officeId: '00000000-0000-4000-8000-000000000000', roles: ['rev'] }, actor), 400, 'does not exist');
        expect((await service.listOffices()).find(o => o.code === 'WDH').users).to.equal(1);
    });

    it('a suspended office takes no new invitations or resends; its users carry on', async () => {
        const { service, actor, office, repo } = await setup();
        const { user } = await service.invite({ name: 'Already In', email: 'in@deeds.gov.na', officeId: office.id, roles: ['scan'] }, actor);
        const suspended = await service.setOfficeStatus(office.id, 'Suspended', '', actor);
        expect(suspended.status).to.equal('Suspended');
        await rejects(service.invite({ name: 'Late', email: 'late@deeds.gov.na', officeId: office.id, roles: ['scan'] }, actor), 409, 'suspended');
        await rejects(service.resendInvite(user.id, actor), 409, 'suspended');
        expect((await repo.getUser(user.id)).status).to.equal('Invited');          // the user is untouched
        await service.setOfficeStatus(office.id, 'Active', '', actor);
        await service.invite({ name: 'Late', email: 'late@deeds.gov.na', officeId: office.id, roles: ['scan'] }, actor);
        const { items } = await repo.listAccessEvents({ kind: 'office' });
        expect(items.map(e => e.action)).to.include.members(['Office suspended', 'Office reactivated']);
    });

    it('moves a user to another office; only administrators may be moved to none', async () => {
        const { service, actor, office, repo } = await setup();
        const kmp = await service.createOffice({ code: 'KMP', name: 'Keetmanshoop sub-registry' }, actor);
        const { user } = await service.invite({ name: 'Mover', email: 'mover@deeds.gov.na', officeId: office.id, roles: ['rev'] }, actor);
        const moved = await service.setUserOffice(user.id, kmp.id, actor);
        expect(moved).to.include({ officeCode: 'KMP' });
        await rejects(service.setUserOffice(user.id, null, actor), 400, 'Choose an office');
        await service.setOfficeStatus(office.id, 'Suspended', '', actor);
        await rejects(service.setUserOffice(user.id, office.id, actor), 409, 'suspended');
        const admin = await repo.getUserByEmail(ADMIN);
        expect((await service.setUserOffice(admin.id, null, actor)).officeId).to.equal(null);
        const { items } = await repo.listAccessEvents({ kind: 'user' });
        expect(items.find(e => e.action === 'Office changed')).to.include({ target: 'Mover', detail: 'WDH → KMP' });
    });

    it('grants the new permission once to existing roles, and respects its later removal', async () => {
        const repo = createMemoryRepo();
        // a database seeded before offices existed: roles without admin.offices, no catalogue version
        for (const r of ROLES) await repo.upsertRole({ ...r, perms: r.perms.filter(p => p !== 'admin.offices') });
        await seedIdentity(repo, {});
        expect((await repo.listRoles()).find(r => r.id === 'adm').perms).to.include('admin.offices');
        expect((await repo.listRoles()).find(r => r.id === 'sup').perms).to.not.include('admin.offices');
        // an administrator removes it again; the next start must not put it back
        const adm = (await repo.listRoles()).find(r => r.id === 'adm');
        await repo.updateRolePerms('adm', adm.perms.filter(p => p !== 'admin.offices'));
        await seedIdentity(repo, {});
        expect((await repo.listRoles()).find(r => r.id === 'adm').perms).to.not.include('admin.offices');
    });

    it('creates the default offices only in a database without offices', async () => {
        const empty = createMemoryRepo();
        await seedIdentity(empty, { offices: DEFAULT_OFFICES });
        expect((await empty.listOffices()).map(o => `${o.code} ${o.status}`)).to.deep.equal(['REH Active', 'WDH Active']);
        // later starts change nothing: a renamed or suspended default stays as the admin left it
        const reh = await empty.getOfficeByCode('REH');
        await empty.updateOffice(reh.id, { name: 'Rehoboth office', status: 'Suspended' });
        await seedIdentity(empty, { offices: DEFAULT_OFFICES });
        expect(await empty.getOfficeByCode('REH')).to.include({ name: 'Rehoboth office', status: 'Suspended' });
        expect(await empty.listOffices()).to.have.length(2);

        const existing = createMemoryRepo();
        await existing.createOffice({ code: 'KMP', name: 'Somewhere else' });
        await seedIdentity(existing, { offices: DEFAULT_OFFICES });
        expect((await existing.listOffices()).map(o => o.code)).to.deep.equal(['KMP']);
    });

    it('HTTP: anyone who invites may list offices; only admin.offices may change them', async () => {
        const { app, login, auth } = await makeApp();
        const admin = await login(ADMIN);
        const supervisor = await login('e.shivute@deeds.gov.na');            // admin.users, not admin.offices
        const scan = await login('k.iipinge@deeds.gov.na');
        expect((await app.inject({ url: '/offices', headers: auth(supervisor.token) })).statusCode).to.equal(200);
        expect((await app.inject({ url: '/offices', headers: auth(scan.token) })).statusCode).to.equal(403);
        const add = (token, payload) => app.inject({ method: 'POST', url: '/offices', headers: auth(token), payload });
        expect((await add(supervisor.token, { code: 'OAG', name: 'Office of the Auditor-General' })).statusCode).to.equal(403);
        const created = await add(admin.token, { code: 'OAG', name: 'Office of the Auditor-General', type: 'external' });
        expect(created.statusCode).to.equal(201);
        const id = created.json().id;
        const rename = await app.inject({ method: 'PUT', url: `/offices/${id}`, headers: auth(admin.token), payload: { code: 'XYZ' } });
        expect(rename.json().code).to.equal('OAG');                              // unknown fields are dropped: the code never changes
        expect((await app.inject({ method: 'POST', url: `/offices/${id}/suspend`, headers: auth(admin.token) })).json().status).to.equal('Suspended');
        const list = (await app.inject({ url: '/offices', headers: auth(admin.token) })).json().offices;
        expect(list.map(o => o.code)).to.deep.equal(['OAG', 'WDH']);
    });
});
