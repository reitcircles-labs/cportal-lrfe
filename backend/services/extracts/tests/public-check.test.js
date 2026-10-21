import {expect} from 'chai';
import {AppError} from '@lrfe/common';
import {newToken} from '../src/extracts.service.js';
import {createVersionCheckClient} from '../src/version-check-client.js';
import {commitVersion, erf1873Data} from '../../land-records/tests/helpers.js';
import {TX, actor, committedErf1873, makeExtracts, users} from './helpers.js';

const rec = actor(users.rec);

/** Every field of an answer, whatever its state. */
const FIELDS = [
  'batch',
  'checkedAt',
  'explorerUrl',
  'extractId',
  'fingerprintEnd',
  'issuedAt',
  'recordNo',
  'replacedAt',
  'revokedAt',
  'state',
  'transactionId',
  'versionNumber',
];

/** What must never be in an answer: the owners, their ID numbers and shares, the parcel. */
const PERSONAL = [
  'Nghishidi',
  'Maria',
  '75060200418',
  '98030100562',
  '01112500379',
  '1/2',
  '1/4',
  'T 4521/2019',
  'Klein Windhoek',
  'Khomas',
  'Erf',
  'ownerName',
  'ownerIdLast4',
  'idNo',
  'token',
  'wrong owner',
];

/** Erf 1873, version 1 committed, and an extract issued for Maria Nghishidi on it. */
async function issued(ctx) {
  const record = await committedErf1873(ctx.records);
  const extract = await ctx.service.issue(
    {
      recordId: record.id,
      versionNumber: 1,
      ownerIndex: 0,
      idNo: '75060200418',
      documentSeen: true,
    },
    rec,
  );
  return {record, extract};
}

/** GET /public/extracts/:token, with no sign-in. */
async function checkOver(app, token) {
  const res = await app.inject({
    url: `/public/extracts/${encodeURIComponent(token)}`,
  });
  return {status: res.statusCode, body: res.json(), raw: res.body, res};
}

function expectNoPersonalData(raw) {
  for (const text of PERSONAL) expect(raw, text).to.not.include(text);
}

