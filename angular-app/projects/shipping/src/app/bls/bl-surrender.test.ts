// Unit tests for the surrender and the release on a B/L's page (CB-46): which of the two the page
// offers, what each confirmation asks and says, what the toast says once it is done, and the note
// that tells where the B/L stands at the end (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  settlementCommands,
  settlementQuestion,
  titleNote,
} from './bl-surrender.ts';

describe('what the page offers', () => {
  it('the holder: "Surrender to the carrier", next to its endorsement', () => {
    const offered = settlementCommands(['endorse', 'surrender']);
    assert.deepEqual(
      offered.map(c => [c.name, c.label]),
      [['surrender', 'Surrender to the carrier']],
    );
  });

  it('the carrier of a surrendered B/L: "Release the goods"', () => {
    const offered = settlementCommands(['release']);
    assert.deepEqual(
      offered.map(c => [c.name, c.label]),
      [['release', 'Release the goods']],
    );
  });

  it('nothing to whom the title read allows neither', () => {
    assert.deepEqual(settlementCommands([]), []);
    assert.deepEqual(settlementCommands(['issue', 'void']), []);
    assert.deepEqual(settlementCommands(['endorse']), []);
  });

  it('not the other ways a B/L ends or comes back (R2)', () => {
    const others = [
      'surrender-for-amendment',
      'switch-to-paper',
      'deliver',
      'transfer',
      'amend',
      'split',
    ];
    assert.deepEqual(settlementCommands(others), []);
  });

  it('in a fixed order, unknown names left out', () => {
    const offered = settlementCommands(['release', 'unknown', 'surrender']);
    assert.deepEqual(
      offered.map(c => c.name),
      ['surrender', 'release'],
    );
  });

  it('a fresh list each time: changing one leaves the next alone', () => {
    const first = settlementCommands(['surrender']);
    first[0].label = 'changed';
    first.pop();
    assert.equal(
      settlementCommands(['surrender'])[0].label,
      'Surrender to the carrier',
    );
  });
});

describe('the confirmations', () => {
  it('the surrender: the carrier holds the B/L to release the goods, no more endorsing', () => {
    const [surrender] = settlementCommands(['surrender']);
    assert.equal(
      surrender.body,
      'The carrier will hold the B/L to release the goods; you can no longer endorse it.',
    );
    assert.equal(surrender.confirmLabel, 'Surrender');
  });

  it('the release: the goods go out and the B/L is accomplished, with no holder', () => {
    const [release] = settlementCommands(['release']);
    assert.equal(
      release.body,
      'The B/L becomes accomplished: nobody holds it any more and its chain of title is complete.',
    );
    assert.equal(release.confirmLabel, 'Release');
  });

  it('each asks about the B/L by its label', () => {
    assert.equal(
      settlementQuestion('surrender', 'CBL-2026-000123'),
      'Surrender CBL-2026-000123 to the carrier?',
    );
    assert.equal(
      settlementQuestion('release', 'CBL-2026-000123'),
      'Release the goods of CBL-2026-000123?',
    );
  });

  it('"this B/L" while its label is not known', () => {
    assert.equal(
      settlementQuestion('surrender', ''),
      'Surrender this B/L to the carrier?',
    );
    assert.equal(
      settlementQuestion('release', ''),
      'Release the goods of this B/L?',
    );
  });
});

describe('the toasts once done', () => {
  it('surrendered to the carrier; goods released, the B/L accomplished', () => {
    const [surrender, release] = settlementCommands(['surrender', 'release']);
    assert.equal(surrender.done, 'B/L surrendered to the carrier');
    assert.equal(release.done, 'Goods released: the B/L is accomplished');
  });
});

describe('where the B/L stands at the end', () => {
  it('surrendered: held by the carrier to release the goods', () => {
    assert.equal(
      titleNote('surrendered'),
      'Surrendered: the carrier holds the B/L to release the goods.',
    );
  });

  it('accomplished: the goods released, no holder, the chain of title complete', () => {
    assert.equal(
      titleNote('accomplished'),
      'Accomplished: the goods are released, nobody holds the B/L any more and its chain of title is complete.',
    );
  });

  it('nothing for the other states, before issue or for an unknown one', () => {
    for (const state of ['issued', 'with-holder', 'void', 'split', 'x']) {
      assert.equal(titleNote(state), '', state);
    }
    assert.equal(titleNote(null), '');
  });
});
