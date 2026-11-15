// Unit tests for "Check a B/L by number" on the shipping app's home (CB-47): what is asked of the
// service for what the user typed, and what the box does with the answer: open the B/L found,
// offer the choice when two carriers used the same number, or say not found, the same words
// whether the B/L does not exist or the organisation is not party to it (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  LOOKUP_NOT_FOUND,
  MAX_NUMBER_LENGTH,
  lookupOutcome,
  numberProblem,
  numberQuery,
} from './bl-lookup.ts';
import type {BlListItem} from './bl.model.ts';

/**
 * A B/L of the list, as the lookup answers it.
 * @param id its id
 * @param carrierCode its carrier's code
 * @return the item
 */
function item(id: string, carrierCode = 'MAEU'): BlListItem {
  return {
    id,
    recordNo: 'CB47NUMBER1',
    carrierCode,
    label: `B/L CB47NUMBER1 (${carrierCode})`,
    status: 'committed',
    draftState: null,
    createdAt: '2026-11-14T08:00:00.000Z',
    updatedAt: '2026-11-14T08:00:00.000Z',
    title: null,
    roles: ['holder'],
  };
}

describe('what is asked for what the user typed', () => {
  it('the number without the spaces around it', () => {
    assert.equal(numberQuery('  CB47NUMBER1 '), 'CB47NUMBER1');
  });

  it('nothing for a blank box', () => {
    assert.equal(numberQuery(''), null);
    assert.equal(numberQuery('   '), null);
  });

  it(`nothing for more than ${MAX_NUMBER_LENGTH} characters`, () => {
    assert.equal(MAX_NUMBER_LENGTH, 100);
    assert.equal(numberQuery('A'.repeat(100)), 'A'.repeat(100));
    assert.equal(numberQuery('A'.repeat(101)), null);
  });

  it('why nothing is asked', () => {
    assert.equal(numberProblem(''), 'Type the B/L number.');
    assert.equal(
      numberProblem('A'.repeat(101)),
      'A B/L number has at most 100 characters.',
    );
    assert.equal(numberProblem('CB47NUMBER1'), null);
  });
});

describe('what the box does with the answer', () => {
  it('one B/L found: it opens', () => {
    assert.deepEqual(lookupOutcome([item('rec-1')]), {
      kind: 'open',
      id: 'rec-1',
    });
  });

  it('none found: not found', () => {
    assert.deepEqual(lookupOutcome([]), {kind: 'not-found'});
  });

  it('two carriers used the number: the user picks', () => {
    const items = [item('rec-1', 'MAEU'), item('rec-2', 'HLCU')];
    assert.deepEqual(lookupOutcome(items), {kind: 'choose', items});
  });

  it('not found never says whether the B/L exists', () => {
    assert.equal(
      LOOKUP_NOT_FOUND,
      'No B/L found with that number. It does not exist, or your organisation is not party to it.',
    );
  });
});
