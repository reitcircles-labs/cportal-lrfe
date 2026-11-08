import {expect} from 'chai';
import {loadDomainPack, recordServiceOf} from '@lrfe/common';
import {buildApp} from '../src/app.js';
import {ExtractsService, formatExtractNo} from '../src/extracts.service.js';
import {ExtractCheck} from '../src/public-check.js';
import {createRecordsClient} from '../src/records-client.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {SECRET, testSettings} from './helpers.js';

describe('extracts and the domain pack (CB-3)', () => {
  it('takes the extract number prefix from the pack: EX for land', async () => {
    const land = await loadDomainPack('land');
    expect(formatExtractNo('NA', 2026, 12)).to.equal('EX-NA-2026-000012');
    expect(
      formatExtractNo('NA', 2026, 12, land.wording.extracts.numberPrefix),
    ).to.equal('EX-NA-2026-000012');
    expect(formatExtractNo('NA', 2026, 12, 'XB')).to.equal('XB-NA-2026-000012');
  });

  it('reads the land records through the record contract, with the same paths and texts (CB-4)', async () => {
    const land = await loadDomainPack('land');
    const service = recordServiceOf(land);
    expect(service.name).to.equal('land-records');
    const sent = [];
    const answers = [
      () => ({status: 200, text: async () => '{"id":"r 1"}'}),
      () => ({status: 404, text: async () => ''}),
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      () => ({status: 500, text: async () => '<html>'}),
    ];
    const records = createRecordsClient({
      baseUrl: 'http://records',
      label: service.label,
      record: land.wording.audit.record,
      serviceToken: () => 'token',
      fetchImpl: async (url, init) => {
        sent.push([init.method, url]);
        return answers.shift()();
      },
    });
    expect(await records.getRecord('r 1')).to.deep.equal({id: 'r 1'});
    expect(await records.getVersion('r 1', '2')).to.equal(null);
    const failures = [];
    for (const read of [
      () => records.getRecord('r'),
      () => records.getRecord('r'),
    ]) {
      try {
        await read();
      } catch (err) {
        failures.push([err.statusCode, err.message]);
      }
    }
    expect(sent).to.deep.equal([
      ['GET', 'http://records/records/r%201'],
      ['GET', 'http://records/records/r%201/versions/2'],
      ['GET', 'http://records/records/r'],
      ['GET', 'http://records/records/r'],
    ]);
    expect(failures).to.deep.equal([
      [503, 'The land records cannot be reached: connect ECONNREFUSED'],
      [502, 'Reading the land record failed (500)'],
    ]);
  });

  it('with the shipping pack: no record service, and a call for a record answers 503 (CB-4)', async () => {
    const shipping = await loadDomainPack('shipping');
    expect(recordServiceOf(shipping)).to.equal(null);
    const service = new ExtractsService({
      repo: createMemoryRepo(),
      events: null,
      settings: testSettings(),
      wording: shipping.wording.extracts,
    });
    let error;
    try {
      await service.listForRecord('r1');
    } catch (err) {
      error = err;
    }
    expect([error?.statusCode, error?.message]).to.deep.equal([
      503,
      'This install has no record service',
    ]);
  });

  it('with the empty shipping pack: the app starts and answers', async () => {
    const shipping = await loadDomainPack('shipping');
    const repo = createMemoryRepo();
    const service = new ExtractsService({
      repo,
      events: null,
      settings: testSettings(),
      wording: shipping.wording.extracts,
    });
    const check = new ExtractCheck({repo, timeZone: 'UTC'});
    const app = await buildApp({service, check, jwtSecret: SECRET});
    await app.ready();
    const answer = await app.inject({url: '/public/extracts/K7QF2M9DXH4T'});
    expect(answer.statusCode).to.equal(200);
    expect(answer.json().state).to.equal('unknown');
    await app.close();
  });
});
