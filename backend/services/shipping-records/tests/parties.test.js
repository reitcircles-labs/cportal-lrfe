import {AppError, createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {createIdentityClient} from '../src/identity-client.js';
import {makeHttp, stores} from './helpers.js';

/**
 * CB-44: the organisations a carrier's clerk may name as the shipper or the consignee of a new
 * B/L, the ones registered and active on the platform, as identity lists them for the record
 * service (GET /organisations/active, asked with the record service's token).
 *
 *   identity client activeOrganisations() → [{id, code, name}]; rejects 503 when identity
 *     cannot be reached, 502 for any other answer than 200
 *   GET /records/organisations   bl.draft or bl.endorse (CB-45), a user of an organisation
 *     200 {items: [{id, code, name}]}   as identity answers them
 *     403 without bl.draft or bl.endorse, or without an organisation, 401 without a token
 *     503 while identity cannot answer
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

/** The organisations identity answers in these tests. */
const ACTIVE = [
  {id: 'org-exporter', code: 'EXP', name: 'Coffee Exporters'},
  {id: 'org-bank', code: 'BNK', name: 'First Bank'},
];

describe('the identity client: the active organisations (CB-44)', () => {
  const serviceToken = () => 'the-token';

  it("asks identity for the active organisations, with the record service's token", async () => {
    const fetchImpl = answering(200, {organisations: ACTIVE});
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl,
    });
    expect(await identity.activeOrganisations()).to.deep.equal(ACTIVE);
    expect(fetchImpl.calls).to.have.length(1);
    expect(fetchImpl.calls[0].url).to.equal(
      'http://identity:3501/organisations/active',
    );
    expect(fetchImpl.calls[0].init.headers.authorization).to.equal(
      'Bearer the-token',
    );
  });

  it('keeps only the id, code and name of each', async () => {
    const fetchImpl = answering(200, {
      organisations: [{...ACTIVE[0], status: 'Active', users: 3}],
    });
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl,
    });
    expect(await identity.activeOrganisations()).to.deep.equal([ACTIVE[0]]);
  });

  it('rejects with 503 when identity cannot be reached, 502 for another answer', async () => {
    const down = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect((await failure(down.activeOrganisations())).statusCode).to.equal(
      503,
    );
    const failing = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl: answering(500, {message: 'boom'}),
    });
    expect((await failure(failing.activeOrganisations())).statusCode).to.equal(
      502,
    );
  });
});

describe('GET /records/organisations: whom a new B/L may name (CB-44)', () => {
  for (const store of stores()) {
    describe(`on ${store.name}`, () => {
      let ctx;
      let identity;

      beforeEach(async () => {
        identity = {
          down: false,
          async standingOf() {
            return 'active';
          },
          async activeOrganisations() {
            if (identity.down) {
              throw new AppError(503, 'The identity service cannot be reached');
            }
            return ACTIVE;
          },
        };
        ctx = await makeHttp(store, {
          signer: await createLocalSigner(),
          organisations: identity,
        });
      });

      afterEach(async () => {
        await ctx.close();
      });

      /**
       * The list as a user: the raw answer.
       * @param {?object} user
       * @return {!Promise<object>}
       */
      function list(user) {
        const headers = user ? ctx.as(user) : {};
        return ctx.app.inject({url: '/records/organisations', headers});
      }

      const clerk = {
        id: 'u-clerk',
        name: 'Lena Okafor',
        org: 'org-carrier',
        perms: ['bl.read', 'bl.draft'],
      };

      it('a clerk who drafts B/Ls gets the active organisations', async () => {
        const res = await list(clerk);
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json()).to.deep.equal({items: ACTIVE});
      });

      it('403 without bl.draft or bl.endorse, or without an organisation, 401 without a token', async () => {
        const reader = {...clerk, id: 'u-reader', perms: ['bl.read']};
        expect((await list(reader)).statusCode).to.equal(403);
        const noOrg = {id: 'u-none', name: 'Nobody', perms: ['bl.draft']};
        expect((await list(noOrg)).statusCode).to.equal(403);
        expect((await list(null)).statusCode).to.equal(401);
      });

      it('503 while identity cannot answer', async () => {
        identity.down = true;
        const res = await list(clerk);
        expect(res.statusCode, res.body).to.equal(503);
      });
    });
  }
});
