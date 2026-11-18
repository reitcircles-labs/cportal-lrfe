import {loadDomainPack, signServiceToken} from '@lrfe/common';
import {expect} from 'chai';

import {catalogueOf} from '../src/catalogue.js';
import {DEFAULT_ORGANISATION_KEY} from '../src/seed.js';
import {makeApp} from './helpers.js';

/**
 * CB-34: identity tells the product's record service whether an organisation is registered and
 * active, so that a B/L only goes to such an organisation:
 *
 *   GET /organisations/:id/standing   service token of the pack's record service only
 *     200 {id, status, name}   status 'Active' or 'Suspended', and its name (CB-42: the parties
 *                        of a B/L see each other's names); nothing else about the organisation
 *     404                no such organisation ("Organisation not found")
 *     400                not an organisation id
 *     401 for a person's token, 403 for another service
 *
 * And the shipping pack's title permissions in the catalogue: bl.issue and bl.endorse, given to
 * the roles (CB-44: issuing to the carrier's staff role bld, endorsing to the trade role blt).
 */

const ADMIN = 'p.hamutenya@deeds.gov.na';

/**
 * The app with two organisations besides the default one, one of them suspended.
 * @return {!Promise<object>}
 */
async function setup() {
  const ctx = await makeApp();
  const admin = await ctx.repo.getUserByEmail(ADMIN);
  const actor = {id: admin.id, name: admin.name};
  const bank = await ctx.service.createOrganisation(
    {code: 'BNK', name: 'First Bank'},
    actor,
  );
  const buyer = await ctx.service.createOrganisation(
    {code: 'BUY', name: 'Buyer Trading'},
    actor,
  );
  await ctx.service.setOrganisationStatus(buyer.id, 'Suspended', '', actor);
  /**
   * Asks for an organisation's standing with these headers.
   * @param {string} id
   * @param {!Object<string, string>} headers
   * @return {!Promise<object>}
   */
  const standing = (id, headers) =>
    ctx.app.inject({url: `/organisations/${id}/standing`, headers});
  /**
   * The header of a service's token.
   * @param {string} service
   * @return {{authorization: string}}
   */
  const asService = service => ({
    authorization: `Bearer ${signServiceToken(ctx.app, service)}`,
  });
  return {...ctx, bank, buyer, standing, asService};
}

describe("an organisation's standing, for the record service (CB-34)", () => {
  it('answers an active organisation, marking the operator organisation (CB-48)', async () => {
    const {bank, standing, asService, repo, app} = await setup();
    const operatorId = await repo.getSetting(DEFAULT_ORGANISATION_KEY);
    // the land pack's record service in these tests (the default pack)
    const res = await standing(bank.id, asService('land-records'));
    expect(res.statusCode, res.body).to.equal(200);
    expect(res.json()).to.deep.equal({
      id: bank.id,
      status: 'Active',
      name: 'First Bank',
    });
    const op = await standing(operatorId, asService('land-records'));
    expect(op.statusCode, op.body).to.equal(200);
    expect(op.json()).to.include({
      id: operatorId,
      status: 'Active',
      operator: true,
    });
    await app.close();
  });

  it('answers a suspended organisation as Suspended, with its name (changed: CB-42 adds the name)', async () => {
    const {buyer, standing, asService, app} = await setup();
    const res = await standing(buyer.id, asService('land-records'));
    expect(res.statusCode, res.body).to.equal(200);
    expect(res.json()).to.deep.equal({
      id: buyer.id,
      status: 'Suspended',
      name: 'Buyer Trading',
    });
    await app.close();
  });

  it('404 for an organisation that does not exist, 400 for a text that is no organisation id', async () => {
    const {standing, asService, app} = await setup();
    const missing = await standing(
      '00000000-0000-4000-8000-000000000000',
      asService('land-records'),
    );
    expect(missing.statusCode, missing.body).to.equal(404);
    expect(missing.json().message).to.equal('Organisation not found');
    for (const id of ['org-bank', 'toString', '__proto__', 'constructor']) {
      const res = await standing(id, asService('land-records'));
      expect(res.statusCode, `${id}: ${res.body}`).to.equal(400);
    }
    await app.close();
  });

  it("only the pack's record service may ask: another service 403, a person's token 401, no token 401", async () => {
    const {bank, standing, asService, login, auth, app} = await setup();
    const other = await standing(bank.id, asService('intake'));
    expect(other.statusCode, other.body).to.equal(403);
    const {token} = await login(ADMIN);
    expect((await standing(bank.id, auth(token))).statusCode).to.equal(401);
    expect((await standing(bank.id, {})).statusCode).to.equal(401);
    await app.close();
  });
});

describe("the shipping pack's title permissions in the catalogue (CB-34)", () => {
  it('lists bl.issue and bl.endorse under Bills of lading', async () => {
    const catalogue = catalogueOf(await loadDomainPack('shipping'));
    expect(catalogue.permIds).to.include.members([
      'bl.read',
      'bl.draft',
      'bl.issue',
      'bl.endorse',
    ]);
    const group = catalogue.perms
      .filter(p => p.id === 'bl.issue' || p.id === 'bl.endorse')
      .map(p => p.group);
    expect(group).to.deep.equal(['Bills of lading', 'Bills of lading']);
  });

  it('gives the carrier staff role bld issuing and the trade role blt endorsing (changed: CB-44 splits the roles)', async () => {
    const catalogue = catalogueOf(await loadDomainPack('shipping'));
    const bld = catalogue.roles.find(r => r.id === 'bld');
    expect(bld.perms).to.have.members(['bl.read', 'bl.draft', 'bl.issue']);
    const blt = catalogue.roles.find(r => r.id === 'blt');
    expect(blt.perms).to.have.members(['bl.read', 'bl.endorse']);
  });
});
