// Unit tests for the words of a check against the blockchain (API-675): `npm run test:audit`.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { VERIFY_TIPS, checkLines, verifySummary, type VerifyResult } from './verify-wording.ts';

const result = (patch: Partial<VerifyResult>): VerifyResult => ({
  valid: false, status: 'confirmed', explorerUrl: null, proof: { anchor: { tx: 'ab'.repeat(32) } },
  checks: { item: { ok: true }, path: { ok: true }, chain: { ok: true } },
  ...patch
});

describe('verify wording', () => {
  it('a valid result: every check matches', () => {
    const r = result({ valid: true });
    assert.deepEqual(verifySummary(r), { text: 'Matches the blockchain ✓', tone: 'success' });
    assert.deepEqual(checkLines(r).map(l => [l.label, l.outcome, l.text]), [
      ['Fingerprint recomputed from the file and its metadata', 'passed', 'Matches'],
      ['Fingerprint is in the batch', 'passed', 'Matches'],
      ['Batch is in the blockchain transaction', 'passed', 'Matches']
    ]);
  });

  it('waiting: only the fingerprint is checked, and the summary says when the rest can be', () => {
    // the service checks the path in the portal's tree while waiting: not shown, as it is in no batch yet
    const r = result({ status: 'waiting', checks: { item: { ok: true }, path: { ok: true }, chain: null }, proof: { anchor: null } });
    assert.match(verifySummary(r).text, /^Waiting for next batch/);
    assert.deepEqual(checkLines(r).map(l => l.label), ['Fingerprint recomputed from the file and its metadata']);
  });

  it('a failed check says why in plain words, never the service’s own text', () => {
    const r = result({ checks: { item: { ok: false, problem: 'the version\'s data no longer matches its seal' }, path: { ok: true }, chain: { ok: false, problem: 'the transaction is not on the chain' } } });
    assert.deepEqual(verifySummary(r), { text: 'Doesn’t match the blockchain ✕', tone: 'danger' });
    assert.deepEqual(checkLines(r).filter(l => l.outcome === 'failed').map(l => l.text), ['The file or its metadata changed after it was sealed.', 'The transaction is not on the blockchain.']);
  });

  it('a check that could not be made asks to try again, and hides the internal reason', () => {
    const r = result({ checks: { item: { ok: true }, path: { ok: true }, chain: { ok: null, problem: 'the chain cannot be reached now: Blockfrost is unreachable: timeout' } } });
    assert.equal(verifySummary(r).tone, 'warn');
    const line = checkLines(r)[2];
    assert.deepEqual([line.outcome, line.text], ['unknown', 'It couldn’t be checked now. Try again in a minute.']);
    assert.ok(!JSON.stringify(checkLines(r)).includes('Blockfrost'));
  });

  it('a batch just sent is not a mismatch: try again in a few minutes', () => {
    const r = result({ status: 'anchored', proof: { anchor: { tx: 'ab'.repeat(32), status: 'submitted' } }, checks: { item: { ok: true }, path: { ok: true }, chain: { ok: false, problem: 'the transaction is not on chain yet' } } });
    assert.equal(verifySummary(r).tone, 'warn');
    assert.deepEqual([checkLines(r)[2].outcome, checkLines(r)[2].text], ['unknown', 'The batch was just sent and is not in a block on the blockchain yet. Try again in a few minutes.']);
  });

  it('a version changed while it waits is a mismatch, not a calm wait', () => {
    const r = result({ status: 'waiting', proof: { anchor: null }, checks: { item: { ok: false, problem: 'the version\'s data no longer matches its seal' }, path: { ok: true }, chain: null } });
    assert.deepEqual(verifySummary(r), { text: 'Doesn’t match its seal ✕', tone: 'danger' });
  });

  it('never names the network or a tool', () => {
    const all = JSON.stringify({ VERIFY_TIPS });
    for (const word of ['Cardano', 'Blockfrost', 'Ogmios', 'OpenBao', 'Koios']) {
      assert.ok(!all.includes(word), word);
    }
  });
});
