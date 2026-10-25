import {expect} from 'chai';
import {loadCountryPack} from '@lrfe/search-index';
import {createIndexSearch} from '../src/index-search.js';
import {fileSamples, makeApp} from './helpers.js';

// Document search through the search index (API-803, EDRMS_SEARCH=opensearch).
describe('edrms: search through the index (API-803)', () => {
  /**
   * The app with an index that answers `hits` (what the engine would find), keeping the bodies it
   * was sent; `fail`: the engine cannot be reached.
   */
  async function withIndex({
    hits = () => [],
    relation = 'eq',
    fail = null,
  } = {}) {
    const ctx = await makeApp();
    const docs = await fileSamples(ctx.service);
    const sent = [];
    const request = async (method, path, body) => {
      sent.push({method, path, body});
      if (fail) return fail();
      const found = hits(docs);
      return {
        status: 200,
        body: {
          hits: {
            total: {value: found.length, relation},
            hits: found.map(h => ({_source: h})),
          },
        },
      };
    };
    ctx.service.indexSearch = createIndexSearch({
      request,
      pack: loadCountryPack('NA'),
    });
    const search = (query, token) =>
      ctx.app.inject({url: `/documents?${query}`, headers: ctx.bearer(token)});
    return {...ctx, docs, sent, search};
  }

  const inIntake = {
    documentId: '0b9a1c52-6d0e-4f1a-9a57-3f4f4d1e2a10',
    status: 'intake',
    intakeStatus: 'ready',
    docType: 'deed_of_transfer',
    shown: {
      reference: 'T 4521/2019',
      party: 'Ndapewa Nghishidi',
      property: 'Erf 1873, Klein Windhoek',
      fields: [{k: 'deedNo', label: 'Deed number', v: 'T 4521/2019'}],
    },
  };
  /** The grant (filed), a document in intake, and one removed from edrms since it was indexed. */
  const three = docs => [
    {documentId: 's1', status: 'filed', edrmsId: docs.grant.id},
    inIntake,
    {
      documentId: 'gone',
      status: 'filed',
      edrmsId: '7d1b9a8e-0000-4000-8000-000000000000',
    },
  ];
  const audience = body =>
    body.query.bool.filter.find(f => f.terms)?.terms['access.audience'];

  it('every query is filtered on what the user may see; filed documents come from the database', async () => {
    const {search, sent, docs, userToken} = await withIndex({hits: three});
    const res = await search('q=Klein%20Windhoek', userToken(['record.view']));
    expect(res.statusCode, res.body).to.equal(200);
    expect(audience(sent[0].body)).to.deep.equal(['edrms']);
    const {items, total} = res.json();
    // the document in intake is not shown to a user without intake's permission
    expect(items.map(d => d.id)).to.deep.equal([docs.grant.id]);
    expect(items[0]).to.include({
      status: 'filed',
      edrmsNo: docs.grant.edrmsNo,
    });
    expect(items[0]).to.not.have.property('searchText');
    expect(total).to.equal(3);
  });

  it('a user with intake read permission also finds documents in intake, marked as such', async () => {
    const {search, sent, docs, userToken} = await withIndex({hits: three});
    const res = await search('q=Nghishidi', userToken(['verify.view']));
    expect(audience(sent[0].body)).to.deep.equal(['edrms', 'intake']);
    const {items} = res.json();
    expect(items.map(d => d.id)).to.deep.equal([
      docs.grant.id,
      inIntake.documentId,
    ]);
    expect(items[1]).to.deep.include({
      status: 'intake',
      instrumentRef: 'T 4521/2019',
      party: 'Ndapewa Nghishidi',
      props: {property: 'Erf 1873, Klein Windhoek'},
    });
  });

  it('land-records gets documents in intake only when it asks for such a user; other services never', async () => {
    const {search, sent, serviceToken} = await withIndex({hits: three});
    await search('q=Nghishidi&intake=true', serviceToken('land-records'));
    await search('q=Nghishidi', serviceToken('land-records'));
    await search('q=Nghishidi&intake=true', serviceToken('intake'));
    expect(sent.map(s => audience(s.body))).to.deep.equal([
      ['edrms', 'intake'],
      ['edrms'],
      ['edrms'],
    ]);
  });

  it('a type filter goes into the query; a large total is "more than"', async () => {
    const {search, sent, userToken} = await withIndex({
      hits: three,
      relation: 'gte',
    });
    const res = await search(
      'q=Klein&docType=deed_of_grant',
      userToken(['record.view']),
    );
    expect(sent[0].body.query.bool.filter).to.deep.include({
      term: {docType: 'deed_of_grant'},
    });
    expect(sent[0].body.track_total_hits).to.equal(1000);
    expect(res.json()).to.include({totalCapped: true});
  });

  it("paging past the engine's first 10,000 matches is refused, without asking it", async () => {
    const {search, sent, userToken} = await withIndex({hits: three});
    const res = await search(
      'q=Klein&offset=9990&limit=20',
      userToken(['record.view']),
    );
    expect(res.statusCode).to.equal(400);
    expect(sent).to.have.length(0);
  });

  it('the engine unreachable or failing: a clear 503, never other results', async () => {
    for (const fail of [
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      () => ({status: 500, body: {error: {type: 'search_phase_execution'}}}),
    ]) {
      const {search, userToken} = await withIndex({fail});
      const res = await search('q=Klein', userToken(['record.view']));
      expect(res.statusCode).to.equal(503);
      expect(res.json().message).to.equal(
        'Document search is not available at the moment. Try again in a few minutes.',
      );
      expect(res.body).to.not.contain('ECONNREFUSED');
    }
  });

  it('a list without words, or with a field filter, stays the database search', async () => {
    const {search, sent, userToken} = await withIndex({hits: three});
    const all = await search('limit=10', userToken(['record.view']));
    const byField = await search(
      'q=Klein&field.regDiv=K',
      userToken(['record.view']),
    );
    expect(sent).to.have.length(0);
    expect(all.json().items.every(d => d.status === 'filed')).to.equal(true);
    expect(byField.json().total).to.be.above(0);
  });
});
