// Unit tests for the change of a B/L on its page (CB-50, from the CB-14 design): the holder asking
// the carrier for a change, what the page says while the carrier holds the B/L for it, the
// versions of an amended B/L, what earlier holders are told (never the new values) and the
// refusals of the record service in plain words (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  ASK_FOR_CHANGE,
  askForChangeQuestion,
  mayAmend,
  mayAskForChange,
  maySplit,
  pastHolderNote,
  refusalOf,
  seesVersions,
} from './bl-change.ts';
// (changed: CB-50 build) these three were imported from bl-change.ts: they need the names of
// bl-format.ts, and a module tested by Node cannot import another's values
import {
  changeHolderLabel,
  changeRequestNote,
  versionHistory,
} from './bl-format.ts';
import type {ChainEntry, TitleSummary, Viewer} from './bl.model.ts';

const BANK: Viewer = {organisationId: 'org-bank', organisation: 'Volta Bank'};
const CARRIER: Viewer = {
  organisationId: 'org-carrier',
  organisation: 'Ocean Lines',
};
const SHIPPER: Viewer = {
  organisationId: 'org-shipper',
  organisation: 'Coffee Exporters',
};
const NAMES = {
  'org-bank': 'Volta Bank',
  'org-carrier': 'Ocean Lines',
  'org-shipper': 'Coffee Exporters',
};

/**
 * A title with the fields the page reads.
 * @param over the fields that differ from a B/L to order held by the bank
 * @return the title
 */
function title(over: Partial<TitleSummary>): TitleSummary {
  return {
    kind: 'negotiable',
    state: 'with-holder',
    carrier: 'org-carrier',
    holder: 'org-bank',
    endorsement: 'named',
    consignee: null,
    returnTo: null,
    issuedVersion: 1,
    ...over,
  };
}

/**
 * A chain entry.
 * @param seq its number
 * @param command the command
 * @param from the holder before
 * @param to the holder after
 * @param at when
 * @return the entry
 */
function step(
  seq: number,
  command: string,
  from: string | null,
  to: string | null,
  at: string,
): ChainEntry {
  return {
    seq,
    command,
    from,
    to,
    actor: {id: `u-${seq}`, name: 'Someone', org: to},
    at,
  };
}

/** Issued to the shipper, endorsed to the bank. */
const ENDORSED: ChainEntry[] = [
  step(1, 'issue', null, 'org-shipper', '2026-11-01T08:00:00.000Z'),
  step(2, 'endorse', 'org-shipper', 'org-bank', '2026-11-02T08:00:00.000Z'),
];

/** Then surrendered for amendment by the bank and amended by the carrier. */
const AMENDED: ChainEntry[] = [
  ...ENDORSED,
  step(
    3,
    'surrender-for-amendment',
    'org-bank',
    'org-carrier',
    '2026-11-03T08:00:00.000Z',
  ),
  step(4, 'amend', 'org-carrier', 'org-bank', '2026-11-04T08:00:00.000Z'),
];

describe('what the page offers', () => {
  it('the holder: "Ask for a change", from the title read', () => {
    assert.equal(mayAskForChange(['endorse', 'surrender-for-amendment']), true);
    assert.equal(mayAskForChange(['endorse', 'surrender']), false);
    assert.equal(mayAskForChange([]), false);
  });

  it('the carrier of a B/L held for a change: "Amend" and "Split"', () => {
    assert.equal(mayAmend(['amend', 'split']), true);
    assert.equal(maySplit(['amend', 'split']), true);
    assert.equal(mayAmend(['split']), false);
    assert.equal(maySplit(['amend']), false);
    assert.equal(mayAmend(['surrender-for-amendment']), false);
  });

  it("the request: its button, confirmation and toast in the design's words", () => {
    assert.deepEqual(ASK_FOR_CHANGE, {
      label: 'Ask for a change',
      body: 'The carrier will hold the B/L to change it and give it back to you. You cannot endorse or surrender it until then.',
      confirmLabel: 'Send to the carrier',
      done: 'B/L sent to the carrier for a change',
    });
  });

  it('the question names the B/L, or "this B/L"', () => {
    assert.equal(
      askForChangeQuestion('BL 1234'),
      'Ask the carrier to change or split BL 1234?',
    );
    assert.equal(
      askForChangeQuestion(''),
      'Ask the carrier to change or split this B/L?',
    );
  });
});

