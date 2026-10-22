// Unit tests for the extract check page's rules (API-693): `npm run test:check-extract`.
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {describe, it} from 'node:test';

import {fileVerdict, printedCode, typedCode} from './check-extract.ts';

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
