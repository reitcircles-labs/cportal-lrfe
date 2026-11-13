import {expect} from 'chai';
import {Sequelize} from 'sequelize';
import {ensureSchema} from '@lrfe/common';
import {makeService, makeApp, PASSWORD} from './helpers.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {createSequelizeRepo} from '../src/repo/sequelize.js';
import {SCHEMA} from '../src/repo/models.js';
import {DEFAULT_ORGANISATION_KEY, seedIdentity} from '../src/seed.js';
import {ROLES, organisationCodeOf} from '../src/catalogue.js';

const ADMIN = 'p.hamutenya@deeds.gov.na';
const SUPERVISOR = 'e.shivute@deeds.gov.na'; // admin.users, not admin.organisations
const SCAN = 'k.iipinge@deeds.gov.na';
const BLOCKED = 'This account is suspended. Contact a system administrator.';

async function rejects(promise, status, message) {
  try {
    await promise;
  } catch (err) {
    if (status) expect(err.statusCode).to.equal(status);
    if (message) expect(err.message).to.include(message);
    return err;
  }
  throw new Error('expected a rejection');
}

/**
 * The upgrade on one repository: run on an empty database, then on one from before organisations.
 * @param {function(): !Promise<{repo: !Object, before: function(): !Promise}>} open a fresh
 *     database; `before()` turns it back into one from before CB-19 (data kept)
 */
function upgradeTests(open) {
  it('an empty database gets one default organisation, named from the setting, holding everyone', async () => {
    const {repo} = await open();
    await seedIdentity(repo, {
      demoPassword: PASSWORD,
      offices: [
        {code: 'HQ', name: 'Head office', type: 'registry'},
        {code: 'NTH', name: 'North office', type: 'registry'},
      ],
      organisationName: 'Land Registry',
    });
    const organisations = await repo.listOrganisations();
    expect(
      organisations.map(o => `${o.code} ${o.name} ${o.status}`),
    ).to.deep.equal(['LR Land Registry Active']);
    const [organisation] = organisations;
    expect(await repo.getSetting(DEFAULT_ORGANISATION_KEY)).to.equal(
      organisation.id,
    );
    const offices = await repo.listOffices();
    expect(offices).to.have.length(2);
    expect(offices.every(o => o.organisationId === organisation.id)).to.equal(
      true,
    );
    const users = await repo.listUsers();
    expect(users.length).to.be.greaterThan(1);
    expect(users.every(u => u.organisationId === organisation.id)).to.equal(
      true,
    );

    // idempotent: the next start changes nothing, even with another name set since
    await repo.updateOrganisation(organisation.id, {name: 'Renamed'});
    await seedIdentity(repo, {
      demoPassword: PASSWORD,
      organisationName: 'Another name',
    });
    expect(
      (await repo.listOrganisations()).map(o => `${o.code} ${o.name}`),
    ).to.deep.equal(['LR Renamed']);
  });

  it('an existing database: offices and users without an organisation join the new default one', async () => {
    const {repo, before} = await open();
    await seedIdentity(repo, {demoPassword: PASSWORD});
    await repo.createOffice({code: 'WDH', name: 'Windhoek', type: 'registry'});
    await before();
    const office = await repo.getOfficeByCode('WDH');
    expect(office.organisationId ?? null).to.equal(null);
    expect((await repo.getUserByEmail(ADMIN)).organisationId ?? null).to.equal(
      null,
    );
    expect(await repo.listOrganisations()).to.deep.equal([]);
    const usersBefore = await repo.listUsers();

    await seedIdentity(repo, {organisationName: 'Deeds Registry'});
    const [organisation, ...others] = await repo.listOrganisations();
    expect(others).to.deep.equal([]);
    expect(organisation).to.include({
      code: 'DR',
      name: 'Deeds Registry',
      status: 'Active',
    });
    expect((await repo.getOfficeByCode('WDH')).organisationId).to.equal(
      organisation.id,
    );
    const users = await repo.listUsers();
    expect(users).to.have.length(usersBefore.length);
    for (const user of users) {
      const old = usersBefore.find(u => u.id === user.id);
      expect(user.organisationId).to.equal(organisation.id);
      // nothing else about the user changes
      expect(user).to.include({
        status: old.status,
        email: old.email,
        officeId: old.officeId ?? null,
      });
    }
    // the administrator role gains the new permission once
    expect((await repo.listRoles()).find(r => r.id === 'adm').perms).to.include(
      'admin.organisations',
    );
  });
}

