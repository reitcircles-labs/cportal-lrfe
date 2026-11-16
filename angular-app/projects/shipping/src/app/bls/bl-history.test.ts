// Unit tests for the full chain of title (CB-53): which steps are exceptions, the parent's steps
// first, who did each step with their organisation, how each step stands on the blockchain, and
// the sentence above the table (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import type {ProofStatus, SignedEntry, StepResult} from './bl-check.ts';
import type {ChainRow} from './bl-format.ts';
import {
  type HistoryPart,
  historyRows,
  historySummary,
  isException,
} from './bl-history.ts';

const CONFIRMED: ProofStatus = {
  state: 'confirmed',
  label: 'confirmed',
  at: '2026-11-16T09:00:00Z',
};
const PENDING: ProofStatus = {state: 'pending', label: 'pending', at: null};

const CONTEXT = {
  names: {'org-carrier': 'Bluewater Lines', 'org-bank': 'Harbour Bank'},
  date: (at: string) => at.slice(0, 10),
  signature: (check: StepResult['check']) => `signature ${check}`,
};

/**
 * A signed step.
 * @param seq its number
 * @param command what was done
 * @param extra more fields
 * @return the step
 */
function entry(
  seq: number,
  command: string,
  extra: Partial<SignedEntry> = {},
): SignedEntry {
  return {
    seq,
    command,
    from: null,
    to: 'org-bank',
    actor: {id: 'u1', name: 'Ravi Menon', org: 'org-carrier'},
    at: `2026-11-1${seq}T08:00:00Z`,
    recordId: 'bl-1',
    endorsement: 'named',
    documentHash: 'd',
    previousHash: null,
    kid: 'k',
    entryHash: `h${seq}`,
    signature: 's',
    ...extra,
  };
}

/**
 * How the B/L's page words a step.
 * @param e the step
 * @return its row
 */
function words(e: SignedEntry): ChainRow {
  return {
    seq: e.seq,
    step: e.command,
    from: e.from ?? '—',
    to: e.to ?? '—',
    by: e.actor.name ?? '—',
    at: e.at,
  };
}

/**
 * A part of the chain with every step checked as given.
 * @param part which part
 * @param entries its steps
 * @param checks the check of each step, all "checked" by default
 * @return the part
 */
function partOf(
  part: HistoryPart['part'],
  entries: SignedEntry[],
  checks: Array<StepResult['check']> = [],
): HistoryPart {
  return {
    part,
    entries,
    words: entries.map(words),
    results: entries.map((e, index) => ({
      seq: e.seq,
      check: checks[index] ?? 'checked',
    })),
  };
}

describe('the full chain of title', () => {
  it('marks the exceptions to the plain journey', () => {
    assert.equal(isException(entry(1, 'issue')), false);
    assert.equal(isException(entry(2, 'endorse')), false);
    assert.equal(
      isException(entry(2, 'endorse', {endorsement: 'blank'})),
      true,
    );
    for (const command of [
      'amend',
      'split',
      'issue-from-split',
      'switch-to-paper',
      'void',
      'transfer',
      'surrender-for-amendment',
    ]) {
      assert.equal(isException(entry(3, command)), true, command);
    }
  });

  it("lists the parent's steps first, each with who did it and their organisation", () => {
    const rows = historyRows(
      [
        partOf('parent', [entry(1, 'issue'), entry(2, 'split')]),
        partOf('this', [entry(1, 'issue-from-split'), entry(2, 'endorse')]),
      ],
      CONFIRMED,
      CONTEXT,
    );
    assert.deepEqual(
      rows.map(row => `${row.part} ${row.seq} ${row.step}`),
      [
        'parent 1 issue',
        'parent 2 split',
        'this 1 issue-from-split',
        'this 2 endorse',
      ],
    );
    assert.equal(rows[0].by, 'Ravi Menon, Bluewater Lines');
    assert.equal(rows[0].signature, 'signature checked');
    assert.deepEqual(
      rows.map(row => row.exception),
      [false, true, true, false],
    );
  });

  it('records the latest step on the blockchain and links every earlier one to it', () => {
    const rows = historyRows(
      [partOf('this', [entry(1, 'issue'), entry(2, 'endorse')])],
      CONFIRMED,
      CONTEXT,
    );
    assert.equal(rows[1].blockchain, 'On the blockchain, confirmed 2026-11-16');
    assert.equal(
      rows[0].blockchain,
      'Linked to the latest step on the blockchain',
    );
  });

  it('says so while the latest step is not on the blockchain yet', () => {
    const rows = historyRows(
      [partOf('this', [entry(1, 'issue'), entry(2, 'endorse')])],
      PENDING,
      CONTEXT,
    );
    assert.equal(rows[1].blockchain, 'Pending: not on the blockchain yet');
    assert.equal(
      rows[0].blockchain,
      'Linked to the latest step, which is not on the blockchain yet',
    );
  });

  it('proves nothing before a step whose signature fails', () => {
    const rows = historyRows(
      [
        partOf(
          'this',
          [entry(1, 'issue'), entry(2, 'endorse'), entry(3, 'surrender')],
          ['checked', 'failed', 'checked'],
        ),
      ],
      CONFIRMED,
      CONTEXT,
    );
    assert.equal(rows[2].blockchain, 'On the blockchain, confirmed 2026-11-16');
    assert.equal(
      rows[1].blockchain,
      'Linked to the latest step on the blockchain',
    );
    assert.equal(rows[0].blockchain, 'Not proven: the link breaks at step 2');
    assert.match(historySummary(rows, CONFIRMED), /1 of 3 steps do not match/);
  });

  it('sums the chain up in one sentence', () => {
    const rows = historyRows(
      [partOf('this', [entry(1, 'issue'), entry(2, 'endorse')])],
      CONFIRMED,
      CONTEXT,
    );
    assert.equal(
      historySummary(rows, CONFIRMED),
      "All 2 steps carry the platform's signature, checked in your browser. The latest step is on the blockchain, and every earlier step is linked to it.",
    );
    assert.equal(
      historySummary([], CONFIRMED),
      'This B/L has no steps yet: it is not issued.',
    );
  });
});
