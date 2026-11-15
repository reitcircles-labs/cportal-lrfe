import {createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-47: "Check a B/L by number" on the shipping app's home. GET /records/title?number=<B/L number>
 * finds a B/L by its number (the transport document reference, `recordNo`) among the B/Ls the
 * session's organisation is party to, with the title engine's reader rule (CB-42): the carrier
 * (before issue the owner), the current and past holders, the consignee. Any other organisation
 * gets the same empty answer as for a number nobody uses: the lookup never tells whether a B/L of
 * others exists.
 *
 * Interfaces chosen by the builder (the brief leaves them open):
 * - the lookup is the party list itself with the optional `number`: `{items, total,
 *   organisationNames}`, `limit` and `offset` as before; no new route.
 * - the whole number must match, ignoring the case and the spaces around it; a part of it finds
 *   nothing.
 * - a blank number is refused (400); more than 100 characters too.
 * - two carriers may use the same number: a party to both finds both.
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
 * A new transport document reference (DCSA allows 20 characters), upper case.
 * @param {string} label
 * @return {string}
 */
function nextReference(label) {
  references += 1;
  return `CB47${label}${references}`;
}

/**
 * A person of an organisation, with every B/L permission.
 * @param {string} org
 * @return {{id: string, name: string, org: string, perms: !Array<string>}}
 */
function staffOf(org) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org, perms: ALL_PERMS};
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
  return {
    ...document,
    transportDocumentTypeCode: 'BOL',
    isToOrder: false,
    documentParties: {
      ...document.documentParties,
      consignee: {
        partyName: 'Buyer Trading Ltd',
        identifyingCodes: [
          {
            codeListProvider: 'GLEIF',
            codeListName: 'LEI',
            partyCode: '529900T8BM49AURSDO55',
          },
        ],
        partyContactDetails:
          document.documentParties.shipper.partyContactDetails,
      },
    },
  };
}

/**
 * A B/L of an organisation with its first version committed (four eyes), not issued: its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} org the carrier
 * @param {string} reference
 * @param {{straight?: boolean, commit?: boolean}} [options] `commit: false` leaves it a draft
 * @return {!Promise<string>}
 */
async function blOf(
  ctx,
  org,
  reference,
  {straight = false, commit = true} = {},
) {
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
  if (commit) {
    await ctx.service.submit(record.id, 1, staffOf(org), org);
    await ctx.service.commit(
      record.id,
      1,
      {by: {id: `u2-${org}`, name: `Approver of ${org}`}},
      'bpm',
    );
  }
  return record.id;
}

/**
 * Runs a title command over HTTP, expected to succeed.
 * @param {object} ctx
 * @param {string} id
 * @param {string} name
 * @param {string} org the organisation of the caller
 * @param {object} [body]
 * @return {!Promise<void>}
 */
