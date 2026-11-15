import {signServiceToken} from '@lrfe/common';
import {expect} from 'chai';

import {makeApp} from './helpers.js';

/**
 * CB-44: identity lists the organisations registered and active on the platform for the
 * product's record service, so that a carrier's clerk can pick the shipper and the consignee of a
 * new B/L among them (the clerk has no administrator permission to list organisations):
 *
 *   GET /organisations/active   service token of the pack's record service only
 *     200 {organisations: [{id, code, name}]}   Active organisations only, sorted by name;
 *                                                nothing else about them
 *     401 for a person's token or none, 403 for another service
 *
 * The administrators' list, GET /organisations, does not change.
 */

const ADMIN = 'p.hamutenya@deeds.gov.na';

/**
 * The app with three organisations besides the default one, one of them suspended.
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
  const exporter = await ctx.service.createOrganisation(
    {code: 'EXP', name: 'Coffee Exporters'},
    actor,
  );
  const buyer = await ctx.service.createOrganisation(
    {code: 'BUY', name: 'Buyer Trading'},
    actor,
  );
  await ctx.service.setOrganisationStatus(buyer.id, 'Suspended', '', actor);
  /**
   * Lists the active organisations with these headers.
   * @param {!Object<string, string>} headers
   * @return {!Promise<object>}
   */
  const active = headers =>
    ctx.app.inject({url: '/organisations/active', headers});
  /**
   * The header of a service's token.
   * @param {string} service
   * @return {{authorization: string}}
   */
  const asService = service => ({
    authorization: `Bearer ${signServiceToken(ctx.app, service)}`,
  });
  return {...ctx, bank, exporter, buyer, active, asService};
}

describe('the active organisations, for the record service (CB-44)', () => {
  it('answers the active organisations, sorted by name, with their id, code and name only', async () => {
    const {bank, exporter, buyer, active, asService, app} = await setup();
    // the land pack's record service in these tests (the default pack)
    const res = await active(asService('land-records'));
    expect(res.statusCode, res.body).to.equal(200);
    const {organisations} = res.json();
    const names = organisations.map(o => o.name);
    expect(names).to.include.members(['First Bank', 'Coffee Exporters']);
    expect(names).not.to.include('Buyer Trading');
    expect(organisations.map(o => o.id)).not.to.include(buyer.id);
    expect([...names].sort((a, b) => a.localeCompare(b))).to.deep.equal(names);
    for (const o of organisations) {
      expect(Object.keys(o).sort()).to.deep.equal(['code', 'id', 'name']);
    }
    expect(organisations.find(o => o.id === bank.id)).to.deep.equal({
      id: bank.id,
      code: 'BNK',
      name: 'First Bank',
    });
    expect(organisations.find(o => o.id === exporter.id)?.code).to.equal('EXP');
    await app.close();
  });

  it("only the pack's record service may ask: another service 403, a person's token 401, no token 401", async () => {
    const {active, asService, login, auth, app} = await setup();
    const other = await active(asService('intake'));
    expect(other.statusCode, other.body).to.equal(403);
    const {token} = await login(ADMIN);
    expect((await active(auth(token))).statusCode).to.equal(401);
    expect((await active({})).statusCode).to.equal(401);
    await app.close();
  });

  it("the administrators' list GET /organisations is unchanged: every organisation, suspended ones too", async () => {
    const {buyer, login, auth, app} = await setup();
    const {token} = await login(ADMIN);
    const res = await app.inject({url: '/organisations', headers: auth(token)});
    expect(res.statusCode, res.body).to.equal(200);
    const listed = res.json().organisations.find(o => o.id === buyer.id);
    expect(listed?.status).to.equal('Suspended');
    await app.close();
  });
});