describe('organisations (CB-19)', () => {
  async function setup(opts) {
    const ctx = await makeService(opts);
    const admin = await ctx.user(ADMIN);
    const organisationId = await ctx.repo.getSetting(DEFAULT_ORGANISATION_KEY);
    return {
      ...ctx,
      actor: {id: admin.id, name: admin.name},
      defaultOrg: await ctx.repo.getOrganisation(organisationId),
    };
  }

  describe('upgrade, in memory', () => {
    upgradeTests(async () => {
      const repo = createMemoryRepo();
      return {
        repo,
        // a memory store from before CB-19 has no organisations and nobody in one
        before: async () => {
          const fresh = createMemoryRepo();
          for (const role of await repo.listRoles()) {
            await fresh.upsertRole({
              ...role,
              perms: role.perms.filter(p => p !== 'admin.organisations'),
            });
          }
          await fresh.saveSod(await repo.listSod());
          await fresh.savePolicies(await repo.getPolicies());
          await fresh.setSetting('catalogue.version', 4);
          for (const o of await repo.listOffices()) {
            await fresh.createOffice({...o, organisationId: null});
          }
          for (const u of await repo.listUsers()) {
            await fresh.createUser({...u, organisationId: null});
          }
          Object.assign(repo, fresh);
        },
      };
    });
  });

  // Runs only with a throwaway PostgreSQL database: IDENTITY_TEST_DATABASE_URL (its identity schema
  // is dropped and made again for each test).
  const pgUrl = process.env.IDENTITY_TEST_DATABASE_URL;
  (pgUrl ? describe : describe.skip)('upgrade, on PostgreSQL', function () {
    this.timeout(60_000);
    let sequelize;
    before(() => {
      sequelize = new Sequelize(pgUrl, {logging: false});
    });
    after(() => sequelize.close());

    upgradeTests(async () => {
      await sequelize.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await ensureSchema(sequelize, SCHEMA);
      const repo = createSequelizeRepo(sequelize);
      await repo.sync();
      return {
        repo,
        // the schema of the version before CB-19, with its data; then the upgrade's sync
        before: async () => {
          const q = (sql, replacements) => sequelize.query(sql, {replacements});
          await q(
            `ALTER TABLE "${SCHEMA}"."user" DROP COLUMN "organisationId"`,
          );
          await q(
            `ALTER TABLE "${SCHEMA}"."office" DROP COLUMN "organisationId"`,
          );
          await q(`DROP TABLE "${SCHEMA}"."organisation"`);
          await q(`DROP TYPE "${SCHEMA}"."enum_organisation_status"`);
          await q(`DELETE FROM "${SCHEMA}"."setting" WHERE key = :key`, {
            key: DEFAULT_ORGANISATION_KEY,
          });
          await q(
            `UPDATE "${SCHEMA}"."setting" SET value = '4' WHERE key = :key`,
            {
              key: 'catalogue.version',
            },
          );
          const adm = (await repo.listRoles()).find(r => r.id === 'adm');
          await repo.updateRolePerms(
            'adm',
            adm.perms.filter(p => p !== 'admin.organisations'),
          );
          await repo.sync();
          // and again: the sync is safe on every start
          await repo.sync();
        },
      };
    });

    it('suspending an organisation blocks sign-in on PostgreSQL too', async () => {
      await sequelize.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await ensureSchema(sequelize, SCHEMA);
      const repo = createSequelizeRepo(sequelize);
      await repo.sync();
      await seedIdentity(repo, {demoPassword: PASSWORD});
      const ctx = await makeService({repo});
      const admin = await repo.getUserByEmail(ADMIN);
      const actor = {id: admin.id, name: admin.name};
      const other = await ctx.service.createOrganisation(
        {code: 'CAR', name: 'A carrier'},
        actor,
      );
      const {user} = await ctx.service.invite(
        {
          name: 'C',
          email: 'c@carrier.test',
          roles: ['adm'],
          organisationId: other.id,
        },
        actor,
      );
      await repo.updateUser(user.id, {
        status: 'Active',
        passwordHash: admin.passwordHash,
      });
      await ctx.service.setOrganisationStatus(other.id, 'Suspended', '', actor);
      await rejects(
        ctx.service.login({email: 'c@carrier.test', password: PASSWORD}),
        403,
        BLOCKED,
      );
      await ctx.service.setOrganisationStatus(other.id, 'Active', '', actor);
      expect(
        (await ctx.service.login({email: 'c@carrier.test', password: PASSWORD}))
          .next,
      ).to.equal('done');
    });
  });

  it('codes the default organisation from its name', () => {
    expect(organisationCodeOf('Deeds Registry')).to.equal('DR');
    expect(organisationCodeOf('Ré gistre')).to.equal('RG');
    expect(organisationCodeOf('A b c d e f g')).to.equal('ABCDE');
    expect(organisationCodeOf('Registry')).to.equal('ORG');
    expect(organisationCodeOf('')).to.equal('ORG');
  });

  it('the administrator role holds admin.organisations; no other role does', () => {
    expect(
      ROLES.filter(r => r.perms.includes('admin.organisations')).map(r => r.id),
    ).to.deep.equal(['adm']);
  });

  it('adds an organisation with a fixed, upper-case code; refuses bad or duplicate codes', async () => {
    const {service, actor, repo, defaultOrg} = await setup();
    const bank = await service.createOrganisation(
      {code: 'bnk', name: ' First Bank '},
      actor,
    );
    expect(bank).to.include({
      code: 'BNK',
      name: 'First Bank',
      status: 'Active',
      users: 0,
      offices: 0,
    });
    await rejects(
      service.createOrganisation({code: 'BNK', name: 'Again'}, actor),
      409,
      'already exists',
    );
    await rejects(
      service.createOrganisation({code: defaultOrg.code, name: 'Clash'}, actor),
      409,
    );
    await rejects(
      service.createOrganisation({code: 'B', name: 'Too short'}, actor),
      400,
      '2 to 5 letters',
    );
    await rejects(
      service.createOrganisation({code: 'CAR', name: ' '}, actor),
      400,
      'Name',
    );
    const renamed = await service.updateOrganisation(
      bank.id,
      {name: 'First National Bank', code: 'XXX'},
      actor,
    );
    expect(renamed).to.include({code: 'BNK', name: 'First National Bank'});
    const {items} = await repo.listAccessEvents({kind: 'organisation'});
    expect(items.map(e => e.action)).to.deep.equal([
      'Organisation updated',
      'Organisation added',
    ]);
    expect(items[0]).to.include({
      target: 'BNK · First National Bank',
      detail: 'name: First Bank → First National Bank',
      actor: 'Paulus Hamutenya',
    });
    const list = await service.listOrganisations();
    expect(list.map(o => o.code)).to.deep.equal(['BNK', defaultOrg.code]);
    expect(list.find(o => o.id === defaultOrg.id).users).to.be.greaterThan(0);
  });

  it("users and offices: the given organisation, else the office's, the inviter's or the default", async () => {
    const {service, actor, defaultOrg, repo} = await setup();
    const bank = await service.createOrganisation(
      {code: 'BNK', name: 'First Bank'},
      actor,
    );
    const hq = await service.createOffice(
      {code: 'HQ', name: 'Head office'},
      actor,
    );
    expect(hq.organisationId).to.equal(defaultOrg.id);
    const branch = await service.createOffice(
      {code: 'BRA', name: 'Bank branch', organisationId: bank.id},
      actor,
    );
    expect(branch.organisationId).to.equal(bank.id);

    // the inviter's organisation
    const a = await service.invite(
      {name: 'A', email: 'a@x.test', officeId: hq.id, roles: ['scan']},
      actor,
    );
    expect(a.user).to.include({
      organisationId: defaultOrg.id,
      organisation: defaultOrg.name,
    });
    // the office's organisation
    const b = await service.invite(
      {name: 'B', email: 'b@x.test', officeId: branch.id, roles: ['scan']},
      actor,
    );
    expect(b.user).to.include({
      organisationId: bank.id,
      organisation: 'First Bank',
    });
    // given explicitly
    const c = await service.invite(
      {name: 'C', email: 'c@x.test', organisationId: bank.id, roles: ['adm']},
      actor,
    );
    expect(c.user.organisationId).to.equal(bank.id);
    // the system (no inviter): the default organisation
    const d = await service.invite({
      name: 'D',
      email: 'd@x.test',
      roles: ['adm'],
    });
    expect(d.user.organisationId).to.equal(defaultOrg.id);

    await rejects(
      service.invite(
        {
          name: 'E',
          email: 'e@x.test',
          officeId: branch.id,
          organisationId: defaultOrg.id,
          roles: ['scan'],
        },
        actor,
      ),
      400,
      'another organisation',
    );
    await rejects(
      service.invite(
        {
          name: 'F',
          email: 'f@x.test',
          organisationId: '00000000-0000-4000-8000-000000000000',
          roles: ['adm'],
        },
        actor,
      ),
      400,
      'does not exist',
    );
    await service.setOrganisationStatus(bank.id, 'Suspended', '', actor);
    await rejects(
      service.createOffice(
        {code: 'BRB', name: 'Another branch', organisationId: bank.id},
        actor,
      ),
      409,
      'suspended',
    );
    // every user listed shows the organisation, and /me too
    const listed = await service.listUsers();
    expect(
      listed.every(u => 'organisationId' in u && 'organisation' in u),
    ).to.equal(true);
    expect((await service.me(actor.id)).user).to.include({
      organisationId: defaultOrg.id,
      organisation: defaultOrg.name,
      // the existing fields stay
      officeId: null,
      office: '',
    });
    expect((await repo.getUserByEmail('b@x.test')).organisationId).to.equal(
      bank.id,
    );
  });

  it('moving a user to another office keeps them in their organisation', async () => {
    const {service, actor} = await setup();
    const bank = await service.createOrganisation(
      {code: 'BNK', name: 'First Bank'},
      actor,
    );
    const hq = await service.createOffice(
      {code: 'HQ', name: 'Head office'},
      actor,
    );
    const hq2 = await service.createOffice(
      {code: 'SEC', name: 'Second office'},
      actor,
    );
    const branch = await service.createOffice(
      {code: 'BRA', name: 'Bank branch', organisationId: bank.id},
      actor,
    );
    const {user} = await service.invite(
      {name: 'A', email: 'a@x.test', officeId: hq.id, roles: ['scan']},
      actor,
    );
    await rejects(
      service.setUserOffice(user.id, branch.id, actor),
      400,
      'another organisation',
    );
    const moved = await service.setUserOffice(user.id, hq2.id, actor);
    expect(moved.officeId).to.equal(hq2.id);
  });

  it('suspending an organisation blocks its users like a suspended account; reactivating restores them', async () => {
    const {service, actor, repo, published} = await setup();
    const bank = await service.createOrganisation(
      {code: 'BNK', name: 'First Bank'},
      actor,
    );
    const scan = await repo.getUserByEmail(SCAN);
    await repo.updateUser(scan.id, {organisationId: bank.id});
    const session = await service.login({email: SCAN, password: PASSWORD});
    expect(session.next).to.equal('done');

    const suspended = await service.setOrganisationStatus(
      bank.id,
      'Suspended',
      'Contract ended',
      actor,
    );
    expect(suspended).to.include({status: 'Suspended', users: 1});
    // the same refusal as for a suspended account, and the user's own data is unchanged
    await rejects(
      service.login({email: SCAN, password: PASSWORD}),
      403,
      BLOCKED,
    );
    expect((await repo.getUserByEmail(SCAN)).status).to.equal('Active');
    // the open session ends, and every service is told
    await rejects(
      service.refresh(session.refreshToken),
      401,
      'Session expired',
    );
    expect(
      published.some(e => {
        const text = JSON.stringify(e);
        return (
          text.includes('organisation suspended') && text.includes(scan.id)
        );
      }),
    ).to.equal(true);
    const denied = (await repo.listAccessEvents({kind: 'denied'})).items[0];
    expect(denied).to.include({
      action: 'Sign-in blocked',
      detail: 'Organisation First Bank suspended',
    });

    await service.setOrganisationStatus(bank.id, 'Active', '', actor);
    expect(
      (await service.login({email: SCAN, password: PASSWORD})).next,
    ).to.equal('done');
    const {items} = await repo.listAccessEvents({kind: 'organisation'});
    expect(items.map(e => `${e.action}: ${e.detail}`)).to.deep.equal([
      'Organisation reactivated: Its users can sign in again',
      'Organisation suspended: Contract ended',
      'Organisation added: ',
    ]);
  });

  it('an MFA step started before the suspension cannot finish', async () => {
    const {service, actor, repo} = await setup({mfa: true});
    const bank = await service.createOrganisation(
      {code: 'BNK', name: 'First Bank'},
      actor,
    );
    const scan = await repo.getUserByEmail(SCAN);
    await repo.updateUser(scan.id, {organisationId: bank.id});
    const first = await service.login({email: SCAN, password: PASSWORD});
    expect(first.next).to.equal('mfa-enroll');
    await service.setOrganisationStatus(bank.id, 'Suspended', '', actor);
    await rejects(
      service.verifyMfa({userId: scan.id, code: '000000'}),
      401,
      'Sign-in expired',
    );
  });

  it('refuses to suspend the organisation of the last active administrators', async () => {
    const {service, actor, defaultOrg} = await setup();
    await rejects(
      service.setOrganisationStatus(defaultOrg.id, 'Suspended', '', actor),
      409,
      'no active user able to manage roles',
    );
    expect((await service.listOrganisations())[0].status).to.equal('Active');
  });

  it('HTTP: anyone who invites may list organisations; only admin.organisations may change them', async () => {
    const {app, login, auth} = await makeApp();
    const admin = await login(ADMIN);
    const supervisor = await login(SUPERVISOR);
    const scan = await login(SCAN);
    const get = token =>
      app.inject({url: '/organisations', headers: auth(token)});
    expect((await get(supervisor.token)).statusCode).to.equal(200);
    expect((await get(scan.token)).statusCode).to.equal(403);
    expect(admin.body.me.user.organisation).to.be.a('string').and.not.equal('');

    const add = (token, payload) =>
      app.inject({
        method: 'POST',
        url: '/organisations',
        headers: auth(token),
        payload,
      });
    expect(
      (await add(supervisor.token, {code: 'CAR', name: 'A carrier'}))
        .statusCode,
    ).to.equal(403);
    expect(
      (await add(admin.token, {code: 'car1', name: 'A carrier'})).statusCode,
    ).to.equal(400);
    const created = await add(admin.token, {code: 'CAR', name: 'A carrier'});
    expect(created.statusCode).to.equal(201);
    const id = created.json().id;
    const patch = payload =>
      app.inject({
        method: 'PATCH',
        url: `/organisations/${id}`,
        headers: auth(admin.token),
        payload,
      });
    expect((await patch({name: 'Carrier Ltd'})).json()).to.include({
      code: 'CAR',
      name: 'Carrier Ltd',
    });
    expect((await patch({})).statusCode).to.equal(400);
    const post = action =>
      app.inject({
        method: 'POST',
        url: `/organisations/${id}/${action}`,
        headers: auth(admin.token),
      });
    expect((await post('suspend')).json().status).to.equal('Suspended');
    expect((await post('reactivate')).json().status).to.equal('Active');

    const invited = await app.inject({
      method: 'POST',
      url: '/users',
      headers: auth(admin.token),
      payload: {
        name: 'N',
        email: 'n@carrier.test',
        roles: ['adm'],
        organisationId: id,
      },
    });
    expect(invited.statusCode).to.equal(201);
    expect(invited.json().user).to.include({
      organisationId: id,
      organisation: 'Carrier Ltd',
    });
    const users = (
      await app.inject({url: '/users', headers: auth(admin.token)})
    ).json().users;
    expect(users.find(u => u.email === 'n@carrier.test').organisation).to.equal(
      'Carrier Ltd',
    );
  });
});

describe('the session carries the organisation (CB-20)', () => {
  it('the access token names the organisation after sign-in, and refresh issues the current one', async () => {
    const {service, repo} = await makeService();
    const scan = await repo.getUserByEmail(SCAN);
    const session = await service.login({email: SCAN, password: PASSWORD});
    expect(session.claims.org).to.be.a('string').and.equal(scan.organisationId);

    const bank = await service.createOrganisation(
      {code: 'BNK', name: 'First Bank'},
      {id: null, name: 'System'},
    );
    await repo.updateUser(scan.id, {organisationId: bank.id});
    const next = await service.refresh(session.refreshToken);
    expect(next.claims.org).to.equal(bank.id);
  });

  it('HTTP: a token issued before the claim (no organisation) is still accepted', async () => {
    const {app, login, auth} = await makeApp();
    const scan = await login(SCAN);
    const {iat, exp, org, ...old} = app.jwt.decode(scan.token);
    expect(org).to.be.a('string');
    const before = app.jwt.sign(old, {expiresIn: exp - iat});
    const res = await app.inject({url: '/auth/me', headers: auth(before)});
    expect(res.statusCode).to.equal(200);
  });
});
