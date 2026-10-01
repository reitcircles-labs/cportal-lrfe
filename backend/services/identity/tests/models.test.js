import { expect } from 'chai';
import { Sequelize } from 'sequelize';
import { defineModels } from '../src/repo/models.js';
import { makeService, PASSWORD } from './helpers.js';

// Constructing Sequelize never connects; defining models needs no database.
const models = defineModels(new Sequelize('postgres://u:p@localhost:1/none', { logging: false }));
const attrs = (model) => Object.keys(model.getAttributes());

describe('identity Postgres models', () => {
    it('every attribute maps to its own column', () => {
        for (const model of Object.values(models)) {
            for (const [name, attr] of Object.entries(model.getAttributes())) expect(attr.field, `${model.name}.${name}`).to.equal(name);
        }
    });

    it('every field the service writes exists in the model', async () => {
        const { service, repo, user } = await makeService({ mfa: true });
        const first = await service.login({ email: 'k.iipinge@deeds.gov.na', password: PASSWORD });
        const admin = await user('p.hamutenya@deeds.gov.na');
        await service.invite({ name: 'N', email: 'n@x.na', roles: ['scan'] }, { id: admin.id, name: admin.name });

        // users: `roles` lives in user_role, everything else must be a column
        for (const u of await repo.listUsers()) {
            const { roles, ...columns } = u;
            expect(attrs(models.User)).to.include.members(Object.keys(columns));
        }
        expect((await user('k.iipinge@deeds.gov.na')).pendingMfaSecret).to.be.a('string');
        for (const r of await repo.listRoles()) expect(attrs(models.Role)).to.include.members(Object.keys(r));
        const { items } = await repo.listAccessEvents({});
        for (const { id, ...e } of items) expect(attrs(models.AccessEvent)).to.include.members(Object.keys(e));
        expect(first.next).to.equal('mfa-enroll');
    });
});
