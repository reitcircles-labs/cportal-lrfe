import {domain} from '@lrfe/common';
import {expect} from 'chai';

import {PERMS} from '../src/catalogue.js';
import {makeApp} from './helpers.js';

const ADMIN =
  domain.name === 'shipping'
    ? 'a.morgan@shipping.example'
    : 'p.hamutenya@deeds.gov.na';
const NON_ADMIN =
  domain.name === 'shipping'
    ? 'l.okafor@bluewater-lines.example'
    : 'e.shivute@deeds.gov.na'; // lacks admin.organisations
const SCOPED_PERMS = PERMS.filter(p => !p.id.startsWith('admin.'))
  .slice(0, 3)
  .map(p => p.id);

describe('organisation API keys (CB-56)', () => {
  it('creates, lists without secret, exchanges for a scoped access token, and revokes an API key', async () => {
    const ctx = await makeApp({clock: () => new Date()});
    const {token: adminToken} = await ctx.login(ADMIN);
    const {token: supervisorToken} = await ctx.login(NON_ADMIN);

    const orgRes = await ctx.app.inject({
      method: 'POST',
      url: '/organisations',
      headers: ctx.auth(adminToken),
      payload: {code: 'BWL', name: 'Bluewater Lines'},
    });
    expect(orgRes.statusCode).to.equal(201);
    const org = orgRes.json();

    // Non-admin (lacking admin.organisations) is refused 403
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/organisations/${org.id}/api-keys`,
      headers: ctx.auth(supervisorToken),
      payload: {name: 'Carrier TMS'},
    });
    expect(denied.statusCode).to.equal(403);

    // Admin privileges cannot be granted on an organisation API key
    const badPerm = await ctx.app.inject({
      method: 'POST',
      url: `/organisations/${org.id}/api-keys`,
      headers: ctx.auth(adminToken),
      payload: {name: 'Too broad', perms: ['admin.users']},
    });
    expect(badPerm.statusCode).to.equal(400);

    // Create a carrier API key (returns secret once)
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/organisations/${org.id}/api-keys`,
      headers: ctx.auth(adminToken),
      payload: {
        name: 'Carrier TMS',
        perms: SCOPED_PERMS,
      },
    });
    expect(created.statusCode).to.equal(201);
    const key = created.json();
    expect(key.secret)
      .to.be.a('string')
      .and.match(/^lrfe_/);
    expect(key.status).to.equal('Active');
    expect(key.perms).to.deep.equal(SCOPED_PERMS);

    // Listing hides the secret and hash
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/organisations/${org.id}/api-keys`,
      headers: ctx.auth(adminToken),
    });
    expect(listRes.statusCode).to.equal(200);
    const items = listRes.json().items;
    expect(items).to.have.length(1);
    expect(items[0]).to.include({
      id: key.id,
      name: 'Carrier TMS',
      status: 'Active',
    });
    expect(items[0]).to.not.have.property('secret');
    expect(items[0]).to.not.have.property('keyHash');

    // Exchange via X-Api-Key header for an access JWT carrying org + perms
    const exchangeRes = await ctx.app.inject({
      method: 'POST',
      url: '/auth/api-token',
      headers: {'x-api-key': key.secret},
    });
    expect(exchangeRes.statusCode).to.equal(200);
    const exchanged = exchangeRes.json();
    expect(exchanged.accessToken).to.be.a('string');
    expect(exchanged.organisationId).to.equal(org.id);
    const claims = ctx.app.jwt.verify(exchanged.accessToken);
    expect(claims).to.include({
      typ: 'access',
      sub: `api-key:${key.id}`,
      org: org.id,
      sid: key.id,
    });
    expect(claims.perms).to.deep.equal(SCOPED_PERMS);

    // Wrong key gets 401
    const badKey = await ctx.app.inject({
      method: 'POST',
      url: '/auth/api-token',
      headers: {'x-api-key': 'lrfe_not-a-real-key'},
    });
    expect(badKey.statusCode).to.equal(401);

    // Revoking stops token exchange immediately and emits session revocation
    const revokeRes = await ctx.app.inject({
      method: 'POST',
      url: `/organisations/${org.id}/api-keys/${key.id}/revoke`,
      headers: ctx.auth(adminToken),
    });
    expect(revokeRes.statusCode).to.equal(200);
    expect(revokeRes.json().status).to.equal('Revoked');

    const afterRevoke = await ctx.app.inject({
      method: 'POST',
      url: '/auth/api-token',
      payload: {apiKey: key.secret},
    });
    expect(afterRevoke.statusCode).to.equal(401);
    expect(
      ctx.published.some(
        e => e.type === 'identity.session.revoked' && e.data.sid === key.id,
      ),
    ).to.equal(true);
  });

  it('refuses API-key token exchange when its organisation is suspended', async () => {
    const ctx = await makeApp();
    const {token: adminToken} = await ctx.login(ADMIN);
    const org = (
      await ctx.app.inject({
        method: 'POST',
        url: '/organisations',
        headers: ctx.auth(adminToken),
        payload: {code: 'SUSP', name: 'Suspended Carrier'},
      })
    ).json();
    const key = (
      await ctx.app.inject({
        method: 'POST',
        url: `/organisations/${org.id}/api-keys`,
        headers: ctx.auth(adminToken),
        payload: {name: 'ERP'},
      })
    ).json();

    await ctx.app.inject({
      method: 'POST',
      url: `/organisations/${org.id}/suspend`,
      headers: ctx.auth(adminToken),
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/api-token',
      headers: {'x-api-key': key.secret},
    });
    expect(res.statusCode).to.equal(401);
  });
});
