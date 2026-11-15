import {createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {makeHttp, stores} from './helpers.js';

/**
 * CB-45: the holder of a B/L picks whom to endorse it to from the organisations registered and
 * active on the platform. Trade staff (shippers, banks, buyers) have bl.endorse but not bl.draft,
 * so GET /records/organisations is open to either permission; it answers only the id, code and
 * name of each organisation, whatever the source gives.
 *
 *   GET /records/organisations   bl.draft or bl.endorse, a user of an organisation
 *     200 {items: [{id, code, name}]}   only those three fields of each
 *     403 with neither permission, or for a user of no organisation
 */

/** The organisations identity answers in these tests, with fields the list must not pass on. */
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

/** The same organisations as the list must answer them. */
const LISTED = [
  {id: 'org-exporter', code: 'EXP', name: 'Coffee Exporters'},
  {id: 'org-bank', code: 'BNK', name: 'First Bank'},
];

describe('GET /records/organisations: whom the holder may endorse to (CB-45)', () => {
  for (const store of stores()) {
    describe(`on ${store.name}`, () => {
      let ctx;

      beforeEach(async () => {
        const identity = {
          async standingOf() {
            return 'active';
          },
          async activeOrganisations() {
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
       * @param {object} user
       * @return {!Promise<object>}
       */
      function list(user) {
        return ctx.app.inject({
          url: '/records/organisations',
          headers: ctx.as(user),
        });
      }

      const tradeClerk = {
        id: 'u-trade',
        name: 'Ana Ribeiro',
        org: 'org-exporter',
        perms: ['bl.read', 'bl.endorse'],
      };

      it('a trade clerk who endorses B/Ls, without bl.draft, gets the active organisations', async () => {
        const res = await list(tradeClerk);
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json()).to.deep.equal({items: LISTED});
      });

      it('answers only the id, code and name of each organisation', async () => {
        const drafter = {
          ...tradeClerk,
          id: 'u-draft',
          org: 'org-carrier',
          perms: ['bl.read', 'bl.draft'],
        };
        for (const user of [tradeClerk, drafter]) {
          const res = await list(user);
          expect(res.statusCode, res.body).to.equal(200);
          for (const item of res.json().items) {
            expect(Object.keys(item).sort()).to.deep.equal([
              'code',
              'id',
              'name',
            ]);
          }
        }
      });

      it('403 for a reader with neither bl.draft nor bl.endorse', async () => {
        const reader = {...tradeClerk, id: 'u-reader', perms: ['bl.read']};
        expect((await list(reader)).statusCode).to.equal(403);
      });

      it('403 for a user with bl.endorse but no organisation', async () => {
        const noOrg = {id: 'u-none', name: 'Nobody', perms: ['bl.endorse']};
        expect((await list(noOrg)).statusCode).to.equal(403);
      });
    });
  }
});
