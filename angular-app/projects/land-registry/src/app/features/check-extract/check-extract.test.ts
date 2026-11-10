// Unit tests for the extract check page's rules (API-693): `npm run test:check-extract`.
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {describe, it} from 'node:test';

import {
  dateTime,
  fileVerdict,
  printedCode,
  timeZoneName,
  typedCode,
} from './check-extract.ts';

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer;
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

describe('the extract check page', () => {
  it('reads a check code as the registry does', () => {
    assert.equal(typedCode('k7qf 2m9d xh4t'), 'K7QF2M9DXH4T');
    assert.equal(typedCode('K7QF-2M9D-XH4T'), 'K7QF2M9DXH4T');
    assert.equal(typedCode('KOQF 2M9D XHIL'), 'K0QF2M9DXH11');
    assert.equal(typedCode('K7QF 2M9D XH4U'), null);
    assert.equal(typedCode('K7QF 2M9D'), null);
    assert.equal(printedCode('K7QF2M9DXH4T'), 'K7QF 2M9D XH4T');
  });

  it("shows dates in the extract's time zone, named when not the viewer's (API-786)", () => {
    const issued = '2026-10-22T02:42:00.000Z';
    // the extract's time, whatever the viewer's time zone
    for (const viewer of ['Europe/Amsterdam', 'America/New_York', 'UTC']) {
      assert.equal(
        dateTime(issued, 'Africa/Windhoek', viewer),
        '22 Oct 2026, 04:42 (Windhoek time)',
      );
    }
    assert.equal(
      dateTime(issued, 'Africa/Windhoek', 'Africa/Windhoek'),
      '22 Oct 2026, 04:42',
    );
    assert.equal(
      dateTime(issued, 'UTC', 'Africa/Windhoek'),
      '22 Oct 2026, 02:42 (UTC)',
    );
    assert.equal(dateTime(null, 'Africa/Windhoek'), '');
    assert.equal(
      timeZoneName('America/Argentina/Buenos_Aires'),
      'Buenos Aires time',
    );
  });

  it('compares a file with the PDF as issued: only that very file matches', async () => {
    const issued = '%PDF-1.7 the extract as sealed';
    assert.equal(await fileVerdict(bytesOf(issued), sha256(issued)), 'match');
    assert.equal(
      await fileVerdict(bytesOf(issued), sha256(issued).toUpperCase()),
      'match',
    );
    // one character changed
    assert.equal(
      await fileVerdict(
        bytesOf('%PDF-1.7 the extract as sealeD'),
        sha256(issued),
      ),
      'nomatch',
    );
    assert.equal(
      await fileVerdict(bytesOf('a photo, not a PDF'), sha256(issued)),
      'notpdf',
    );
    assert.equal(await fileVerdict(bytesOf(''), sha256(issued)), 'notpdf');
  });
});
