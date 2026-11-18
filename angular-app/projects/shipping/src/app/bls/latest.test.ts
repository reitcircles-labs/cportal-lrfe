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
    let releaseOlder: () => void = () => undefined;
    const olderGate = new Promise<void>(resolve => {
      releaseOlder = resolve;
    });

    /**
     * Loads behind a gate, showing the answer only while it is current.
     * @param answer what the request answers
     * @param wait optional promise that delays completion
     * @return when it is done
     */
    async function load(answer: string, wait?: Promise<void>): Promise<void> {
      const request = latest.begin();
      if (wait) {
        await wait;
      }
      if (latest.isCurrent(request)) {
        shown.push(answer);
      }
    }

    const older = load('older', olderGate);
    await load('newer');
    releaseOlder();
    await older;
    assert.deepEqual(shown, ['newer']);
  });
});
