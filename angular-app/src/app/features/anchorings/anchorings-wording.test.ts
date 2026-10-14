// Unit tests for the Anchorings screens' wording and rules: `npm run test:audit` (Node's test
// runner, which runs this TypeScript file directly).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BATCH_STATUS, FAIL_REASON, HOW_ANCHORING_WORKS, ITEM_STATUS, JOURNEY, MESSAGES, TIPS, aboutTime, answerStatus, answerText,
  batchSteps, batchSummary, coversText, depthText, documentVersionText, gapNote, historyLine, madeOf, notFoundText, rangeText,
  inSentence, shortHash, usedInText, when
} from './anchorings-wording.ts';

/** Local times on the day the tests take as today. */
const NOW = new Date(2026, 9, 12, 14, 40);
const at = (h: number, m: number, day = 12) => new Date(2026, 9, day, h, m).toISOString();

/** A batch in detail, confirmed unless changed. */
function detail(patch: Record<string, unknown> = {}) {
  return {
    batch: 1412, createdAt: at(13, 10), status: 'confirmed', covers: 52, txHash: 'ab'.repeat(32), explorerUrl: null, block: 3184220,
    confirmations: 10, reason: null, replacedBy: null, replaces: null, root: 'cd'.repeat(32), size: 1482951,
    prev: { root: 'ef'.repeat(32), batch: 1411 },
    steps: { createdAt: at(13, 10), sentAt: at(13, 10), sends: 1, onChainAt: at(13, 11), confirmedAt: at(13, 16), failedAt: null },
    replacement: null, previousBatch: 1411, nextBatch: 1413, confirmationsNeeded: 10,
    ...patch
  } as never;
}