describe('while the carrier holds the B/L for a change', () => {
  const held = title({
    state: 'amendment-requested',
    holder: 'org-carrier',
    returnTo: 'org-bank',
  });

  it('the carrier is told who asked, and that it goes back to them', () => {
    assert.equal(
      changeRequestNote(held, CARRIER, NAMES),
      'Volta Bank asked for a change. The B/L goes back to them.',
    );
  });

  it('the one who asked is told it comes back to them', () => {
    assert.equal(
      changeRequestNote(held, BANK, NAMES),
      'Change requested: the carrier holds the B/L to change it and give it back to you.',
    );
  });

  it('nothing in another state, before issue, or for anyone else', () => {
    assert.equal(changeRequestNote(title({}), CARRIER, NAMES), '');
    assert.equal(changeRequestNote(null, CARRIER, NAMES), '');
    assert.equal(changeRequestNote(held, SHIPPER, NAMES), '');
  });

  it('the holder reads as the carrier, to go back to the one who asked', () => {
    assert.equal(
      changeHolderLabel(held, SHIPPER, NAMES),
      'Ocean Lines, to go back to Volta Bank',
    );
    assert.equal(
      changeHolderLabel(held, BANK, NAMES),
      'Ocean Lines, to go back to Volta Bank (your organisation)',
    );
  });

  it('no such holder in another state', () => {
    assert.equal(changeHolderLabel(title({}), BANK, NAMES), null);
    assert.equal(changeHolderLabel(null, BANK, NAMES), null);
  });
});

describe('the versions of a B/L', () => {
  it('one version once issued', () => {
    assert.deepEqual(versionHistory(ENDORSED, 1), [
      {version: 1, at: '2026-11-01T08:00:00.000Z'},
    ]);
  });

  it('a new version per amendment, from the version issued', () => {
    assert.deepEqual(versionHistory(AMENDED, 2), [
      {version: 1, at: '2026-11-01T08:00:00.000Z'},
      {version: 2, at: '2026-11-04T08:00:00.000Z'},
    ]);
  });

  it('a B/L issued at its third version counts on from there', () => {
    assert.deepEqual(
      versionHistory(AMENDED, 4).map(v => v.version),
      [3, 4],
    );
  });

  it('a child of a split starts at version 1', () => {
    const child = [
      step(1, 'issue-from-split', null, 'org-bank', '2026-11-05T08:00:00.000Z'),
    ];
    assert.deepEqual(versionHistory(child, 1), [
      {version: 1, at: '2026-11-05T08:00:00.000Z'},
    ]);
  });

  it('none before issue', () => {
    assert.deepEqual(versionHistory([], 1), []);
  });

  it('shown to the carrier, the holder and the one it goes back to, not to earlier holders', () => {
    assert.equal(seesVersions(['carrier'], title({}), CARRIER), true);
    assert.equal(seesVersions(['holder'], title({}), BANK), true);
    const held = title({
      state: 'amendment-requested',
      holder: 'org-carrier',
      returnTo: 'org-bank',
    });
    assert.equal(seesVersions(['past-holder'], held, BANK), true);
    assert.equal(seesVersions(['past-holder'], title({}), SHIPPER), false);
    assert.equal(seesVersions(['consignee'], title({}), SHIPPER), false);
    assert.equal(seesVersions(['carrier'], null, CARRIER), false);
  });
});

