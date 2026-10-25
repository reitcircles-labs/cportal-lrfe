import {expect} from 'chai';
import {fileSamples, makeApp} from './helpers.js';

// The documents changed since a moment, for the search service's re-index (API-808).
describe('edrms: documents changed since a moment (API-808)', () => {
  it('the search service lists them, oldest change first; a correction moves a document to the end', async () => {
    const ctx = await makeApp();
    const docs = await fileSamples(ctx.service);
    const list = async (query, token = ctx.serviceToken('search')) =>
      ctx.app.inject({
        url: `/documents/changed?${query}`,
        headers: ctx.bearer(token),
      });

    const all = (await list('limit=500')).json();
    expect(all.total).to.equal(Object.keys(docs).length);
    expect(all.items[0]).to.have.keys(['id', 'sourceId', 'updatedAt']);

    ctx.clock.advance(60_000);
    const later = ctx.clock().toISOString();
    await ctx.service.amendDocument({
      id: docs.grant.id,
      expectedVersion: 1,
      reason: 'Typo in division',
      changes: [{k: 'regDiv', v: 'K '}],
    });
    const since = (await list(`since=${later}`)).json();
    expect(since.items.map(d => d.id)).to.deep.equal([docs.grant.id]);

    expect((await list('since=2999-01-01T00:00:00Z')).json().total).to.equal(0);
    // other services and browsers cannot
    expect(
      (await list('', ctx.serviceToken('land-records'))).statusCode,
    ).to.equal(403);
    expect(
      (await list('', ctx.userToken(['record.view']))).statusCode,
    ).to.equal(401);
  });

  it('pages follow a cursor: every document once, also one changed while paging (API-804)', async () => {
    const ctx = await makeApp();
    const docs = await fileSamples(ctx.service);
    const list = async query =>
      (
        await ctx.app.inject({
          url: `/documents/changed?${query}`,
          headers: ctx.bearer(ctx.serviceToken('search')),
        })
      ).json();
    const first = await list('limit=2');
    expect(first.items).to.have.length(2);
    expect(first.total).to.equal(Object.keys(docs).length);
    // a document corrected while paging moves to the end of the list: it is read (again) there
    ctx.clock.advance(60_000);
    await ctx.service.amendDocument({
      id: docs.grant.id,
      expectedVersion: 1,
      reason: 'Typo in division',
      changes: [{k: 'regDiv', v: 'K '}],
    });
    const seen = first.items.map(d => d.id);
    let next = first.next;
    while (next) {
      const page = await list(`limit=2&after=${next}`);
      expect(page).to.not.have.property('total');
      seen.push(...page.items.map(d => d.id));
      next = page.next;
    }
    expect(new Set(seen).size).to.equal(Object.keys(docs).length);
    expect(seen.at(-1)).to.equal(docs.grant.id);

    const bad = await ctx.app.inject({
      url: '/documents/changed?after=nonsense',
      headers: ctx.bearer(ctx.serviceToken('search')),
    });
    expect(bad.statusCode).to.equal(400);
  });
});
