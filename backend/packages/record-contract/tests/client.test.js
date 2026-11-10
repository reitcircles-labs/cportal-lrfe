import {expect} from 'chai';

import {RECORD_CALLS, createRecordClient, pathOf} from '../src/index.js';

describe('record contract client', () => {
  const sent = [];
  const client = createRecordClient(async (method, path, body) => {
    sent.push({method, path, body});
    return {ok: true};
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it('names every call of the contract', () => {
    expect(Object.keys(RECORD_CALLS)).to.deep.equal([
      'list',
      'get',
      'versions',
      'version',
      'lookup',
      'seals',
      'verify',
      'commit',
      'reject',
    ]);
    expect(Object.keys(client)).to.deep.equal(Object.keys(RECORD_CALLS));
  });

  it('builds the paths the record service answers', async () => {
    const by = {id: 'u1', name: 'A'};
    await client.list({status: 'committed', limit: 5, offset: 0, q: 'erf'});
    await client.get('r1');
    await client.versions('r1');
    await client.version('r1', 2);
    await client.lookup({records: ['r1']});
    await client.seals({limit: 100, after: 'r1:2'});
    await client.verify('r1');
    await client.commit('r1', 2, {by});
    await client.reject('r1', 3, {by, comment: 'no'});
    expect(sent.map(s => `${s.method} ${s.path}`)).to.deep.equal([
      'GET /records?status=committed&limit=5&offset=0&q=erf',
      'GET /records/r1',
      'GET /records/r1/versions',
      'GET /records/r1/versions/2',
      'POST /records/lookup',
      'GET /records/seals?limit=100&after=r1%3A2',
      'GET /records/r1/verify',
      'POST /records/r1/versions/2/commit',
      'POST /records/r1/versions/3/reject',
    ]);
    expect(sent[4].body).to.deep.equal({records: ['r1']});
    expect(sent[8].body).to.deep.equal({by, comment: 'no'});
  });

  it('leaves out empty query entries and encodes ids', () => {
    expect(pathOf('/records', {}, {q: undefined, status: 'x'})).to.equal(
      '/records?status=x',
    );
    expect(pathOf('/records/:id', {id: 'a/b'})).to.equal('/records/a%2Fb');
    expect(pathOf('/records/seals', {}, {limit: 5, after: undefined})).to.equal(
      '/records/seals?limit=5',
    );
  });
});
