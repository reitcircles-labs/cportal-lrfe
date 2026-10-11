// Unit tests for the Audit screens' wording and rules: `npm run test:audit` (Node's test runner,
// which runs this TypeScript file directly).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ANCHORING, auditColumn, documentStatus, findingNumber, findingState, lockedNote, openIssues,
  proofLabel, rangeLabel, signoffBlock, TIPS, versionState, CHANGED_SINCE_REVIEW
} from './audit-wording.ts';

describe('audit wording', () => {
  it('names the proof statuses in the agreed words, and only On the blockchain and Confirmed can be signed off', () => {
    assert.deepEqual(Object.values(ANCHORING).map(a => a.label), ['Waiting for next batch', 'Sent to the blockchain', 'On the blockchain', 'Confirmed']);
    assert.deepEqual(Object.values(ANCHORING).map(a => a.canSignOff), [false, false, true, true]);
    assert.equal(proofLabel('anchored').label, 'On the blockchain');
    assert.equal(proofLabel('waiting').label, 'Waiting for next batch');
  });

  it('a document is open only for a reason: a mismatch with the blockchain and/or an open finding', () => {
    assert.deepEqual(documentStatus(false, [], 'matches'), { open: false, title: 'No issues', reason: 'matches the blockchain, no open finding' });
    assert.deepEqual(documentStatus(false, ['#A1B2'], 'matches'), { open: true, title: 'Open', reason: 'Auditor finding #A1B2' });
    assert.deepEqual(openIssues(true, ['#A1B2']), ['On-chain data mismatch', 'Auditor finding #A1B2']);
    assert.equal(findingNumber('a1b2c3d4-0000-4000-8000-000000000000'), '#A1B2');
  });

  it('the Audit column: the open range and the known check, or the last sign-off', () => {
    const open = { range: { from: 2, to: 3 }, newDocuments: 15, lastSignoff: { toVersion: 1 } };
    assert.deepEqual(auditColumn({ ...open, check: 'matches' }), { title: 'v2–v3 · 15 new documents', note: 'All match the blockchain ✓', tone: 'success' });
    assert.equal(auditColumn({ ...open, check: 'changed' }).note, 'Changed since review ✕ · re-review needed');
    assert.equal(auditColumn({ ...open, check: 'notOnChain' }).note, 'Not all on the blockchain yet');
    assert.equal(auditColumn({ range: null, newDocuments: 0, check: 'matches', lastSignoff: { toVersion: 6 } }).title, '✓ Audit signed off up to v6');
    assert.equal(rangeLabel({ from: 3, to: 3 }), 'v3');
  });

  it('the sign-off button: the server’s reason first, then the versions still to check', () => {
    assert.equal(signoffBlock({ canSignOff: false, reason: 'Some items go to the blockchain with the next batch.' }, [2]), 'Some items go to the blockchain with the next batch.');
    assert.equal(signoffBlock({ canSignOff: true, reason: null }, [2, 3]), 'Check the changes in every version first: v2, v3 still to check.');
    assert.equal(signoffBlock({ canSignOff: true, reason: null }, []), null);
  });

  it('a version is checked only once it is on the blockchain and matches', () => {
    assert.equal(versionState({ match: 'notOnChain', checked: false }).label, 'Waiting for the blockchain');
    assert.equal(versionState({ match: 'changed', checked: false }).label, 'Changed since review ✕');
    assert.equal(versionState({ match: 'matches', checked: true }).label, '✓ Checked');
    assert.equal(versionState({ match: 'matches', checked: false, signedOffAt: '3 Feb 2026' }).label, 'Signed off 3 Feb 2026');
    assert.equal(lockedNote('changed'), CHANGED_SINCE_REVIEW);
    assert.match(lockedNote('notOnChain'), /only what is on the blockchain can be trusted/);
  });

  it('a finding ends resolved by a corrected version, by agreement, or as raised by mistake', () => {
    assert.equal(findingState({ status: 'open', outcome: null }), 'open');
    assert.equal(findingState({ status: 'resolved', outcome: null, resolvedByVersion: 4 }), 'resolved by a corrected version (v4)');
    assert.equal(findingState({ status: 'closed', outcome: 'agreed' }), 'resolved by agreement');
    assert.equal(findingState({ status: 'closed', outcome: 'mistake' }), 'closed, raised by mistake');
  });

  it('never names the network or a tool', () => {
    const all = JSON.stringify({ ANCHORING, TIPS, CHANGED_SINCE_REVIEW });
    for (const word of ['Cardano', 'Blockfrost', 'Ogmios', 'OpenBao', 'in your browser']) {
      assert.ok(!all.includes(word), word);
    }
  });
});