async function run(ctx, id, name, org, body = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/title/${name}`,
    headers: ctx.as(staffOf(org)),
    payload: body,
  });
  expect(res.statusCode, `${name}: ${res.body}`).to.equal(200);
}

/**
 * GET /records/title?number=… as an organisation's staff: the raw answer.
 * @param {object} ctx
 * @param {string} org
 * @param {string} number as typed
 * @param {string} [more] more of the query string
 * @return {!Promise<object>}
 */
function lookupAs(ctx, org, number, more = '') {
  const query = `number=${encodeURIComponent(number)}${more}`;
  return ctx.app.inject({
    method: 'GET',
    url: `/records/title?${query}`,
    headers: ctx.as(staffOf(org)),
  });
}

/**
 * The ids an organisation finds by a number, expected to succeed.
 * @param {object} ctx
 * @param {string} org
 * @param {string} number
 * @return {!Promise<!Array<string>>}
 */
async function found(ctx, org, number) {
  const res = await lookupAs(ctx, org, number);
  expect(res.statusCode, res.body).to.equal(200);
  const body = res.json();
  expect(body.total).to.equal(body.items.length);
  return body.items.map(item => item.id);
}

/**
 * B/Ls with other numbers that every party of these tests sees, so that a lookup that found by
 * anything but the number would show: one endorsed from the shipper to the bank, one straight to
 * the consignee, one of the other carrier, and a draft of the carrier.
 * @param {object} ctx
 * @return {!Promise<void>}
 */
async function decoys(ctx) {
  const endorsed = await blOf(ctx, CARRIER, nextReference('Z'));
  await run(ctx, endorsed, 'issue', CARRIER);
  await run(ctx, endorsed, 'endorse', SHIPPER, {to: BANK, inBlank: false});
  const straight = await blOf(ctx, CARRIER, nextReference('Z'), {
    straight: true,
  });
  await run(ctx, straight, 'issue', CARRIER);
  const other = await blOf(ctx, OTHER_CARRIER, nextReference('Z'));
  await run(ctx, other, 'issue', OTHER_CARRIER);
  await blOf(ctx, CARRIER, nextReference('Z'), {commit: false});
}

for (const store of stores()) {
  describe(`check a B/L by number (CB-47), ${store.name}`, () => {
    let ctx;
    beforeEach(async () => {
      ctx = await makeHttp(store, {signer: await createLocalSigner()});
      await decoys(ctx);
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('the parties find it', () => {
      it('the carrier finds its issued B/L by its number, and only that one', async () => {
        const reference = nextReference('A');
        const id = await blOf(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        await blOf(ctx, CARRIER, nextReference('B'));

        expect(await found(ctx, CARRIER, reference)).to.deep.equal([id]);
        const [item] = (await lookupAs(ctx, CARRIER, reference)).json().items;
        expect(item).to.include({recordNo: reference});
        expect(item.roles).to.deep.equal(['carrier']);
      });

      it('the carrier finds its draft before issue', async () => {
        const reference = nextReference('D');
        const id = await blOf(ctx, CARRIER, reference, {commit: false});
        expect(await found(ctx, CARRIER, reference)).to.deep.equal([id]);
      });

      it('the holder (a bank it was endorsed to) and the past holder (the shipper) find it', async () => {
        const reference = nextReference('E');
        const id = await blOf(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});

        expect(await found(ctx, BANK, reference)).to.deep.equal([id]);
        expect(await found(ctx, SHIPPER, reference)).to.deep.equal([id]);
      });

      it('the consignee of a straight B/L finds it', async () => {
        const reference = nextReference('S');
        const id = await blOf(ctx, CARRIER, reference, {straight: true});
        await run(ctx, id, 'issue', CARRIER);
        expect(await found(ctx, CONSIGNEE, reference)).to.deep.equal([id]);
      });

      it('the number is found whatever its case and the spaces around it', async () => {
        const reference = nextReference('C');
        const id = await blOf(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        const typed = `  ${reference.toLowerCase()} `;
        expect(await found(ctx, SHIPPER, typed)).to.deep.equal([id]);
      });

      it('two carriers using the same number: a party to both finds both, each carrier its own', async () => {
        const reference = nextReference('SAME');
        const mine = await blOf(ctx, CARRIER, reference);
        const theirs = await blOf(ctx, OTHER_CARRIER, reference);
        await run(ctx, mine, 'issue', CARRIER);
        await run(ctx, theirs, 'issue', OTHER_CARRIER);

        expect(await found(ctx, SHIPPER, reference)).to.have.members([
          mine,
          theirs,
        ]);
        expect(await found(ctx, CARRIER, reference)).to.deep.equal([mine]);
        expect(await found(ctx, OTHER_CARRIER, reference)).to.deep.equal([
          theirs,
        ]);
      });
    });

    describe('nobody else finds it (no enumeration)', () => {
      it('an organisation party to nothing gets the same empty answer as for a number nobody uses', async () => {
        const reference = nextReference('N');
        const id = await blOf(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});

        const existing = await lookupAs(ctx, STRANGER, reference);
        const unknown = await lookupAs(ctx, STRANGER, nextReference('X'));
        expect(existing.statusCode).to.equal(200);
        expect(existing.json()).to.deep.equal({
          items: [],
          total: 0,
          organisationNames: {},
        });
        expect(unknown.statusCode).to.equal(200);
        expect(unknown.json()).to.deep.equal(existing.json());
      });

      it('the shipper named on a draft does not find it before issue; another carrier never', async () => {
        const reference = nextReference('P');
        await blOf(ctx, CARRIER, reference);
        expect(await found(ctx, SHIPPER, reference)).to.deep.equal([]);
        expect(await found(ctx, OTHER_CARRIER, reference)).to.deep.equal([]);
      });

      it('an organisation not on a journey does not find it after it moved on', async () => {
        const reference = nextReference('J');
        const id = await blOf(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        await run(ctx, id, 'endorse', SHIPPER, {to: BANK, inBlank: false});
        expect(await found(ctx, BUYER, reference)).to.deep.equal([]);
      });

      it('a part of the number finds nothing', async () => {
        const reference = nextReference('PART');
        const id = await blOf(ctx, CARRIER, reference);
        await run(ctx, id, 'issue', CARRIER);
        expect(await found(ctx, CARRIER, reference.slice(0, -1))).to.deep.equal(
          [],
        );
        expect(await found(ctx, CARRIER, `${reference}9`)).to.deep.equal([]);
        expect(await found(ctx, CARRIER, '%')).to.deep.equal([]);
        expect(await found(ctx, CARRIER, '_')).to.deep.equal([]);
      });
    });

    describe('wrong input', () => {
      it('a blank number is refused (400)', async () => {
        for (const number of ['', '   ']) {
          const res = await lookupAs(ctx, CARRIER, number);
          expect(res.statusCode, `"${number}": ${res.body}`).to.equal(400);
        }
      });

      it('a number of more than 100 characters is refused (400)', async () => {
        const res = await lookupAs(ctx, CARRIER, 'A'.repeat(101));
        expect(res.statusCode, res.body).to.equal(400);
      });

      it('a user of no organisation is refused (403), as for the list', async () => {
        const res = await ctx.app.inject({
          method: 'GET',
          url: '/records/title?number=X1',
          headers: ctx.as({id: 'u-none', name: 'Nobody', perms: ALL_PERMS}),
        });
        expect(res.statusCode, res.body).to.equal(403);
      });

      it('limit and offset still page the answer', async () => {
        const reference = nextReference('PG');
        const mine = await blOf(ctx, CARRIER, reference);
        const theirs = await blOf(ctx, OTHER_CARRIER, reference);
        await run(ctx, mine, 'issue', CARRIER);
        await run(ctx, theirs, 'issue', OTHER_CARRIER);
        const res = await lookupAs(ctx, SHIPPER, reference, '&limit=1');
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().items).to.have.length(1);
        expect(res.json().total).to.equal(2);
      });
    });
  });
}
