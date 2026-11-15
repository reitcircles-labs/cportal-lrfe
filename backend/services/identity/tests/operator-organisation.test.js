import {signServiceToken} from '@lrfe/common';
import {expect} from 'chai';

import {DEFAULT_ORGANISATION_KEY} from '../src/seed.js';
import {makeApp} from './helpers.js';

/**
 * CB-48: the platform operator's own organisation, the default organisation, never takes part in
 * a B/L. Identity leaves it out of the organisations the record service may name
 * (GET /organisations/active), and says so in its standing (`operator: true`), so that the record
 * service refuses a B/L that would go to it. Other organisations answer as before.
 */

/**
 * The app with one more organisation than the default one, and the record service's header.
 * @return {!Promise<object>}
 */
async function setup() {
  const ctx = await makeApp();
  const admin = await ctx.repo.getUserByEmail('p.hamutenya@deeds.gov.na');
  const bank = await ctx.service.createOrganisation(
    {code: 'BNK', name: 'First Bank'},
    {id: admin.id, name: admin.name},
  );
  const operatorId = await ctx.repo.getSetting(DEFAULT_ORGANISATION_KEY);
  const headers = {
    authorization: `Bearer ${signServiceToken(ctx.app, 'land-records')}`,
  };
  return {...ctx, bank, operatorId, headers};
}

describe("the platform operator's organisation takes no part in a B/L (CB-48)", () => {
  it('is not among the active organisations a B/L may name', async () => {
    const {app, bank, operatorId, headers} = await setup();
    expect(operatorId).to.be.a('string');
    const res = await app.inject({url: '/organisations/active', headers});
    expect(res.statusCode, res.body).to.equal(200);
    const ids = res.json().organisations.map(o => o.id);
    expect(ids).to.include(bank.id);
    expect(ids).not.to.include(operatorId);
    await app.close();
  });

  it('its standing says it is the operator; another organisation answers as before', async () => {
    const {app, bank, operatorId, headers} = await setup();
    const operator = await app.inject({
      url: `/organisations/${operatorId}/standing`,
      headers,
    });
    expect(operator.statusCode, operator.body).to.equal(200);
    expect(operator.json()).to.include({
      id: operatorId,
      status: 'Active',
      operator: true,
    });
    const other = await app.inject({
      url: `/organisations/${bank.id}/standing`,
      headers,
    });
    expect(other.json()).to.deep.equal({
      id: bank.id,
      status: 'Active',
      name: 'First Bank',
    });
    await app.close();
  });
});
