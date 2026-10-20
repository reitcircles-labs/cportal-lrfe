// Unit tests for the Details tab's offer to take encumbrances from the documents:
// `npm run test:link` (Node's test runner, which runs this TypeScript file directly).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import type {Encumbrance} from '../../api/records.api';
import {encumbranceOffer} from './encumbrance-suggestion.ts';

const BOND: Encumbrance = {
  type: 'bond',
  ref: 'B 1944/2014',
  inFavourOf: 'Omaruru Building Society Limited',
};
const BOND2: Encumbrance = {type: 'bond', ref: 'B 77/2019'};
const SERVITUDE: Encumbrance = {type: 'servitude', ref: 'K 12/1988'};

describe('encumbranceOffer', () => {
  it('offers nothing when the documents suggest nothing', () => {
    assert.equal(encumbranceOffer([], []), null);
    assert.equal(encumbranceOffer(null, [SERVITUDE]), null);
  });

  it('offers the bond to a draft without encumbrances, taken from the documents', () => {
    const o = encumbranceOffer([BOND], []);
    assert.equal(o?.label, 'Use B 1944/2014 from the documents');
    assert.deepEqual(o?.missing, [BOND]);
    assert.equal(o?.accept, true);
    assert.deepEqual(o?.encumbrances, [BOND]);
  });

  it('offers nothing once the draft has the bond, whatever the spacing or case', () => {
    assert.equal(encumbranceOffer([BOND], [BOND]), null);
    assert.equal(
      encumbranceOffer([BOND], [{type: 'bond', ref: ' b  1944/2014 '}]),
      null,
    );
  });

  it('keeps encumbrances entered by hand and adds only the missing bonds', () => {
    const o = encumbranceOffer([BOND, BOND2], [SERVITUDE, BOND]);
    assert.equal(o?.label, 'Use B 77/2019 from the documents');
    assert.equal(o?.accept, false);
    assert.deepEqual(o?.encumbrances, [SERVITUDE, BOND, BOND2]);
  });

  it('names every missing bond', () => {
    assert.equal(
      encumbranceOffer([BOND, BOND2], [])?.label,
      'Use B 1944/2014, B 77/2019 from the documents',
    );
  });

  it('does not offer a suggestion without a reference', () => {
    assert.equal(encumbranceOffer([{type: 'bond', ref: ''}], []), null);
    const o = encumbranceOffer([{type: 'bond', ref: ''}, BOND], []);
    assert.equal(o?.accept, false);
    assert.deepEqual(o?.encumbrances, [BOND]);
  });

  it('a bond and a servitude with the same reference are different encumbrances', () => {
    assert.equal(
      encumbranceOffer([BOND], [{type: 'servitude', ref: 'B 1944/2014'}])
        ?.missing.length,
      1,
    );
  });

  it("keeps a bond the officer corrected by hand instead of taking the documents' version of it", () => {
    const corrected = {...BOND, inFavourOf: 'Another Lender Limited'};
    const o = encumbranceOffer([BOND, BOND2], [corrected]);
    assert.equal(o?.accept, false);
    assert.deepEqual(o?.encumbrances, [corrected, BOND2]);
  });

  it('offers a bond named by two documents once', () => {
    const o = encumbranceOffer([BOND, {...BOND}], []);
    assert.equal(o?.label, 'Use B 1944/2014 from the documents');
    assert.equal(o?.missing.length, 1);
    assert.equal(o?.accept, false);
  });
});
