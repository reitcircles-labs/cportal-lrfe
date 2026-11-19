// Unit tests for the searchable SMDG carrier code picker (CB-68, `npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  carrierOptionLabel,
  filterCarriers,
  isKnownCarrier,
  type CarrierOption,
} from './carrier-picker.ts';

const CARRIERS: readonly CarrierOption[] = [
  {code: 'CMA', name: 'CMA CGM'},
  {code: 'HLC', name: 'Hapag-Lloyd'},
  {code: 'MSC', name: 'Mediterranean Shipping Company'},
  {code: 'MSK', name: 'Maersk'},
  {code: 'TRL', name: 'Türkish Line'},
];

describe('SMDG carrier code picker helper (CB-68)', () => {
  it('formats each option with its code and carrier name', () => {
    assert.equal(carrierOptionLabel(CARRIERS[3]), 'MSK — Maersk');
  });

  it('filters by code or carrier name, ignoring case and accents', () => {
    assert.deepEqual(
      filterCarriers(CARRIERS, '').map(c => c.code),
      ['CMA', 'HLC', 'MSC', 'MSK', 'TRL'],
    );
    assert.deepEqual(
      filterCarriers(CARRIERS, 'maersk').map(c => c.code),
      ['MSK'],
    );
    assert.deepEqual(
      filterCarriers(CARRIERS, 'turkish').map(c => c.code),
      ['TRL'],
    );
    assert.deepEqual(
      filterCarriers(CARRIERS, 'ms').map(c => c.code),
      ['MSC', 'MSK'],
    );
  });

  it('keeps the currently selected carrier visible even when filtered out', () => {
    assert.deepEqual(
      filterCarriers(CARRIERS, 'maersk', 'HLC').map(c => c.code),
      ['HLC', 'MSK'],
    );
  });

  it('checks whether a code belongs to the SMDG list', () => {
    assert.equal(isKnownCarrier('msk', CARRIERS), true);
    assert.equal(isKnownCarrier('BWML', CARRIERS), false);
    assert.equal(isKnownCarrier('', CARRIERS), false);
  });
});
