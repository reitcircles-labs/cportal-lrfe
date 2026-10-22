import {expect} from 'chai';
import {
  formatExtractNo,
  newCheckCode,
  normalizeCheckCode,
  printedCheckCode,
} from '../src/extracts.service.js';
import {actor, committedErf1873, makeExtracts, users} from './helpers.js';

const rec = actor(users.rec);

/** An extract of Erf 1873's version 1 for Maria Nghishidi, her ID document seen. */
const issue = (ctx, record) =>
  ctx.service.issue(
    {
      recordId: record.id,
      versionNumber: 1,
      ownerIndex: 0,
      idNo: '75060200418',
      documentSeen: true,
    },
    rec,
  );

describe('extract numbers and check codes (API-692)', () => {
  it('formats the number like record numbers, and a check code in three groups of four', () => {
    expect(formatExtractNo('NA', 2026, 12)).to.equal('EX-NA-2026-000012');
    expect(printedCheckCode('K7QF2M9DXH4T')).to.equal('K7QF 2M9D XH4T');
    const code = newCheckCode();
    expect(code).to.match(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(new Set(Array.from({length: 200}, newCheckCode)).size).to.equal(200);
  });

  it('reads a typed check code: spaces, dashes and lower case ignored, O read as 0, I and L as 1', () => {
    expect(normalizeCheckCode('k7qf 2m9d xh4t')).to.equal('K7QF2M9DXH4T');
    expect(normalizeCheckCode('K7QF-2M9D-XH4T')).to.equal('K7QF2M9DXH4T');
    expect(normalizeCheckCode('KOQF 2M9D XHIL')).to.equal('K0QF2M9DXH11');
    // U is never in a code, and a code has exactly 12 characters
    expect(normalizeCheckCode('K7QF 2M9D XH4U')).to.equal(null);
    expect(normalizeCheckCode('K7QF 2M9D XH4')).to.equal(null);
    expect(normalizeCheckCode('')).to.equal(null);
  });

  it('numbers the extracts of a year from 1, and an issue that fails uses no number', async () => {
    const ctx = await makeExtracts();
    const record = await committedErf1873(ctx.records);
    const first = await issue(ctx, record);
    expect(first.extractNo).to.equal('EX-NA-2026-000001');
    expect(first.checkCode).to.match(/^[0-9A-HJKMNP-TV-Z]{12}$/);

    // storing the PDF fails: nothing is saved, and the number is not used
    const put = ctx.service.files.put;
    ctx.service.files.put = async () => {
      throw new Error('disk full');
    };
    await issue(ctx, record).then(
      () => expect.fail('the issue must fail'),
      err => expect(err.message).to.equal('disk full'),
    );
    ctx.service.files.put = put;

    const second = await issue(ctx, record);
    expect(second.extractNo).to.equal('EX-NA-2026-000002');
    expect(second.checkCode).not.to.equal(first.checkCode);
    const {items} = await ctx.service.listForRecord(record.id);
    expect(items.map(e => e.extractNo)).to.deep.equal([
      'EX-NA-2026-000002',
      'EX-NA-2026-000001',
    ]);
  });

  it('the public check finds an extract by its check code as typed, as by its QR code', async () => {
    const ctx = await makeExtracts();
    const record = await committedErf1873(ctx.records);
    const extract = await issue(ctx, record);
    const typed = printedCheckCode(extract.checkCode).toLowerCase();
    for (const code of [extract.checkCode, typed]) {
      const res = await ctx.app.inject({
        url: `/public/extracts/${encodeURIComponent(code)}`,
      });
      expect(res.statusCode, code).to.equal(200);
      expect(res.json(), code).to.include({
        state: 'current',
        extractId: extract.id,
        extractNo: 'EX-NA-2026-000001',
      });
    }
  });
});
