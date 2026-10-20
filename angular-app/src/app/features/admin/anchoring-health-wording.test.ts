// Unit tests for the words of the Anchoring health panel (API-674): `npm run test:audit`.
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  HEALTH_TIPS,
  liveLine,
  warningLine,
  type HealthFacts,
  type HealthWarning,
} from './anchoring-health-wording.ts';

const facts: HealthFacts = {
  wallet: {funds: {ada: '3.2', minimumAda: 5}},
  lastAnchoring: {createdAt: new Date(2026, 9, 12, 9, 5).toISOString()},
  gaps: {count: 2},
};

describe('anchoring health wording', () => {
  it('each warning in plain words, with how serious it is', () => {
    assert.deepEqual(warningLine('lowFunds', facts), {
      text: 'The anchoring wallet is low on funds: 3.2 left, at least 5 needed. Top it up, or anchoring will stop.',
      tone: 'danger',
    });
    assert.equal(warningLine('catchingUp', facts).tone, 'warn');
    assert.equal(
      warningLine('overdue', facts).text,
      'Anchoring is overdue: fingerprints are waiting, and the last batch was made 12 Oct 2026, 09:05.',
    );
    assert.match(
      warningLine('trailGap', facts).text,
      /^The trail has 2 recorded gaps/,
    );
    assert.match(
      warningLine('trailGap', {...facts, gaps: {count: 1}}).text,
      /^The trail has a recorded gap/,
    );
  });

  it('live warnings with when they arrived', () => {
    assert.equal(
      liveLine({
        kind: 'lowFunds',
        at: new Date(2026, 9, 12, 10, 0).toISOString(),
        missing: null,
      }),
      '12 Oct 2026, 10:00: the anchoring wallet reported low funds.',
    );
    assert.equal(
      liveLine({
        kind: 'trailGap',
        at: new Date(2026, 9, 12, 10, 0).toISOString(),
        missing: 3,
      }),
      '12 Oct 2026, 10:00: a gap was recorded in the trail (3 events lost).',
    );
  });

  it('never names the network or a tool', () => {
    const warnings: HealthWarning[] = [
      'walletUnreadable',
      'lowFunds',
      'unreachable',
      'catchingUp',
      'overdue',
      'trailGap',
    ];
    const all = JSON.stringify({
      HEALTH_TIPS,
      lines: warnings.map(w => warningLine(w, facts)),
    });
    for (const word of [
      'Cardano',
      'preview',
      'Blockfrost',
      'Ogmios',
      'OpenBao',
      'Koios',
      'ADA',
    ]) {
      assert.ok(!all.includes(word), word);
    }
  });
});