describe('what an earlier holder is told', () => {
  it('amended after they held it, with the date of the latest amendment', () => {
    assert.deepEqual(pastHolderNote(AMENDED, ['past-holder'], SHIPPER, []), {
      message: 'Amended after you held it',
      at: '2026-11-04T08:00:00.000Z',
    });
  });

  it('split after they held it, naming the new B/Ls', () => {
    const split = [
      ...ENDORSED,
      step(
        3,
        'surrender-for-amendment',
        'org-bank',
        'org-carrier',
        '2026-11-03T08:00:00.000Z',
      ),
      step(4, 'split', 'org-carrier', null, '2026-11-05T08:00:00.000Z'),
    ];
    const children = [
      {recordId: 'r-a', recordNo: 'BL1-A'},
      {recordId: 'r-b', recordNo: 'BL1-B'},
    ];
    assert.deepEqual(
      pastHolderNote(split, ['past-holder'], SHIPPER, children),
      {
        message: 'Split into BL1-A, BL1-B after you held it',
        at: '2026-11-05T08:00:00.000Z',
      },
    );
  });

  it('nothing when it changed while they still held it', () => {
    const later = [
      ...AMENDED,
      step(5, 'endorse', 'org-bank', 'org-shipper', '2026-11-06T08:00:00.000Z'),
    ];
    assert.equal(pastHolderNote(later, ['past-holder'], BANK, []), null);
  });

  it('nothing to the holder, the carrier, or when nothing changed', () => {
    assert.equal(pastHolderNote(AMENDED, ['holder'], BANK, []), null);
    assert.equal(pastHolderNote(AMENDED, ['carrier'], CARRIER, []), null);
    assert.equal(pastHolderNote(ENDORSED, ['past-holder'], SHIPPER, []), null);
  });

  it('never the new values: only a message and a date', () => {
    const note = pastHolderNote(AMENDED, ['past-holder'], SHIPPER, []);
    assert.deepEqual(Object.keys(note ?? {}).sort(), ['at', 'message']);
  });
});

describe('the refusals, in plain words', () => {
  it('404: the B/L is not found', () => {
    assert.deepEqual(refusalOf({status: 404, message: 'B/L not found'}), {
      message:
        'B/L not found. It does not exist, or your organisation is not party to it.',
      problems: [],
      reload: true,
    });
  });

  it('changed meanwhile: says so, and the page reads it again', () => {
    const refusal = refusalOf({
      status: 409,
      message: 'This B/L changed meanwhile: read it again',
      details: {code: 'changed-meanwhile'},
    });
    assert.equal(
      refusal.message,
      'This B/L changed meanwhile. The page now shows it as it is.',
    );
    assert.equal(refusal.reload, true);
  });

  it('the state, the holder or the carrier moved on: the reason, and the page reads it again', () => {
    for (const code of ['wrong-state', 'closed', 'not-holder', 'not-carrier']) {
      const refusal = refusalOf({
        status: code.startsWith('not-') ? 403 : 409,
        message: 'Only the current holder may surrender for amendment this B/L',
        details: {code},
      });
      assert.equal(
        refusal.message,
        'Only the current holder may surrender for amendment this B/L',
        code,
      );
      assert.equal(refusal.reload, true, code);
    }
  });

  it('a draft open, a module off, a reference taken: the reason as given, nothing to reload', () => {
    for (const code of [
      'draft-open',
      'module-off',
      'reference-taken',
      'child-reference',
      'too-few-children',
      'missing-document',
      'different-reference',
      'kind-changed',
    ]) {
      const refusal = refusalOf({
        status: 409,
        message: `Refused: ${code}`,
        details: {code},
      });
      assert.deepEqual(
        refusal,
        {message: `Refused: ${code}`, problems: [], reload: false},
        code,
      );
    }
  });

  it('the cargo does not add up: every problem listed', () => {
    const refusal = refusalOf({
      status: 400,
      message:
        "The cargo of the new B/Ls must add up to the B/L's: one (and 1 more)",
      details: {
        code: 'cargo-mismatch',
        problems: [
          'NARU3472484: the parts hold 380 packages; the B/L holds 400',
          'two',
        ],
      },
    });
    assert.deepEqual(refusal.problems, [
      'NARU3472484: the parts hold 380 packages; the B/L holds 400',
      'two',
    ]);
    assert.equal(refusal.reload, false);
  });

  it('document problems: each with its place in the document', () => {
    const refusal = refusalOf({
      status: 400,
      message: 'The B/L is not valid',
      details: {
        problems: [
          {path: '/transports/portOfDischarge', message: 'is required'},
          {message: 'no place'},
          'as text',
        ],
      },
    });
    assert.deepEqual(refusal.problems, [
      '/transports/portOfDischarge: is required',
      'no place',
      'as text',
    ]);
  });

  it('no details, or details of the wrong shape: no problems', () => {
    assert.deepEqual(
      refusalOf({status: 400, message: 'Bad', details: 'x'}).problems,
      [],
    );
    assert.deepEqual(
      refusalOf({status: 400, message: 'Bad', details: {problems: 'x'}})
        .problems,
      [],
    );
  });
});
