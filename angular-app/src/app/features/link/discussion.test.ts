// Unit tests for the land record's Discussion (comments and review decisions in one timeline):
// `npm run test:link` (Node's test runner, which runs this TypeScript file directly).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { discussionEvents, groupByVersion, isDecision } from './discussion.ts';
import type { DiscussionComment, DiscussionVersion } from './discussion.ts';

const V1: DiscussionVersion = {
  versionNumber: 1,
  changes: [
    { at: '2026-10-17T11:00:00.000Z', byName: 'Johannes', action: 'create' },
    { at: '2026-10-17T11:10:00.000Z', byName: 'Johannes', action: 'edit' },
    { at: '2026-10-17T11:48:00.000Z', byName: 'Johannes', action: 'submit' },
    { at: '2026-10-17T12:05:00.000Z', byName: 'Elina', action: 'reject', via: 'bpm', comment: 'Tenure should be freehold.' },
    { at: '2026-10-17T12:21:00.000Z', byName: 'Johannes', action: 'submit' },
    { at: '2026-10-17T12:32:00.000Z', byName: 'Elina', action: 'commit', via: 'bpm', comment: ' Checked. ' },
  ],
};
const V2: DiscussionVersion = {
  versionNumber: 2,
  changes: [
    { at: '2026-10-18T08:00:00.000Z', byName: 'Johannes', action: 'open', from: 1 },
    { at: '2026-10-18T08:30:00.000Z', byName: 'Johannes', action: 'submit' },
    { at: '2026-10-18T08:40:00.000Z', byName: 'Johannes', action: 'withdraw' },
  ],
};
const REPLY: DiscussionComment = {
  id: 'a', body: 'Corrected the tenure.', authorName: 'Johannes', createdAt: '2026-10-17T12:20:00.000Z', versionNumber: 1,
};

describe('discussionEvents', () => {
  it('keeps the decisions and leaves out edits, creating and opening', () => {
    const kinds = discussionEvents([V1, V2], []).map(e => e.kind);
    assert.deepEqual(kinds, ['submitted', 'returned', 'submitted', 'approved', 'submitted', 'withdrawn']);
  });

  it('says when a version was submitted again', () => {
    const what = discussionEvents([V1], []).filter(e => e.kind === 'submitted').map(e => e.what);
    assert.deepEqual(what, ['submitted version 1 for review', 'submitted version 1 again']);
  });

  it('puts the comments between the decisions, by time, and keeps the reasons', () => {
    const events = discussionEvents([V1], [REPLY]);
    assert.deepEqual(events.map(e => e.text), [null, 'Tenure should be freehold.', 'Corrected the tenure.', null, 'Checked.']);
    assert.equal(events[2].kind, 'comment');
    assert.equal(isDecision(events[2]), false);
    assert.equal(isDecision(events[1]), true);
  });

  it('names someone for an entry without a name', () => {
    const events = discussionEvents([{ versionNumber: 3, changes: [{ at: '2026-10-19T08:00:00.000Z', byName: null, action: 'submit' }] }], []);
    assert.equal(events[0].byName, 'Someone');
  });

  it('gives every event its own key', () => {
    const keys = discussionEvents([V1, V2], [REPLY]).map(e => e.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('groupByVersion', () => {
  it('shows the newest version first, each oldest first, and comments without a version last', () => {
    const early: DiscussionComment = { id: 'b', body: 'Hello', authorName: 'Elina', createdAt: '2026-10-16T08:00:00.000Z', versionNumber: null };
    const groups = groupByVersion(discussionEvents([V1, V2], [REPLY, early]));
    assert.deepEqual(groups.map(g => g.versionNumber), [2, 1, null]);
    assert.deepEqual(groups[1].events.map(e => e.at), [...groups[1].events.map(e => e.at)].sort());
  });

  it('is empty without events', () => {
    assert.deepEqual(groupByVersion([]), []);
  });
});
