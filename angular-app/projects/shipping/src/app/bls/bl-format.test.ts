// Unit tests for how the shipping app shows a B/L in its list and on its page (CB-42):
// `npm run test:shipping` (Node's test runner, which runs this TypeScript file directly).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  carrierOf,
  chainRows,
  kindLabel,
  partyLabel,
  rolesLabel,
  stateLabel,
  stateTone,
  toneTagClass,
} from './bl-format.ts';
import type {BlState, ChainEntry, Viewer} from './bl.model.ts';

const ME: Viewer = {organisationId: 'org-bank', organisation: 'Volta Bank'};

/**
 * A B/L's state as the list and the title read give it.
 * @param over the fields that differ from a committed B/L not issued yet
 * @return the state
 */
function bl(over: Partial<BlState>): BlState {
  return {status: 'committed', draftState: null, title: null, ...over};
}

/**
 * A chain-of-title entry with the fields the page reads.
 * @param over the fields of the entry
 * @return the entry
 */
function entry(over: Partial<ChainEntry>): ChainEntry {
  return {
    seq: 1,
    command: 'issue',
    from: null,
    to: null,
    actor: {id: 'u-1', name: 'Lena Okafor', org: 'org-carrier'},
    at: '2026-11-14T08:00:00.000Z',
    ...over,
  };
}

describe('rolesLabel', () => {
  it('names each role of the organisation, the first capitalised', () => {
    assert.equal(rolesLabel(['carrier']), 'Carrier');
    assert.equal(rolesLabel(['holder']), 'Holder');
    assert.equal(rolesLabel(['past-holder']), 'Past holder');
    assert.equal(rolesLabel(['consignee']), 'Consignee');
    assert.equal(rolesLabel(['carrier', 'holder']), 'Carrier, holder');
  });

  it('is empty for no role', () => {
    assert.equal(rolesLabel([]), '');
  });
});

describe('kindLabel', () => {
  it('names the three kinds', () => {
    assert.equal(kindLabel('negotiable'), 'Negotiable B/L');
    assert.equal(kindLabel('straight'), 'Straight B/L');
    assert.equal(kindLabel('waybill'), 'Sea waybill');
  });

  it('says a B/L without a title is not issued yet', () => {
    assert.equal(kindLabel(null), 'Not issued yet');
    assert.equal(kindLabel(undefined), 'Not issued yet');
  });

  it('shows a kind it does not know as it is', () => {
    assert.equal(kindLabel('multimodal'), 'multimodal');
  });
});

describe('stateLabel and stateTone', () => {
  it('before issue: draft, in review, ready to issue', () => {
    const draft = bl({status: 'draft', draftState: 'draft'});
    const review = bl({status: 'draft', draftState: 'in_review'});
    const ready = bl({});
    assert.equal(stateLabel(draft), 'Draft');
    assert.equal(stateLabel(review), 'In review');
    assert.equal(stateLabel(ready), 'Ready to issue');
    assert.equal(stateTone(draft), 'draft');
    assert.equal(stateTone(review), 'review');
    assert.equal(stateTone(ready), 'review');
  });

  it('a committed B/L with a new version in review is in review', () => {
    assert.equal(stateLabel(bl({draftState: 'in_review'})), 'In review');
  });

  it('after issue: the title state, live or ended', () => {
    const cases: Array<[string, string, string]> = [
      ['issued', 'Issued', 'live'],
      ['with-holder', 'With holder', 'live'],
      ['surrendered', 'Surrendered', 'live'],
      ['amendment-requested', 'Amendment requested', 'live'],
      ['accomplished', 'Accomplished', 'ended'],
      ['delivered', 'Delivered', 'ended'],
      ['void', 'Void', 'ended'],
      ['split', 'Split', 'ended'],
      ['switched-to-paper', 'Switched to paper', 'ended'],
    ];
    for (const [state, label, tone] of cases) {
      const issued = bl({title: {kind: 'negotiable', state}});
      assert.equal(stateLabel(issued), label, state);
      assert.equal(stateTone(issued), tone, state);
    }
  });

  it('the title wins over an open draft once issued', () => {
    const issued = bl({
      draftState: 'draft',
      title: {kind: 'negotiable', state: 'with-holder'},
    });
    assert.equal(stateLabel(issued), 'With holder');
  });

  it('shows a state it does not know as it is', () => {
    const odd = bl({title: {kind: 'negotiable', state: 'in-transit'}});
    assert.equal(stateLabel(odd), 'in-transit');
    assert.equal(stateTone(odd), 'live');
  });
});

describe('toneTagClass', () => {
  it('gives each tone its tag colour (added: the list and the page share it)', () => {
    assert.equal(toneTagClass('live'), 'tag-accent');
    assert.equal(toneTagClass('review'), 'tag-info');
    assert.equal(toneTagClass('draft'), 'tag-outline');
    assert.equal(toneTagClass('ended'), 'tag-neutral');
  });
});

