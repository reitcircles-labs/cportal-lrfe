import {expect} from 'chai';
import {loadDomainPack} from '@lrfe/common';
import {buildApp} from '../src/app.js';
import {ExtractsService, formatExtractNo} from '../src/extracts.service.js';
import {ExtractCheck} from '../src/public-check.js';
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
