import {loadDomainPack} from '@lrfe/common';
import {expect} from 'chai';

import {catalogueOf} from '../src/catalogue.js';
import {verifyPassword} from '../src/crypto.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {DEFAULT_ORGANISATION_KEY, seedIdentity} from '../src/seed.js';

/**
 * The shipping demo data (CB-48): five demo organisations (a carrier, a shipper, the exporter's
 * bank, the buyer's bank, a buyer), a demo user per persona in each, and the platform
 * administrator in the default organisation, which on a shipping install is not the deeds
 * registry. Seeded only with the demo password, and only by the shipping pack: a land install
 * does not change.
 */

const DEMO_PASSWORD = 'demo password 2026';

/** @return {!Promise<!Object>} the shipping install's catalogue */
async function shipping() {
  return catalogueOf(await loadDomainPack('shipping'));
}

/** @return {!Promise<!Object>} the land install's catalogue */
async function land() {
  return catalogueOf(await loadDomainPack('land'));
}

/**
 * Runs a function with LRFE_ORG_NAME set to a value (or not set: undefined), then restores it.
 * @param {string|undefined} value
 * @param {function(): !Promise} fn
 * @return {!Promise}
 */
async function withOrgName(value, fn) {
  const before = process.env.LRFE_ORG_NAME;
  if (value === undefined) {
    delete process.env.LRFE_ORG_NAME;
  } else {
    process.env.LRFE_ORG_NAME = value;
  }
  try {
    return await fn();
  } finally {
    if (before === undefined) {
      delete process.env.LRFE_ORG_NAME;
    } else {
      process.env.LRFE_ORG_NAME = before;
    }
  }
}

/**
 * The users of a repository by email, with their organisation's and office's codes.
 * @param {!Object} repo
 * @return {!Promise<!Map<string, !Object>>}
 */
async function usersByEmail(repo) {
  const organisations = await repo.listOrganisations();
  const offices = await repo.listOffices();
  const users = new Map();
  for (const user of await repo.listUsers()) {
    users.set(user.email, {
      ...user,
      organisationCode: organisations.find(o => o.id === user.organisationId)
        ?.code,
      officeCode: offices.find(o => o.id === user.officeId)?.code,
    });
  }
  return users;
}

