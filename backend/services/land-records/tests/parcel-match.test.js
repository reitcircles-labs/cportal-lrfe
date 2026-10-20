import {strict as assert} from 'node:assert';
import {parcelFromProperty, propertyMatches} from '../src/parcel-match.js';

describe('parcelFromProperty', () => {
  it('reads the forms used so far', () => {
    assert.deepEqual(
      parcelFromProperty('Erf 1873, Klein Windhoek', {regDiv: 'K'}),
      {kind: 'erf', number: '1873', township: 'Klein Windhoek', regDiv: 'K'},
    );
    assert.deepEqual(parcelFromProperty('Portion 2 of Erf 51, Eros'), {
      kind: 'erf',
      number: '51',
      township: 'Eros',
      portion: '2',
    });
    assert.deepEqual(parcelFromProperty('Erf No. 512, Olympia'), {
      kind: 'erf',
      number: '512',
      township: 'Olympia',
    });
    assert.deepEqual(
      parcelFromProperty('Portion 3 of the Farm Okapuka No. 64'),
      {
        kind: 'farm_portion',
        farmName: 'Okapuka',
        farmNumber: '64',
        portion: '3',
      },
    );
  });

  it('reads the parcel as title deeds write it, in capitals without a comma (API-718)', () => {
    assert.deepEqual(
      parcelFromProperty('ERF NO. 2417 OLYMPIA', {regDiv: 'K'}),
      {kind: 'erf', number: '2417', township: 'Olympia', regDiv: 'K'},
    );
    assert.deepEqual(parcelFromProperty('ERF NO. 815 KLEIN WINDHOEK'), {
      kind: 'erf',
      number: '815',
      township: 'Klein Windhoek',
    });
    assert.deepEqual(parcelFromProperty('Erf No 77 Eros'), {
      kind: 'erf',
      number: '77',
      township: 'Eros',
    });
    assert.deepEqual(
      parcelFromProperty('PORTION 4 OF ERF NO. 90 PIONIERSPARK'),
      {kind: 'erf', number: '90', township: 'Pionierspark', portion: '4'},
    );
    // the number as written; a township in capitals in name case, also after a hyphen or bracket
    assert.equal(parcelFromProperty('ERF NO. 2417A OLYMPIA').number, '2417A');
    assert.equal(
      parcelFromProperty('Erf 1873, KLEIN WINDHOEK').township,
      'Klein Windhoek',
    );
    assert.equal(
      parcelFromProperty('ERF NO. 12 KLEIN-WINDHOEK').township,
      'Klein-Windhoek',
    );
    assert.equal(
      parcelFromProperty('ERF NO. 7 OLYMPIA (EXTENSION NO. 1)').township,
      'Olympia (Extension No. 1)',
    );
  });

  it('still refuses what it cannot read', () => {
    assert.equal(parcelFromProperty('Erf 2417 Olympia'), null); // no "No." and no comma: the number and township are not clearly apart
    assert.equal(parcelFromProperty('A house in Windhoek'), null);
    assert.equal(parcelFromProperty(''), null);
  });

  it('a parcel read from a deed in capitals matches the other documents of the parcel', () => {
    const parcel = parcelFromProperty('ERF NO. 2417 OLYMPIA');
    for (const property of [
      'Erf 2417, Olympia',
      'ERF NO. 2417 OLYMPIA',
      'Erf 2417, Olympia, Windhoek',
    ]) {
      assert.ok(propertyMatches(parcel, property), property);
    }
    assert.ok(!propertyMatches(parcel, 'Erf 2418, Olympia'));
  });
});
