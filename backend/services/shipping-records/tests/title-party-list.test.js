import {AppError, createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-42: the B/Ls an organisation is party to, for the shipping app's home. GET /records/title
 * lists, for the session's organisation only, every B/L it would see with GET /records/:id/title
 * (the title engine's reader rule): before issue the B/Ls it owns (its drafts, in review or
 * committed), after issue those of which it is the carrier, the current holder, a past holder (in
 * the chain of title as `from` or `to`) or the consignee. Any other organisation's B/L is never
 * listed. Each item says the organisation's roles on it (`carrier`, `holder`, `past-holder`,
 * `consignee`). The title read gives the B/L's reference and the caller's roles too, so a party that
 * is not the owner can show it.
 *
 * Interfaces chosen by the builder (the design leaves them open):
 * - GET /records/title?limit&offset → {items, total}, newest first (createdAt), as GET /records
 *   pages; any other query parameter is dropped (the organisation is never taken from the request).
 * - An item: the record's summary (id, recordNo, carrierCode, label, status, draftState, ...),
 *   `title` ({kind, state, carrier, holder, endorsement, consignee}, null before issue) and `roles`.
 * - The carrier is never listed as its own past holder; after a surrender it is carrier and holder.
 * - GET /records/:id/title adds `record` ({recordNo, carrierCode, label, status, draftState}) and
 *   `roles` to its answer, and so does every command's answer (the same view).
 * - Names (added after review of the design: organisations shown by name): the list and the title
 *   read answer `organisationNames`, {id: name} of the organisations they name (the list: each
 *   item's owner, carrier, holder and consignee; the read: those and every organisation of the
 *   chain), asked of identity once per id per answer. An organisation identity gives no name for,
 *   or every one while identity cannot answer, is left out (the screen shows its id): the answer
 *   never fails for a name.
 */

const CARRIER = 'org-carrier';
const OTHER_CARRIER = 'org-other-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const CONSIGNEE = 'org-consignee';
const STRANGER = 'org-stranger';

const ALL_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/** How many references nextReference gave. */
let references = 0;

/**
 * A new transport document reference (DCSA allows 20 characters).
 * @param {string} label
 * @return {string}
 */
function nextReference(label) {
  references += 1;
  return `CB42-${label}-${references}`;
}

/**
 * A person of an organisation, with the permissions given (all B/L permissions by default).
 * @param {string} org
 * @param {!Array<string>} [perms]
 * @return {{id: string, name: string, org: string, perms: !Array<string>}}
 */
function staffOf(org, perms = ALL_PERMS) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org, perms};
}

/**
 * The second person of an organisation, who approves (four-eyes).
 * @param {string} org
 * @return {{id: string, name: string}}
 */
function approverOf(org) {
  return {id: `u2-${org}`, name: `Approver of ${org}`};
}

/**
 * A DCSA transport document: the example B/L (to order), or one to a named consignee (straight).
 * @param {string} reference
 * @param {boolean} straight
 * @return {object}
 */
function documentOf(reference, straight) {
  const document = exampleWithReference(reference);
  if (!straight) {
    return document;
  }
  const consignee = {
    partyName: 'Buyer Trading Ltd',
    identifyingCodes: [
      {
        codeListProvider: 'GLEIF',
        codeListName: 'LEI',
        partyCode: '529900T8BM49AURSDO55',
      },
    ],
    partyContactDetails: document.documentParties.shipper.partyContactDetails,
  };
  return {
    ...document,
    transportDocumentTypeCode: 'BOL',
    isToOrder: false,
    documentParties: {...document.documentParties, consignee},
  };
}

/**
 * A draft B/L of an organisation (version 1, not submitted): its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} org the owner
 * @param {string} reference
 * @param {{straight?: boolean}} [options]
 * @return {!Promise<string>}
 */
async function draftBl(ctx, org, reference, {straight = false} = {}) {
  const partyOrganisations = {shipper: SHIPPER};
  if (straight) {
    partyOrganisations.consignee = CONSIGNEE;
  }
  const record = await ctx.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: documentOf(reference, straight),
      partyOrganisations,
    },
    staffOf(org),
    org,
  );
  return record.id;
}

/**
 * A B/L of an organisation with its first version committed (not issued): its id.
 * @param {object} ctx
 * @param {string} org
 * @param {string} reference
 * @param {{straight?: boolean}} [options]
 * @return {!Promise<string>}
 */
