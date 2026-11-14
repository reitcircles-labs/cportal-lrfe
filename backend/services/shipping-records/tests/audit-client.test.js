import {AppError} from '@lrfe/common';
import {expect} from 'chai';

import {createAuditClient} from '../src/audit-client.js';

/**
 * CB-33: the shipping records service's client of the audit service, which gives the trail-entry
 * proof of a chain entry's event (POST /audit/anchoring/entry-proof).
 */

/**
 * A fetch answering `status` with `body`, keeping each call.
 * @param {number} status
 * @param {*} body
 * @return {function(string, object): !Promise<object>}
 */
function answering(status, body) {
  const fetchImpl = async (url, init) => {
    fetchImpl.calls.push({url, init});
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    });
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

/**
 * The error a call rejects with.
 * @param {!Promise<*>} pending
 * @return {!Promise<!Error>}
 */
async function failure(pending) {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('It did not fail');
}

describe('the audit client (CB-33)', () => {
  const serviceToken = () => 'the-token';

  it('asks the audit service for the proof of an event, as the record service', async () => {
    const proof = {format: 'lrfe-audit-proof/1', status: 'waiting'};
    const fetchImpl = answering(200, proof);
    const audit = createAuditClient({
      baseUrl: 'http://audit:3506',
      serviceToken,
      fetchImpl,
    });
    expect(await audit.entryProof('e-1')).to.deep.equal(proof);
    const [{url, init}] = fetchImpl.calls;
    expect(url).to.equal('http://audit:3506/audit/anchoring/entry-proof');
    expect(init.method).to.equal('POST');
    expect(init.headers.authorization).to.equal('Bearer the-token');
    expect(JSON.parse(init.body)).to.deep.equal({eventId: 'e-1'});
  });

  it('rejects with 404 for an event not on the trail, 502 for an error answer', async () => {
    for (const [status, expected] of [
      [404, 404],
      [500, 502],
      [403, 502],
    ]) {
      const audit = createAuditClient({
        baseUrl: 'http://audit:3506',
        serviceToken,
        fetchImpl: answering(status, {message: 'no'}),
      });
      const error = await failure(audit.entryProof('e-1'));
      expect(error, String(status)).to.be.instanceOf(AppError);
      expect(error.statusCode, String(status)).to.equal(expected);
    }
  });

  it('rejects with 503 when the audit service cannot be reached', async () => {
    const audit = createAuditClient({
      baseUrl: 'http://audit:3506',
      serviceToken,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await failure(audit.entryProof('e-1'));
    expect(error.statusCode).to.equal(503);
  });
});