describe('anchorings wording', () => {
  it('names the statuses in the agreed words', () => {
    assert.deepEqual(Object.values(BATCH_STATUS).map(s => s.label), ['Sent to the blockchain', 'On the blockchain', 'Confirmed', 'Failed']);
    assert.equal(ITEM_STATUS.waiting.label, 'Waiting for next batch');
    assert.deepEqual(JOURNEY.map(j => j.status), ['sent', 'onChain', 'confirmed', 'failed']);
    assert.equal(FAIL_REASON.rolledBackExpired.shown, 'Dropped from the blockchain and expired before it got back in');
    assert.match(TIPS.status, /^Sent to the blockchain: On its way/);
  });

  it('dates, depth and the covers column', () => {
    assert.equal(when(at(13, 10), NOW), 'Today 13:10');
    assert.equal(when(at(9, 40, 10), NOW), '10 Oct 2026, 09:40');
    assert.equal(aboutTime(at(15, 10), NOW), 'about 15:10');
    assert.equal(depthText(4, 10), '4 of 10 confirmations');
    assert.equal(depthText(12, 10), '10+ confirmations');
    assert.equal(depthText(null, 10), '');
    assert.equal(coversText(52), '52 fingerprints');
    assert.equal(coversText(1), '1 fingerprint');
    assert.equal(coversText(null), '—');
    assert.equal(shortHash('9f3a6b0e2c7d41f5c21e'), '9f3a…c21e');
  });

  it('a land record version is shown with everything its fingerprint stands for (option B)', () => {
    assert.deepEqual(madeOf({ versionNumber: 3, documents: 4, documentsEarlier: 3, versionsBefore: 2 }), { text: '4 documents · v1–v2 before it', note: '3 documents already on the blockchain' });
    assert.deepEqual(madeOf({ versionNumber: 5, documents: 6, documentsEarlier: 6, versionsBefore: 4 }), { text: '6 documents · v1–v4 before it', note: 'All 6 already on the blockchain' });
    assert.deepEqual(madeOf({ versionNumber: 1, documents: 11, documentsEarlier: 0, versionsBefore: 0 }), { text: '11 documents', note: 'All 11 new in this batch' });
    assert.deepEqual(madeOf({ versionNumber: 2, documents: 0, documentsEarlier: 0, versionsBefore: 1 }), { text: 'v1 before it', note: '' });
    assert.equal(documentVersionText(1), 'v1');
    assert.equal(documentVersionText(2), 'v2 (corrected)');
    assert.equal(usedInText([]), 'Not in a land record version in this batch');
    assert.equal(usedInText([{ recordNo: 'LR-1', label: 'Erf 1873, Klein Windhoek', versionNumber: 3 }]), 'Erf 1873, Klein Windhoek · v3');
  });

  it('the note on gaps names the failed batches', () => {
    assert.equal(gapNote([1408], 1), 'batch 1,408 failed, so its number never appears there. It was replaced by the next batch, which points back to the last batch that did get there, so the chain has no break.');
    assert.match(gapNote([1408, 902, 77], 3), /^batches 1,408, 902 and 77 failed, so their numbers never appear there\. Each was replaced/);
    assert.match(gapNote([1408, 902, 77], 5), /^batches 1,408, 902, 77 and 2 others failed/);
  });

  it('the range under the list', () => {
    assert.equal(rangeText('all', 1, 25, 1413), 'Newest 1–25 of 1,413 anchorings');
    assert.equal(rangeText('failed', 1, 25, 3), '3 anchorings match');
    assert.equal(rangeText('progress', 1, 25, 1), '1 anchoring matches');
    assert.equal(rangeText('all', 1, 25, 0), 'No anchorings');
  });

  it('a search answers in plain words', () => {
    const record = (answer: object, history: object[]) => ({
      query: 'Erf 412', kind: 'record', record: { id: 'r', recordNo: 'LR-2', label: 'Erf 412, Olympia', currentVersion: 5, committedAt: at(14, 31) }, answer, history
    }) as never;
    const yes = record({ status: 'yes', version: 3, batch: 1412 }, [{ kind: 'version', versionNumber: 3, at: at(12, 47), status: 'confirmed', batch: 1412 }]);
    assert.deepEqual(answerText(yes, NOW), { text: 'Yes. Everything up to v3 is on the blockchain.', good: true });
    assert.equal(answerStatus(yes).label, 'Confirmed');

    const waiting = record({ status: 'waiting', version: 5, nextDueAt: at(15, 10) }, [
      { kind: 'version', versionNumber: 5, at: at(14, 31), status: 'waiting', batch: null },
      { kind: 'version', versionNumber: 4, at: at(9, 15, 6), status: 'confirmed', batch: 1330 }
    ]);
    assert.equal(answerText(waiting, NOW).text, 'Not yet. v5 goes out with the next batch, about 15:10. Everything before it is on the blockchain.');
    assert.equal(answerStatus(waiting).label, 'Waiting for next batch');
    const first = record({ status: 'waiting', version: 1, nextDueAt: null }, [{ kind: 'version', versionNumber: 1, at: at(14, 31), status: 'waiting', batch: null }]);
    assert.equal(answerText(first, NOW).text, 'Not yet. v1 goes out with the next batch.');

    const doc = { query: 'EDR-1', kind: 'document', document: { id: 'd', edrmsNo: 'EDR-1', docType: 'deed_of_transfer', ref: 'T 2210/2008', currentVersion: 1 },
      answer: { status: 'yes', version: 1, batch: 1409 }, history: [] } as never;
    assert.equal(answerText(doc, NOW).text, 'Yes. This document is on the blockchain.');
    assert.equal(notFoundText('XYZ'), 'Nothing found for “XYZ”. Check the number, or search by Erf and township, for example Erf 1873.');
  });

  it('the history lines of a search result', () => {
    const type = (id: string | null | undefined) => (id === 'deed_of_transfer' ? 'Deed of transfer' : '');
    assert.deepEqual(historyLine({ kind: 'version', versionNumber: 3, at: at(12, 47, 10), status: 'confirmed', batch: 1412 }, type, NOW), { what: 'Version v3 committed', when: '10 Oct 2026, 12:47' });
    assert.deepEqual(historyLine({ kind: 'document', documentId: 'd', version: 1, edrmsNo: 'EDR-NA-2026-000412', docType: 'deed_of_transfer', ref: 'T 2210/2008', at: at(9, 40), status: 'confirmed', batch: 1409 }, type, NOW),
      { what: 'Document EDR-NA-2026-000412 · Deed of transfer T 2210/2008, v1', when: 'Filed today at 09:40' });
    assert.equal(historyLine({ kind: 'signoff', from: 1, to: 2, at: null, status: 'confirmed', batch: 1301 }, type, NOW).what, 'Audit signed off, v1–v2');
    assert.equal(historyLine({ kind: 'document', version: 2, at: null, status: 'waiting', batch: null }, type, NOW).what, 'Version 2 corrected');
    assert.equal(historyLine({ kind: 'usedIn', recordNo: 'LR-NA-2026-000001', versionNumber: 3, at: null, status: 'confirmed', batch: 1412 }, type, NOW).what, 'Used in land record LR-NA-2026-000001, v3');
  });

  it('a confirmed batch: its steps and summary', () => {
    const steps = batchSteps(detail(), NOW);
    assert.deepEqual(steps.map(s => [s.title, s.when, s.note, s.state]), [
      ['Created', 'Today 13:10', '52 new fingerprints combined', 'done'],
      ['Sent to the blockchain', 'Today 13:10', 'Sent once', 'done'],
      ['On the blockchain', 'Today 13:11', 'In block 3,184,220', 'done'],
      ['Confirmed', 'Today 13:16', '10 newer blocks on top', 'done']
    ]);
    assert.equal(batchSummary(detail(), NOW), 'Created today at 13:10 · confirmed today at 13:16 · 52 new fingerprints');
    const onChain = batchSteps(detail({ status: 'onChain', confirmations: 4, steps: { createdAt: at(14, 10), sentAt: at(14, 10), sends: 1, onChainAt: at(14, 11), confirmedAt: null, failedAt: null } }), NOW);
    assert.deepEqual(onChain.at(-1), { title: 'Confirmed', when: '', note: '4 of 10 confirmations', state: 'todo' });
  });

  it('a failed batch: what happened, and its replacement', () => {
    const failed = detail({
      batch: 1408, status: 'failed', covers: null, reason: 'expired', prev: { root: 'ef'.repeat(32), batch: 1407 },
      steps: { createdAt: at(9, 1), sentAt: at(9, 1), sends: 12, onChainAt: null, confirmedAt: null, failedAt: at(10, 5) },
      replacement: { batch: 1409, status: 'confirmed', createdAt: at(10, 10) }
    });
    assert.deepEqual(batchSteps(failed, NOW).map(s => [s.title, s.note, s.state]), [
      ['Created', 'From batch 1,407, the last on the blockchain', 'done'],
      ['Sent to the blockchain', 'Sent 12 times', 'done'],
      ['Expired', 'Not taken into a block in time', 'failed'],
      ['Replaced', 'By batch 1,409', 'done']
    ]);
    assert.equal(batchSummary(failed, NOW), 'Created today at 09:01 · given up today at 10:05');
    assert.equal(batchSummary(detail({ status: 'failed', covers: null, steps: { createdAt: at(9, 1), sentAt: null, sends: 0, onChainAt: null, confirmedAt: null, failedAt: null } }), NOW), 'Created today at 09:01');
    assert.equal(inSentence(null, NOW), '');
  });

  it('never names the network or a tool', () => {
    const all = JSON.stringify({ BATCH_STATUS, ITEM_STATUS, FAIL_REASON, TIPS, HOW_ANCHORING_WORKS, JOURNEY, MESSAGES });
    for (const word of ['Cardano', 'cardano', 'preview', 'Blockfrost', 'Ogmios', 'OpenBao', 'in your browser']) {
      assert.ok(!all.includes(word), word);
    }
  });
});
