// Unit tests for what `npm run evidence` runs (CB-42 review: shipping specs too):
// `npm run test:stack` in e2e/.
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {evidencePlan} from './evidence-plan.mjs';

describe('evidencePlan', () => {
  it('land, tagged tests of the whole suite', () => {
    const plan = evidencePlan(['API-606', 'API-609']);
    assert.deepEqual(plan.tickets, ['API-606', 'API-609']);
    assert.equal(plan.shipping, false);
    assert.deepEqual(plan.args, [
      'playwright',
      'test',
      '--grep',
      '@API-606|@API-609',
    ]);
    assert.deepEqual(plan.env, {E2E_EVIDENCE: '1'});
  });

  it('land, one spec: with the sign-in setup, without the projects it depends on', () => {
    const plan = evidencePlan(['API-606', '--spec', 'tests/x.spec.ts']);
    assert.deepEqual(plan.tickets, ['API-606']);
    assert.deepEqual(plan.args, [
      'playwright',
      'test',
      'tests/auth.setup.ts',
      'tests/x.spec.ts',
      '--no-deps',
      '--workers=1',
      '--grep',
      '@API-606|enrol',
    ]);
  });

  it('--shipping: the shipping config and stack, tagged tests', () => {
    const plan = evidencePlan(['CB-42', '--shipping']);
    assert.deepEqual(plan.tickets, ['CB-42']);
    assert.equal(plan.shipping, true);
    assert.deepEqual(plan.args, [
      'playwright',
      'test',
      '-c',
      'playwright.shipping.config.ts',
      '--grep',
      '@CB-42',
    ]);
    assert.deepEqual(plan.env, {E2E_EVIDENCE: '1', E2E_DOMAIN: 'shipping'});
  });

  it('a spec in tests-shipping/ runs on the shipping stack without being told, with no sign-in setup', () => {
    const plan = evidencePlan([
      'CB-42',
      '--spec',
      'tests-shipping/bl-home.spec.ts',
    ]);
    assert.equal(plan.shipping, true);
    assert.deepEqual(plan.args, [
      'playwright',
      'test',
      '-c',
      'playwright.shipping.config.ts',
      'tests-shipping/bl-home.spec.ts',
      '--grep',
      '@CB-42',
    ]);
  });

  it('null for wrong arguments: no ticket, a wrong ticket key, --spec without a file', () => {
    assert.equal(evidencePlan([]), null);
    assert.equal(evidencePlan(['--shipping']), null);
    assert.equal(evidencePlan(['cb-42']), null);
    assert.equal(evidencePlan(['CB-42', '--spec']), null);
  });
});
