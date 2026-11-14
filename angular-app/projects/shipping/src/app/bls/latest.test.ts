// Unit tests for ignoring stale answers on the B/L screens (CB-42 review):
// `npm run test:shipping` (Node's test runner, which runs this TypeScript file directly).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {LatestRequest} from './latest.ts';

describe('LatestRequest', () => {
  it('the request begun last is current; an earlier one no longer is', () => {
    const latest = new LatestRequest();
    const first = latest.begin();
    assert.equal(latest.isCurrent(first), true);
    const second = latest.begin();
    assert.equal(latest.isCurrent(first), false);
    assert.equal(latest.isCurrent(second), true);
  });

  it('a slower older answer arriving after a newer one is ignored', async () => {
    const latest = new LatestRequest();
    const shown: string[] = [];
    /**
     * Loads after a delay, showing the answer only while it is current.
     * @param answer what the request answers
     * @param ms how long it takes
     * @return when it is done
     */
    async function load(answer: string, ms: number): Promise<void> {
      const request = latest.begin();
      await new Promise(resolve => setTimeout(resolve, ms));
      if (latest.isCurrent(request)) {
        shown.push(answer);
      }
    }
    await Promise.all([load('older', 30), load('newer', 5)]);
    assert.deepEqual(shown, ['newer']);
  });
});
