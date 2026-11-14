import {expect} from 'chai';

import {createIdentityClient} from '../src/identity-client.js';

/**
 * CB-34: the shipping records service's client of identity, which says whether an organisation is
 * registered and active before a B/L goes to it (GET /organisations/:id/standing, asked with the
 * record service's token).
 *
 *   standingOf(id) → 'active' | 'inactive' | 'unknown'
 *     200 {status: 'Active'} → 'active'; 200 with another status → 'inactive'; 404 (no such
 *     organisation) or 400 (not an organisation id) → 'unknown'; rejects 503 when identity cannot
 *     be reached, 502 for any other answer.
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

describe('the identity client of shipping records (CB-34)', () => {
  const serviceToken = () => 'the-token';
  const ORG = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

  it("asks identity for an organisation's standing, with the record service's token", async () => {
    const fetchImpl = answering(200, {id: ORG, status: 'Active'});
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl,
    });
    expect(await identity.standingOf(ORG)).to.equal('active');
    expect(fetchImpl.calls).to.have.length(1);
    const [{url, init}] = fetchImpl.calls;
    expect(url).to.equal(`http://identity:3501/organisations/${ORG}/standing`);
    expect(init.method ?? 'GET').to.equal('GET');
    expect(init.headers.authorization).to.equal('Bearer the-token');
  });

  it('a suspended organisation is inactive', async () => {
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl: answering(200, {id: ORG, status: 'Suspended'}),
    });
    expect(await identity.standingOf(ORG)).to.equal('inactive');
  });

  it('an organisation identity does not know (404), or a text that is no organisation id (400), is unknown', async () => {
    for (const status of [404, 400]) {
      const identity = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl: answering(status, {message: 'Organisation not found'}),
      });
      expect(await identity.standingOf('org-x'), String(status)).to.equal(
        'unknown',
      );
    }
  });

  it('puts the id in the path encoded: a text with slashes or dots stays one path segment', async () => {
    const fetchImpl = answering(404, {});
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl,
    });
    await identity.standingOf('../users');
    expect(fetchImpl.calls[0].url).to.equal(
      'http://identity:3501/organisations/..%2Fusers/standing',
    );
  });

  it('rejects with 503 when identity cannot be reached', async () => {
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const error = await failure(identity.standingOf(ORG));
    expect(error.statusCode).to.equal(503);
  });

  it('rejects with 502 for any other answer of identity', async () => {
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl: answering(500, {message: 'boom'}),
    });
    const error = await failure(identity.standingOf(ORG));
    expect(error.statusCode).to.equal(502);
  });
});