describe('partyLabel', () => {
  it("names the viewer's own organisation, marked as theirs", () => {
    assert.equal(partyLabel('org-bank', ME), 'Volta Bank (your organisation)');
  });

  it('shows another organisation by its id', () => {
    assert.equal(partyLabel('org-carrier', ME), 'org-carrier');
  });

  it('shows another organisation by its name when the service gives it (added: names)', () => {
    const names = {'org-carrier': 'Ocean Carrier Line'};
    assert.equal(partyLabel('org-carrier', ME, names), 'Ocean Carrier Line');
    assert.equal(partyLabel('org-other', ME, names), 'org-other');
  });

  it("the viewer's own organisation keeps its mark, named by the service when the session has no name (added: names)", () => {
    const unnamed: Viewer = {organisationId: 'org-bank', organisation: ''};
    assert.equal(
      partyLabel('org-bank', unnamed, {'org-bank': 'Volta Bank'}),
      'Volta Bank (your organisation)',
    );
  });

  it('a dash for nobody', () => {
    assert.equal(partyLabel(null, ME), '—');
    assert.equal(partyLabel(undefined, ME), '—');
  });

  it('a viewer whose organisation has no name yet is still told it is theirs', () => {
    const unnamed: Viewer = {organisationId: 'org-bank', organisation: ''};
    assert.equal(partyLabel('org-bank', unnamed), 'Your organisation');
  });

  it('a viewer without an organisation never matches a missing party', () => {
    const none: Viewer = {organisationId: null, organisation: ''};
    assert.equal(partyLabel(null, none), '—');
  });
});

describe('chainRows', () => {
  it('one row per entry, oldest first: the step, from and to, who ran it and when', () => {
    const rows = chainRows(
      [
        entry({
          seq: 2,
          command: 'endorse',
          from: 'org-shipper',
          to: 'org-bank',
        }),
        entry({seq: 1, command: 'issue', to: 'org-shipper'}),
      ],
      ME,
    );
    assert.deepEqual(rows, [
      {
        seq: 1,
        step: 'Issued',
        from: '—',
        to: 'org-shipper',
        by: 'Lena Okafor',
        at: '2026-11-14T08:00:00.000Z',
      },
      {
        seq: 2,
        step: 'Endorsed',
        from: 'org-shipper',
        to: 'Volta Bank (your organisation)',
        by: 'Lena Okafor',
        at: '2026-11-14T08:00:00.000Z',
      },
    ]);
  });

  it('names the organisations of each step by name (added: names)', () => {
    const [row] = chainRows(
      [entry({command: 'endorse', from: 'org-shipper', to: 'org-bank'})],
      ME,
      {'org-shipper': 'Coffee Exporters', 'org-bank': 'Volta Bank'},
    );
    assert.equal(row.from, 'Coffee Exporters');
    assert.equal(row.to, 'Volta Bank (your organisation)');
  });

  it('names every command of the title engine', () => {
    const steps: Array<[string, string]> = [
      ['issue', 'Issued'],
      ['issue-from-split', 'Issued from a split'],
      ['endorse', 'Endorsed'],
      ['transfer', 'Transferred'],
      ['surrender', 'Surrendered'],
      ['release', 'Released'],
      ['deliver', 'Delivered'],
      ['void', 'Voided'],
      ['surrender-for-amendment', 'Surrendered for amendment'],
      ['amend', 'Amended'],
      ['split', 'Split'],
      ['switch-to-paper', 'Switched to paper'],
    ];
    for (const [command, step] of steps) {
      assert.equal(chainRows([entry({command})], ME)[0].step, step, command);
    }
  });

  it('shows a command it does not know as it is, and a missing name as a dash', () => {
    const [row] = chainRows(
      [entry({command: 'pledge', actor: {id: 'u-9', org: 'org-x'}})],
      ME,
    );
    assert.equal(row.step, 'pledge');
    assert.equal(row.by, '—');
  });

  it('an empty chain gives no rows', () => {
    assert.deepEqual(chainRows([], ME), []);
  });
});

describe('carrierOf (added: review, a draft showed no carrier)', () => {
  it('after issue: the title names the carrier', () => {
    assert.equal(
      carrierOf({title: {carrier: 'org-carrier'}, roles: ['holder']}, ME),
      'org-carrier',
    );
  });

  it("before issue: the record's owner, who alone sees it, is the carrier: the viewer's organisation", () => {
    assert.equal(carrierOf({title: null, roles: ['carrier']}, ME), 'org-bank');
  });

  it('before issue without the carrier role (never answered by the service): nobody', () => {
    assert.equal(carrierOf({title: null, roles: []}, ME), null);
  });
});
