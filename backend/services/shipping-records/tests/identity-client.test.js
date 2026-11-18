import {AppError, createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {createIdentityClient} from '../src/identity-client.js';
import {makeHttp, stores} from './helpers.js';

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

  it("the platform operator's own organisation is the operator, never active (CB-48)", async () => {
    const identity = createIdentityClient({
      baseUrl: 'http://identity:3501',
      serviceToken,
      fetchImpl: answering(200, {id: ORG, status: 'Active', operator: true}),
    });
    expect(await identity.standingOf(ORG)).to.equal('operator');
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

  describe("an organisation's name (CB-42)", () => {
    it('asks the same standing route and gives the name, with the token', async () => {
      const fetchImpl = answering(200, {
        id: ORG,
        status: 'Active',
        name: 'First Bank',
      });
      const identity = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl,
      });
      expect(await identity.nameOf(ORG)).to.equal('First Bank');
      expect(fetchImpl.calls[0].url).to.equal(
        `http://identity:3501/organisations/${ORG}/standing`,
      );
      expect(fetchImpl.calls[0].init.headers.authorization).to.equal(
        'Bearer the-token',
      );
    });

    it('a suspended organisation keeps its name', async () => {
      const identity = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl: answering(200, {id: ORG, status: 'Suspended', name: 'B'}),
      });
      expect(await identity.nameOf(ORG)).to.equal('B');
    });

    it('null for an unknown organisation (404, 400) or an answer without a name', async () => {
      for (const [status, body] of [
        [404, {message: 'Organisation not found'}],
        [400, {message: 'bad id'}],
        [200, {id: ORG, status: 'Active'}],
      ]) {
        const identity = createIdentityClient({
          baseUrl: 'http://identity:3501',
          serviceToken,
          fetchImpl: answering(status, body),
        });
        expect(await identity.nameOf(ORG), String(status)).to.equal(null);
      }
    });

    it('rejects as standingOf does: 503 unreachable, 502 any other answer', async () => {
      const down = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      });
      expect((await failure(down.nameOf(ORG))).statusCode).to.equal(503);
      const broken = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl: answering(500, {message: 'boom'}),
      });
      expect((await failure(broken.nameOf(ORG))).statusCode).to.equal(502);
    });
  });

  describe('activeOrganisations (CB-44)', () => {
    const ACTIVE = [
      {id: 'org-exporter', code: 'EXP', name: 'Coffee Exporters'},
      {id: 'org-bank', code: 'BNK', name: 'First Bank'},
    ];

    it('asks GET /organisations/active, strips extra fields, and maps 503/502', async () => {
      const fetchImpl = answering(200, {
        organisations: [{...ACTIVE[0], status: 'Active', users: 3}, ACTIVE[1]],
      });
      const identity = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl,
      });
      expect(await identity.activeOrganisations()).to.deep.equal(ACTIVE);
      expect(fetchImpl.calls[0].url).to.equal(
        'http://identity:3501/organisations/active',
      );
      expect(fetchImpl.calls[0].init.headers.authorization).to.equal(
        'Bearer the-token',
      );
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
      const broken = createIdentityClient({
        baseUrl: 'http://identity:3501',
        serviceToken,
        fetchImpl: answering(500, {message: 'boom'}),
      });
      expect((await failure(broken.activeOrganisations())).statusCode).to.equal(
        502,
      );
    });
  });
});

describe('GET /records/organisations (CB-44, CB-45)', () => {
  const ACTIVE = [
    {
      id: 'org-exporter',
      code: 'EXP',
      name: 'Coffee Exporters',
      status: 'Active',
      users: 4,
    },
    {id: 'org-bank', code: 'BNK', name: 'First Bank', contact: 'ops@bank.test'},
  ];
  const LISTED = [
    {id: 'org-exporter', code: 'EXP', name: 'Coffee Exporters'},
    {id: 'org-bank', code: 'BNK', name: 'First Bank'},
  ];

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

      const list = user =>
        ctx.app.inject({
          url: '/records/organisations',
          headers: user ? ctx.as(user) : {},
        });

      const drafter = {
        id: 'u-clerk',
        name: 'Lena Okafor',
        org: 'org-carrier',
        perms: ['bl.read', 'bl.draft'],
      };
      const endorser = {
        id: 'u-trade',
        name: 'Ana Ribeiro',
        org: 'org-exporter',
        perms: ['bl.read', 'bl.endorse'],
      };

      it('lets bl.draft and bl.endorse read {id, code, name}; 403 otherwise; 401 without token; 503 if identity is down', async () => {
        for (const user of [drafter, endorser]) {
          const res = await list(user);
          expect(res.statusCode, res.body).to.equal(200);
          expect(res.json()).to.deep.equal({items: LISTED});
        }
        expect(
          (await list({...drafter, id: 'u-r', perms: ['bl.read']})).statusCode,
        ).to.equal(403);
        expect(
          (await list({id: 'u-none', name: 'Nobody', perms: ['bl.endorse']}))
            .statusCode,
        ).to.equal(403);
        expect((await list(null)).statusCode).to.equal(401);
        identity.down = true;
        expect((await list(drafter)).statusCode).to.equal(503);
      });
    });
  }
});