async function committedBl(ctx, org, reference, options = {}) {
  const id = await draftBl(ctx, org, reference, options);
  await ctx.service.submit(id, 1, staffOf(org), org);
  await ctx.service.commit(id, 1, {by: approverOf(org)}, 'bpm');
  return id;
}

/**
 * Runs a title command over HTTP, expected to succeed: its answer's body.
 * @param {object} ctx
 * @param {string} id
 * @param {string} name
 * @param {string} org the organisation of the caller
 * @param {object} [body]
 * @return {!Promise<object>}
 */
async function run(ctx, id, name, org, body = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/title/${name}`,
    headers: ctx.as(staffOf(org)),
    payload: body,
  });
  expect(res.statusCode, `${name}: ${res.body}`).to.equal(200);
  return res.json();
}

/**
 * GET /records/title as a user: the raw answer.
 * @param {object} ctx
 * @param {?object} user the caller, null for no token
 * @param {string} [query] the query string, without "?"
 * @return {!Promise<object>}
 */
function listAs(ctx, user, query = '') {
  const headers = user ? ctx.as(user) : {};
  const url = query ? `/records/title?${query}` : '/records/title';
  return ctx.app.inject({method: 'GET', url, headers});
}

/**
 * The list of an organisation's staff, expected to succeed: its body.
 * @param {object} ctx
 * @param {string} org
 * @param {string} [query]
 * @return {!Promise<{items: !Array<object>, total: number}>}
 */
async function listOf(ctx, org, query = '') {
  const res = await listAs(ctx, staffOf(org), query);
  expect(res.statusCode, res.body).to.equal(200);
  return res.json();
}

/**
 * The ids an organisation's list holds, in its order.
 * @param {object} ctx
 * @param {string} org
 * @return {!Promise<!Array<string>>}
 */
async function idsOf(ctx, org) {
  return (await listOf(ctx, org)).items.map(item => item.id);
}

/**
 * The roles an organisation's list gives for a B/L, or undefined when it is not listed.
 * @param {object} ctx
 * @param {string} org
 * @param {string} id
 * @return {!Promise<(!Array<string>|undefined)>}
 */
async function rolesIn(ctx, org, id) {
  const item = (await listOf(ctx, org)).items.find(i => i.id === id);
  return item?.roles;
}

/** The organisations' names identity gives in these tests (CB-42); the stranger has none. */
const NAMES = new Map([
  [CARRIER, 'Ocean Carrier Line'],
  [OTHER_CARRIER, 'Other Carrier'],
  [SHIPPER, 'Coffee Exporters'],
  [BANK, 'Volta Bank'],
  [BUYER, 'Roastery Imports'],
  [CONSIGNEE, 'Buyer Trading'],
]);

/**
 * Identity as the title service's client sees it: every organisation active, and its name
 * (`nameOf`, null for one it does not know). `asked` counts the names asked for; `down` makes
 * every name request fail, as when identity cannot be reached.
 * @return {{
 *   standingOf: function(string): !Promise<string>,
 *   nameOf: function(string): !Promise<?string>,
 *   asked: !Array<string>,
 *   down: boolean,
 * }}
 */
function namingIdentity() {
  const identity = {
    asked: [],
    down: false,
    async standingOf() {
      return 'active';
    },
    async nameOf(id) {
      identity.asked.push(id);
      if (identity.down) {
        throw new AppError(503, 'The identity service cannot be reached');
      }
      return NAMES.get(id) ?? null;
    },
  };
  return identity;
}

for (const store of stores()) {
  describe(`the B/Ls my organisation is party to (CB-42), ${store.name}`, () => {
    let ctx;
    let identity;
    beforeEach(async () => {
      identity = namingIdentity();
      ctx = await makeHttp(store, {
        signer: await createLocalSigner(),
        organisations: identity,
      });
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('the carrier', () => {
      it('sees its drafts, in review and committed, before issue: no title, its role carrier', async () => {
        const draft = await draftBl(ctx, CARRIER, nextReference('D'));
        const inReview = await draftBl(ctx, CARRIER, nextReference('R'));
        await ctx.service.submit(inReview, 1, staffOf(CARRIER), CARRIER);
        const committed = await committedBl(ctx, CARRIER, nextReference('C'));

        const {items, total} = await listOf(ctx, CARRIER);
        expect(total).to.equal(3);
        expect(items.map(i => i.id)).to.have.members([
          draft,
          inReview,
          committed,
        ]);
        for (const item of items) {
          expect(item.title).to.equal(null);
          expect(item.roles).to.deep.equal(['carrier']);
        }
        const byId = new Map(items.map(i => [i.id, i]));
        expect(byId.get(draft)).to.include({
          status: 'draft',
          draftState: 'draft',
        });
        expect(byId.get(inReview)).to.include({draftState: 'in_review'});
        expect(byId.get(committed)).to.include({status: 'committed'});
      });

      it('sees the B/Ls it issued, with their title', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('I'));
        await run(ctx, id, 'issue', CARRIER);
        const [item] = (await listOf(ctx, CARRIER)).items;
        expect(item.id).to.equal(id);
        expect(item.title).to.include({
          kind: 'negotiable',
          state: 'issued',
          carrier: CARRIER,
          holder: SHIPPER,
        });
        expect(item.roles).to.deep.equal(['carrier']);
      });

      it('an item carries the reference, the label and the carrier code', async () => {
        const reference = nextReference('L');
        await draftBl(ctx, CARRIER, reference);
        const [item] = (await listOf(ctx, CARRIER)).items;
        expect(item.recordNo).to.equal(reference);
        expect(item.label).to.be.a('string').and.include(reference);
        expect(item.carrierCode).to.be.a('string').and.not.equal('');
      });
    });

    describe('the parties after issue', () => {
      it('the shipper, first holder, sees the issued B/L as holder, never the drafts of the carrier', async () => {
        await draftBl(ctx, CARRIER, nextReference('D'));
        await committedBl(ctx, CARRIER, nextReference('C'));
        const issued = await committedBl(ctx, CARRIER, nextReference('I'));
        await run(ctx, issued, 'issue', CARRIER);

        expect(await idsOf(ctx, SHIPPER)).to.deep.equal([issued]);
        expect(await rolesIn(ctx, SHIPPER, issued)).to.deep.equal(['holder']);
      });

      it('after an endorsement the shipper is a past holder and the bank the holder', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('E'));
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});

        expect(await rolesIn(ctx, SHIPPER, id)).to.deep.equal(['past-holder']);
        expect(await rolesIn(ctx, BANK, id)).to.deep.equal(['holder']);
        expect(await rolesIn(ctx, CARRIER, id)).to.deep.equal(['carrier']);
      });

      it('a past holder still sees it once it has moved on twice', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('T'));
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});
        await run(ctx, id, 'endorse', BANK, {to: BUYER, inBlank: false});

        expect(await rolesIn(ctx, SHIPPER, id)).to.deep.equal(['past-holder']);
        expect(await rolesIn(ctx, BANK, id)).to.deep.equal(['past-holder']);
        expect(await rolesIn(ctx, BUYER, id)).to.deep.equal(['holder']);
      });

      it('after a surrender the carrier holds it (carrier and holder); after the release it is the carrier only, the buyer a past holder', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('S'));
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BUYER, inBlank: false});
        await run(ctx, id, 'surrender', BUYER);
        expect(await rolesIn(ctx, CARRIER, id)).to.deep.equal([
          'carrier',
          'holder',
        ]);
        expect(await rolesIn(ctx, BUYER, id)).to.deep.equal(['past-holder']);

        await run(ctx, id, 'release', CARRIER);
        expect(await rolesIn(ctx, CARRIER, id)).to.deep.equal(['carrier']);
        expect(await rolesIn(ctx, BUYER, id)).to.deep.equal(['past-holder']);
        const item = (await listOf(ctx, BUYER)).items[0];
        expect(item.title).to.include({state: 'accomplished', holder: null});
      });

      it('the consignee of a straight B/L sees it as consignee', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('ST'), {
          straight: true,
        });
        await run(ctx, id, 'issue', CARRIER);
        expect(await rolesIn(ctx, CONSIGNEE, id)).to.deep.equal(['consignee']);
        const item = (await listOf(ctx, CONSIGNEE)).items[0];
        expect(item.title).to.include({kind: 'straight', consignee: CONSIGNEE});
      });
    });

    describe("other organisations' B/Ls are never listed", () => {
      it('an organisation party to nothing gets an empty list', async () => {
        await draftBl(ctx, CARRIER, nextReference('D'));
        const id = await committedBl(ctx, CARRIER, nextReference('I'));
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});

        expect(await listOf(ctx, STRANGER)).to.deep.equal({
          items: [],
          total: 0,
          organisationNames: {},
        });
      });

      it('two carriers drafting the same reference each see only their own', async () => {
        const reference = nextReference('SAME');
        const mine = await draftBl(ctx, CARRIER, reference);
        const theirs = await draftBl(ctx, OTHER_CARRIER, reference);
        expect(await idsOf(ctx, CARRIER)).to.deep.equal([mine]);
        expect(await idsOf(ctx, OTHER_CARRIER)).to.deep.equal([theirs]);
      });

      it('each organisation of a journey sees exactly the B/Ls it is party to', async () => {
        const toBank = await committedBl(ctx, CARRIER, nextReference('B'));
        await run(ctx, toBank, 'issue', CARRIER);
        await run(ctx, toBank, 'endorse', SHIPPER, {to: BANK, inBlank: false});
        const straight = await committedBl(ctx, CARRIER, nextReference('ST'), {
          straight: true,
        });
        await run(ctx, straight, 'issue', CARRIER);
        const otherDraft = await draftBl(
          ctx,
          OTHER_CARRIER,
          nextReference('O'),
        );

        expect(await idsOf(ctx, CARRIER)).to.have.members([toBank, straight]);
        // the shipper of a straight B/L is no party: it has no holder (changed: the reader rule)
        expect(await idsOf(ctx, SHIPPER)).to.deep.equal([toBank]);
        expect(await idsOf(ctx, BANK)).to.deep.equal([toBank]);
        expect(await idsOf(ctx, CONSIGNEE)).to.deep.equal([straight]);
        expect(await idsOf(ctx, OTHER_CARRIER)).to.deep.equal([otherDraft]);
        expect(await idsOf(ctx, BUYER)).to.deep.equal([]);
      });

      it("the organisation comes from the session only: naming another in the query is ignored, the list stays the caller's (changed: unknown query parameters are dropped, as for GET /records)", async () => {
        await draftBl(ctx, CARRIER, nextReference('D'));
        for (const query of [
          `organisationId=${CARRIER}`,
          `org=${CARRIER}`,
          `party=${CARRIER}`,
        ]) {
          const res = await listAs(ctx, staffOf(STRANGER), query);
          expect(res.statusCode, query).to.equal(200);
          expect(res.json(), query).to.deep.equal({
            items: [],
            total: 0,
            organisationNames: {},
          });
        }
      });
    });

    describe('paging', () => {
      it('pages newest first with limit and offset, and gives the total', async () => {
        const ids = [];
        for (const n of [1, 2, 3]) {
          ids.push(await draftBl(ctx, CARRIER, nextReference(`P${n}`)));
        }
        const newestFirst = [...ids].reverse();
        const first = await listOf(ctx, CARRIER, 'limit=2');
        expect(first.total).to.equal(3);
        expect(first.items.map(i => i.id)).to.deep.equal(
          newestFirst.slice(0, 2),
        );
        const second = await listOf(ctx, CARRIER, 'limit=2&offset=2');
        expect(second.total).to.equal(3);
        expect(second.items.map(i => i.id)).to.deep.equal(newestFirst.slice(2));
      });

      it('refuses a limit out of 1..200 and a negative or non-numeric offset (400)', async () => {
        for (const query of [
          'limit=0',
          'limit=201',
          'limit=x',
          'offset=-1',
          'offset=x',
        ]) {
          const res = await listAs(ctx, staffOf(CARRIER), query);
          expect(res.statusCode, query).to.equal(400);
        }
      });
    });

    describe('who may ask', () => {
      it('without a token: 401; without bl.read: 403; a user of no organisation: 403', async () => {
        expect((await listAs(ctx, null)).statusCode).to.equal(401);
        const noRead = staffOf(CARRIER, ['bl.draft']);
        expect((await listAs(ctx, noRead)).statusCode).to.equal(403);
        const noOrg = {id: 'u-x', name: 'Lukas Haufiku', perms: ALL_PERMS};
        expect((await listAs(ctx, noOrg)).statusCode).to.equal(403);
      });

      it('a service token (the audit service) gets 401: the list is of an organisation (changed: 401, the guard of user routes)', async () => {
        const token = ctx.app.jwt.sign({typ: 'service', sub: 'audit'});
        const res = await ctx.app.inject({
          method: 'GET',
          url: '/records/title',
          headers: {authorization: `Bearer ${token}`},
        });
        expect(res.statusCode).to.equal(401);
      });
    });

    describe('the title read names the B/L and the roles of the caller', () => {
      it('before issue: the reference and the carrier role for the owner', async () => {
        const reference = nextReference('V');
        const id = await committedBl(ctx, CARRIER, reference);
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: ctx.as(staffOf(CARRIER)),
        });
        expect(res.statusCode, res.body).to.equal(200);
        const view = res.json();
        expect(view.record).to.include({
          recordNo: reference,
          status: 'committed',
        });
        expect(view.record.label).to.include(reference);
        expect(view.roles).to.deep.equal(['carrier']);
      });

      it('a past holder reads the reference and its role; a command answers the same fields', async () => {
        const reference = nextReference('W');
        const id = await committedBl(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        const endorsed = await run(ctx, id, 'endorse', SHIPPER, {
          to: BANK,
          inBlank: false,
        });
        expect(endorsed.record.recordNo).to.equal(reference);
        expect(endorsed.roles).to.deep.equal(['past-holder']);

        const res = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: ctx.as(staffOf(BANK)),
        });
        expect(res.json().record.recordNo).to.equal(reference);
        expect(res.json().roles).to.deep.equal(['holder']);
      });
    });

    describe('the names of the organisations (added: organisations shown by name)', () => {
      it("the list names each item's carrier, holder and consignee, and the draft's owner", async () => {
        const toBank = await committedBl(ctx, CARRIER, nextReference('N'));
        await run(ctx, toBank, 'issue', CARRIER);
        await run(ctx, toBank, 'endorse', SHIPPER, {to: BANK, inBlank: false});
        const straight = await committedBl(ctx, CARRIER, nextReference('NS'), {
          straight: true,
        });
        await run(ctx, straight, 'issue', CARRIER);
        await draftBl(ctx, CARRIER, nextReference('ND'));

        const page = await listOf(ctx, CARRIER);
        expect(page.organisationNames).to.deep.equal({
          [CARRIER]: 'Ocean Carrier Line',
          [BANK]: 'Volta Bank',
          [CONSIGNEE]: 'Buyer Trading',
        });
        expect(await listOf(ctx, STRANGER)).to.deep.equal({
          items: [],
          total: 0,
          organisationNames: {},
        });
      });

      it('the title read names every organisation of the title and of its chain, and no other', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('NR'));
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});
        await run(ctx, id, 'endorse', BANK, {to: BUYER, inBlank: false});
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: ctx.as(staffOf(SHIPPER)),
        });
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().organisationNames).to.deep.equal({
          [CARRIER]: 'Ocean Carrier Line',
          [SHIPPER]: 'Coffee Exporters',
          [BANK]: 'Volta Bank',
          [BUYER]: 'Roastery Imports',
        });
      });

      it('asks identity once per organisation for an answer', async () => {
        for (const n of [1, 2, 3]) {
          await draftBl(ctx, CARRIER, nextReference(`NO${n}`));
        }
        identity.asked.length = 0;
        await listOf(ctx, CARRIER);
        expect(identity.asked).to.deep.equal([CARRIER]);
      });

      it('an organisation identity has no name for is left out; the rest are named', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('NU'));
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: STRANGER, inBlank: false});
        const page = await listOf(ctx, CARRIER);
        expect(page.organisationNames).to.deep.equal({
          [CARRIER]: 'Ocean Carrier Line',
        });
      });

      it('while identity cannot answer, the list and the read still answer, without names', async () => {
        const id = await committedBl(ctx, CARRIER, nextReference('NX'));
        await run(ctx, id, 'issue', CARRIER);
        identity.down = true;
        const page = await listOf(ctx, CARRIER);
        expect(page.items.map(i => i.id)).to.deep.equal([id]);
        expect(page.organisationNames).to.deep.equal({});
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: ctx.as(staffOf(CARRIER)),
        });
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().organisationNames).to.deep.equal({});
      });
    });
  });
}