describe('the public check of an extract (API-693)', () => {
  it('current: matches the record, version 1, on the blockchain in batch 7, still current', async () => {
    const ctx = await makeExtracts();
    const {record, extract} = await issued(ctx);
    const {status, body, raw, res} = await checkOver(ctx.app, extract.token);
    expect(status).to.equal(200);
    expect(res.headers['cache-control']).to.equal('no-store');
    expect(Object.keys(body).sort()).to.deep.equal(FIELDS);
    expect(body).to.include({
      state: 'current',
      extractId: extract.id,
      recordNo: record.recordNo,
      versionNumber: 1,
      fingerprintEnd: record.current.seal.slice(-8),
      batch: 7,
      transactionId: TX,
      explorerUrl: `https://preview.cexplorer.io/tx/${TX}`,
      replacedAt: null,
      revokedAt: null,
    });
    expect(body.issuedAt).to.equal(extract.issuedAt.toISOString());
    expectNoPersonalData(raw);
  });

  it('replaced: matches, but the record has a newer version since it was committed', async () => {
    const ctx = await makeExtracts();
    const {record, extract} = await issued(ctx);
    await ctx.records.service.openDraft(record.id, rec);
    const data = erf1873Data();
    data.owners.reverse();
    await commitVersion(ctx.records, record.id, 2, data);
    const v2 = (await ctx.records.service.getRecord(record.id)).current;
    const {body, raw} = await checkOver(ctx.app, extract.token);
    expect(body).to.include({
      state: 'replaced',
      versionNumber: 1,
      fingerprintEnd: record.current.seal.slice(-8),
      batch: 7,
      transactionId: TX,
      revokedAt: null,
    });
    expect(body.replacedAt).to.equal(new Date(v2.committedAt).toISOString());
    expectNoPersonalData(raw);
  });

  it('replaced: v1 with v3 current is replaced since v2 was committed', async () => {
    const ctx = await makeExtracts();
    const {record, extract} = await issued(ctx);
    for (const n of [2, 3]) {
      ctx.clock.advance(24 * 3_600_000);
      ctx.records.clock.advance(24 * 3_600_000);
      await ctx.records.service.openDraft(record.id, rec);
      const data = erf1873Data();
      if (n === 2) data.owners.reverse();
      await commitVersion(ctx.records, record.id, n, data);
    }
    const v2 = await ctx.records.service.getVersion(record.id, 2);
    const v3 = (await ctx.records.service.getRecord(record.id)).current;
    expect(v3.versionNumber).to.equal(3);
    expect(v3.committedAt).to.not.deep.equal(v2.committedAt);
    const {body} = await checkOver(ctx.app, extract.token);
    expect(body).to.include({state: 'replaced', versionNumber: 1});
    expect(body.replacedAt).to.equal(new Date(v2.committedAt).toISOString());

    // the next version cannot be read now: unavailable, not a guessed date
    ctx.check.records = {
      getRecord: ctx.check.records.getRecord,
      async getVersion() {
        throw new AppError(503, 'The land records cannot be reached');
      },
    };
    expect((await checkOver(ctx.app, extract.token)).body.state).to.equal(
      'unavailable',
    );
  });

  it('revoked: the date only, never the reason', async () => {
    const ctx = await makeExtracts();
    const {extract} = await issued(ctx);
    ctx.clock.advance(60_000);
    await ctx.service.revoke(
      extract.id,
      {reason: 'Issued for the wrong owner, Maria Nghishidi'},
      rec,
    );
    const {body, raw} = await checkOver(ctx.app, extract.token);
    expect(Object.keys(body).sort()).to.deep.equal(FIELDS);
    expect(body).to.include({
      state: 'revoked',
      extractId: extract.id,
      revokedAt: ctx.clock().toISOString(),
      fingerprintEnd: null,
      batch: null,
      transactionId: null,
    });
    expectNoPersonalData(raw);
    // the registry's word is enough: nothing else is asked
    expect(ctx.versions.calls).to.equal(0);
  });

  it('unknown: the same fields, all empty, for a token never issued, a malformed one or a long one', async () => {
    const ctx = await makeExtracts();
    await issued(ctx);
    for (const token of [newToken(), 'abc', 'x'.repeat(43), '../extracts']) {
      const {status, body} = await checkOver(ctx.app, token);
      expect(status, token).to.equal(200);
      expect(Object.keys(body).sort()).to.deep.equal(FIELDS);
      const {state, checkedAt, ...rest} = body;
      expect(state).to.equal('unknown');
      expect(checkedAt).to.be.a('string');
      expect(Object.values(rest).every(v => v === null)).to.equal(true);
    }
    expect(ctx.versions.calls).to.equal(0);
  });

  it('unavailable when the audit service cannot answer, or the check could not be made now: never current', async () => {
    const ctx = await makeExtracts();
    const {record, extract} = await issued(ctx);
    ctx.versions.down = true;
    let {body, raw} = await checkOver(ctx.app, extract.token);
    expect(body).to.include({
      state: 'unavailable',
      extractId: extract.id,
      fingerprintEnd: null,
      batch: null,
      transactionId: null,
      explorerUrl: null,
    });
    expectNoPersonalData(raw);

    // the blockchain could not be read now: that check is null, the version not valid
    ctx.versions.down = false;
    ctx.versions.result[`${record.id}:1`] = {
      valid: false,
      status: 'confirmed',
      checks: {item: true, path: true, chain: null},
      seal: record.current.seal,
      batch: 7,
      tx: TX,
    };
    ({body} = await checkOver(ctx.app, extract.token));
    expect(body.state).to.equal('unavailable');

    // anchored but not confirmed yet: not answered as current
    ctx.versions.result[`${record.id}:1`] = {
      valid: true,
      status: 'anchored',
      checks: {item: true, path: true, chain: true},
      seal: record.current.seal,
      batch: 7,
      tx: TX,
    };
    ({body} = await checkOver(ctx.app, extract.token));
    expect(body.state).to.equal('unavailable');
  });

  it('unavailable when land-records cannot be read', async () => {
    const ctx = await makeExtracts();
    const {extract} = await issued(ctx);
    ctx.check.records = {
      async getRecord() {
        throw new AppError(503, 'The land records cannot be reached');
      },
    };
    const {status, body} = await checkOver(ctx.app, extract.token);
    expect(status).to.equal(200);
    expect(body.state).to.equal('unavailable');
    expect(ctx.versions.calls).to.equal(0);
  });

  it('unavailable when the register cannot be read', async () => {
    const ctx = await makeExtracts();
    const {extract} = await issued(ctx);
    ctx.check.repo = {
      async getExtractByToken() {
        throw new Error('connection refused');
      },
    };
    const {body} = await checkOver(ctx.app, extract.token);
    expect(body).to.include({state: 'unavailable', extractId: null});
  });

  it('mismatch when a check fails: the seal changed, or differs from the one land-records holds', async () => {
    const ctx = await makeExtracts();
    const {record, extract} = await issued(ctx);
    ctx.versions.result[`${record.id}:1`] = {
      valid: false,
      status: 'confirmed',
      checks: {item: false, path: true, chain: true},
      seal: record.current.seal,
      batch: 7,
      tx: TX,
    };
    let {body} = await checkOver(ctx.app, extract.token);
    expect(body).to.include({
      state: 'mismatch',
      fingerprintEnd: null,
      batch: null,
    });

    ctx.versions.result[`${record.id}:1`] = {
      valid: true,
      status: 'confirmed',
      checks: {item: true, path: true, chain: true},
      seal: 'f'.repeat(64),
      batch: 7,
      tx: TX,
    };
    ({body} = await checkOver(ctx.app, extract.token));
    expect(body.state).to.equal('mismatch');
  });

  it('logs every check with its state and the extract id only, and never the token', async () => {
    const lines = [];
    const ctx = await makeExtracts();
    const {extract} = await issued(ctx);
    const {buildApp} = await import('../src/app.js');
    const app = await buildApp({
      service: ctx.service,
      check: ctx.check,
      jwtSecret: 'test-secret',
      logger: {
        level: 'info',
        stream: {write: line => lines.push(JSON.parse(line))},
      },
    });
    await app.ready();
    await checkOver(app, extract.token);
    await checkOver(app, newToken());
    const checks = lines.filter(l => l.msg === 'extract checked');
    expect(
      checks.map(l => [l.state, l.extractId, l.reason ?? null]),
    ).to.deep.equal([
      ['current', extract.id, null],
      ['unknown', null, null],
    ]);
    for (const line of checks) expectNoPersonalData(JSON.stringify(line));
    // the request logs show the path without the token: it is what lets anyone check the extract
    const requests = lines.filter(l => l.req);
    expect(requests.map(l => l.req.url)).to.deep.equal([
      '/public/extracts/<token>',
      '/public/extracts/<token>',
    ]);
    expect(JSON.stringify(lines)).to.not.include(extract.token);
  });

  it('exposes nothing else under /public: no search, no listing, no other method', async () => {
    const ctx = await makeExtracts();
    const {record, extract} = await issued(ctx);
    for (const url of [
      '/public',
      '/public/extracts',
      '/public/extracts?recordId=' + record.id,
      `/public/records/${record.id}`,
      `/public/extracts/${extract.token}/owners`,
    ]) {
      const res = await ctx.app.inject({url});
      expect(res.statusCode, url).to.equal(404);
    }
    // there is no search: a word where the token goes is a token nobody was given
    const search = await ctx.app.inject({
      url: '/public/extracts/search?q=1873',
    });
    expect(search.json().state).to.equal('unknown');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await ctx.app.inject({
        method,
        url: `/public/extracts/${extract.token}`,
        payload: {},
      });
      expect(res.statusCode, method).to.equal(404);
    }
    // the staff routes still need a sign-in
    expect(
      (await ctx.app.inject({url: `/extracts?recordId=${record.id}`}))
        .statusCode,
    ).to.equal(401);
  });

  describe('the audit service client', () => {
    const answer = {valid: true, status: 'confirmed'};
    const client = fetchImpl =>
      createVersionCheckClient({
        baseUrl: 'http://audit',
        serviceToken: () => 'service-token',
        fetchImpl,
      });

    it('asks POST /audit/anchoring/check with the service token', async () => {
      let asked;
      const got = await client(async (url, init) => {
        asked = {url, init};
        return {ok: true, json: async () => answer};
      }).checkVersion('r1', 2);
      expect(got).to.deep.equal(answer);
      expect(asked.url).to.equal('http://audit/audit/anchoring/check');
      expect(asked.init.method).to.equal('POST');
      expect(asked.init.headers.authorization).to.equal('Bearer service-token');
      expect(JSON.parse(asked.init.body)).to.deep.equal({
        recordId: 'r1',
        version: 2,
      });
    });

    it('is null, never an error, when the audit service cannot answer', async () => {
      expect(
        await client(async () => ({ok: false, status: 404})).checkVersion(
          'r1',
          1,
        ),
      ).to.equal(null);
      expect(
        await client(async () => {
          throw new Error('ECONNREFUSED');
        }).checkVersion('r1', 1),
      ).to.equal(null);
      expect(
        await client(async () => ({
          ok: true,
          json: async () => {
            throw new SyntaxError('not JSON');
          },
        })).checkVersion('r1', 1),
      ).to.equal(null);
    });
  });
});