describe('the shipping demo data (CB-48)', () => {
  it('has fictitious demo organisations and demo emails', async () => {
    const catalogue = await shipping();
    expect(catalogue.demoOrganisations).to.have.length(5);
    expect(new Set(catalogue.demoOrganisations.map(o => o.code)).size).to.equal(
      5,
    );
    for (const o of catalogue.demoOrganisations) {
      expect(o.code).to.match(/^[A-Z]{2,5}$/);
      expect(o.name).not.to.match(/deeds|registry|namibia|republic/i);
    }
    for (const user of catalogue.demoUsers) {
      expect(user.email).to.match(/@[a-z0-9.-]+\.example$/);
      expect(user.status).to.equal('Active');
    }
  });

  it('refuses a demo user in an organisation that is not a demo organisation', async () => {
    const pack = await loadDomainPack('shipping');
    const broken = {
      ...pack,
      identity: {
        ...pack.identity,
        demoUsers: [{...pack.identity.demoUsers[1], organisation: 'NOPE'}],
      },
    };
    expect(() => catalogueOf(broken)).to.throw(
      /demo user .* is in the unknown organisation NOPE/,
    );
  });

  it('seeds the organisations, an office each, and every demo user in theirs, signing in with the demo password', async () => {
    const catalogue = await shipping();
    const repo = createMemoryRepo();
    await seedIdentity(repo, {
      catalogue,
      demoPassword: DEMO_PASSWORD,
      offices: catalogue.offices,
    });

    const organisations = await repo.listOrganisations();
    const defaultId = await repo.getSetting(DEFAULT_ORGANISATION_KEY);
    expect(organisations).to.have.length(6);
    for (const demo of catalogue.demoOrganisations) {
      const organisation = await repo.getOrganisationByCode(demo.code);
      expect(organisation, demo.code).to.include({
        name: demo.name,
        status: 'Active',
      });
      expect(organisation.id).not.to.equal(defaultId);
      // its office, as the onboarding screens make one: the organisation's code and name
      const office = await repo.getOfficeByCode(demo.code);
      expect(office, `office ${demo.code}`).to.include({
        name: demo.name,
        type: 'external',
        status: 'Active',
        organisationId: organisation.id,
      });
    }

    const users = await usersByEmail(repo);
    for (const demo of catalogue.demoUsers) {
      const user = users.get(demo.email);
      expect(user, demo.email).to.include({status: 'Active', name: demo.name});
      expect(user.roles).to.deep.equal(demo.roles);
      expect(await verifyPassword(DEMO_PASSWORD, user.passwordHash)).to.equal(
        true,
      );
      if (demo.organisation) {
        expect(user.organisationCode, demo.email).to.equal(demo.organisation);
        expect(user.officeCode, demo.email).to.equal(demo.organisation);
      } else {
        // the platform administrator: in the default organisation
        expect(user.organisationId).to.equal(defaultId);
      }
    }
    // the default office stays the default organisation's
    const hq = await repo.getOfficeByCode('HQ');
    expect(hq.organisationId).to.equal(defaultId);
  });

  it('a restart duplicates nothing and undoes no change of the administrator', async () => {
    const catalogue = await shipping();
    const repo = createMemoryRepo();
    const seed = () =>
      seedIdentity(repo, {
        catalogue,
        demoPassword: DEMO_PASSWORD,
        offices: catalogue.offices,
      });
    await seed();
    const carrier = await repo.getOrganisationByCode(
      catalogue.demoOrganisations[0].code,
    );
    await repo.updateOrganisation(carrier.id, {name: 'Renamed Lines'});
    const before = {
      organisations: (await repo.listOrganisations()).length,
      offices: (await repo.listOffices()).length,
      users: (await repo.listUsers()).length,
    };

    await seed();
    await seed();
    expect({
      organisations: (await repo.listOrganisations()).length,
      offices: (await repo.listOffices()).length,
      users: (await repo.listUsers()).length,
    }).to.deep.equal(before);
    expect((await repo.getOrganisation(carrier.id)).name).to.equal(
      'Renamed Lines',
    );
  });

  it('a demo organisation whose code an office already has keeps that office, if it is its own', async () => {
    const catalogue = await shipping();
    const repo = createMemoryRepo();
    const [carrier] = catalogue.demoOrganisations;
    // an office of another organisation already has the carrier's code
    await repo.createOffice({
      code: carrier.code,
      name: 'Someone else',
      type: 'external',
      address: '',
      contact: '',
      status: 'Active',
    });
    await seedIdentity(repo, {catalogue, demoPassword: DEMO_PASSWORD});
    const organisation = await repo.getOrganisationByCode(carrier.code);
    const users = await usersByEmail(repo);
    for (const demo of catalogue.demoUsers.filter(
      u => u.organisation === carrier.code,
    )) {
      // in their organisation all the same, never in the other one's office
      expect(users.get(demo.email).organisationId).to.equal(organisation.id);
      expect(users.get(demo.email).officeId).to.equal(null);
    }
  });

  it('seeds no demo organisation without the demo password', async () => {
    const catalogue = await shipping();
    const repo = createMemoryRepo();
    await seedIdentity(repo, {catalogue, offices: catalogue.offices});
    expect(await repo.listOrganisations()).to.have.length(1);
    expect(await repo.listUsers()).to.deep.equal([]);
  });

  it("names a shipping install's default organisation after the pack, not the deeds registry", async () => {
    const catalogue = await shipping();
    const repo = createMemoryRepo();
    await withOrgName(undefined, () =>
      seedIdentity(repo, {catalogue, demoPassword: DEMO_PASSWORD}),
    );
    const id = await repo.getSetting(DEFAULT_ORGANISATION_KEY);
    const organisation = await repo.getOrganisation(id);
    expect(organisation.name).to.equal('Shipping Registry');
    expect(organisation.code).to.equal('SR');
  });

  it("LRFE_ORG_NAME still names a shipping install's default organisation", async () => {
    const catalogue = await shipping();
    const repo = createMemoryRepo();
    await withOrgName('Harbour Platform', () =>
      seedIdentity(repo, {catalogue}),
    );
    const id = await repo.getSetting(DEFAULT_ORGANISATION_KEY);
    expect((await repo.getOrganisation(id)).name).to.equal('Harbour Platform');
  });

  it('a land install does not change: no demo organisation, the deeds registry, everyone in it', async () => {
    const catalogue = await land();
    expect(catalogue.demoOrganisations).to.deep.equal([]);
    expect(catalogue.demoUsers.some(u => u.organisation)).to.equal(false);
    const repo = createMemoryRepo();
    await withOrgName(undefined, () =>
      seedIdentity(repo, {
        catalogue,
        demoPassword: DEMO_PASSWORD,
        offices: catalogue.offices,
      }),
    );
    const organisations = await repo.listOrganisations();
    expect(organisations.map(o => `${o.code} ${o.name}`)).to.deep.equal([
      'DR Deeds Registry',
    ]);
    const users = await repo.listUsers();
    expect(users).to.have.length(catalogue.demoUsers.length);
    expect(users.every(u => u.organisationId === organisations[0].id)).to.equal(
      true,
    );
    // land demo users keep no office link, as before
    expect(users.every(u => u.officeId === null)).to.equal(true);
  });
});
