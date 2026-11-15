/**
 * The readiness check's verdict on the anchoring wallet's funds (CB-49): a new wallet (the
 * shipping demo's, in its own key store) says plainly that it is not funded and that anchoring
 * waits until it is; a low one says how much is needed, as before.
 * Run with: node --test demo/anchoring-funds.test.mjs
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {fundsVerdict, readinessOutcome} from './anchoring-funds.mjs';

const WALLET = {address: 'addr_test1example', network: 'preview', minimum: 5};

test('a wallet with nothing on it: not funded, anchoring waits, where to send test ADA', () => {
  const verdict = fundsVerdict({...WALLET, ada: 0});
  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.item, 'funds');
  assert.match(
    verdict.detail,
    /^wallet not funded: anchoring waits until it is/,
  );
  assert.match(verdict.fix, /Send test ADA \(preview\) to addr_test1example/);
});

test('a wallet below the minimum: as before', () => {
  const verdict = fundsVerdict({...WALLET, ada: 1.5});
  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.detail, '1.5 ADA, at least 5 needed');
});

test('a funded wallet: ok, with the cost of a batch', () => {
  const verdict = fundsVerdict({...WALLET, ada: 12.25});
  assert.equal(verdict.status, 'ok');
  assert.equal(
    verdict.detail,
    '12.25 ADA (at least 5 needed; each batch costs about 0.2 ADA)',
  );
});

// CB-49 round 3: an install whose only failing line is the funds waits for them (install and deploy)
test('a readiness whose only failures are the funds: waiting for funds, not "not ready"', () => {
  assert.deepEqual(readinessOutcome({ready: false, failItems: ['funds']}), {
    ok: true,
    waitsForFunds: true,
  });
  assert.deepEqual(readinessOutcome({ready: true, failItems: []}), {
    ok: true,
    waitsForFunds: false,
  });
  assert.deepEqual(
    readinessOutcome({ready: false, failItems: ['funds', 'blockchain node']}),
    {ok: false, waitsForFunds: false},
  );
  assert.deepEqual(readinessOutcome({ready: false, failItems: []}), {
    ok: false,
    waitsForFunds: false,
  });
});
