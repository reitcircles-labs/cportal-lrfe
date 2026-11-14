import {AppError, createLocalSigner} from '@lrfe/common';
import {FORMATS, billOfLadingHash} from '@lrfe/domain-shipping/bill-of-lading';
import {TITLE_WORDING, endorseeOf} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {verifyTitleChain} from '../src/chain.js';
import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-37: blank endorsement and transfer of possession, through the API (POST
 * /records/:id/title/:command, GET /records/:id/title, GET /records/:id/title/proof).
 *
 * - Named, blank and transfer steps follow the state machine (CB-30); each refusal answers with
 *   the pack's wording (TITLE_WORDING) and records nothing: a transfer of a B/L endorsed to a
 *   name (409 `not-endorsed-in-blank`), a blank endorsement or a transfer by an organisation that
 *   is not the holder (403 `not-holder`), a blank endorsement or transfer to an organisation not
 *   registered or not active (422 `unregistered-organisation`).
 * - Any later holder of a blank-endorsed B/L may endorse it to a name again.
 * - The mixed journey (issue → blank to bank A → transfer to bank B → named to the buyer →
 *   surrender → release): its chain verifies, each entry signed and published for the audit
 *   trail, and its title proof's chain verifies with the bundle's own keys. The anchoring and the
 *   offline verifier are tested in the audit service (title-mixed-journey.test.js).
 * - The endorsee is never written into the stored document (Jira CB-37 comment 11579): no new
 *   version, the same hash; the DCSA document written out carries the latest named endorsee.
 * - Switching a blank-endorsed B/L to paper needs confirmBearer true (409 `bearer-unconfirmed`).
 *
 * Already covered by CB-34 (title-api.test.js), not repeated here: a named endorsement by a past
 * holder or the carrier (403), a named endorsement to an organisation not registered or
 * suspended (422), a transfer to an organisation not registered (422), a blank endorsement then a
 * transfer (the happy path), switching a named B/L to paper, 404 for every command of an
 * organisation that does not see the B/L.
 */

/** The organisations of the tests: the carrier owns the B/Ls. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK_A = 'org-bank-a';
const BANK_B = 'org-bank-b';
const BUYER = 'org-buyer';
const SUSPENDED = 'org-suspended';
const UNKNOWN = 'org-unknown';

/** Every B/L permission, as the demo role bld has them. */
const ALL_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/** The party the DCSA document names for the buyer's organisation in these tests. */
const BUYER_PARTY = Object.freeze({partyName: 'Buyer Trading Ltd'});

/** How many references nextReference gave. */
let references = 0;

/**
 * A new transport document reference, so each B/L of a test is new (DCSA allows 20 characters).
 * @param {string} label
 * @return {string}
 */
function nextReference(label) {
  references += 1;
  return `CB37-${label}-${references}`;
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
 * Identity as the title service's client sees it: every organisation of the tests is active,
 * SUSPENDED is inactive, any other unknown. `asked` lists the ids asked about.
 * @return {{standingOf: function(string): !Promise<string>, asked: !Array<string>}}
 */
function standInIdentity() {
  const standings = new Map([
    [CARRIER, 'active'],
    [SHIPPER, 'active'],
    [BANK_A, 'active'],
    [BANK_B, 'active'],
    [BUYER, 'active'],
    [SUSPENDED, 'inactive'],
  ]);
  const identity = {
    asked: [],
    async standingOf(id) {
      identity.asked.push(id);
      return standings.get(id) ?? 'unknown';
    },
  };
  return identity;
}

/**
 * The audit service as the title service's client sees it, with nothing anchored yet: every
 * entry proof is 404 (not on the trail yet), so a title proof says pending.
 * @type {{entryProof: function(string): !Promise<object>}}
 */
const NOTHING_ANCHORED = Object.freeze({
  /**
   * @return {!Promise<object>}
   */
  async entryProof() {
    throw new AppError(404, 'There is no trail entry for this event');
  },
});

/**
 * A negotiable B/L of the carrier, its shipper linked, with its first version committed: its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function committedBl(ctx, reference) {
  const record = await ctx.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: exampleWithReference(reference),
      partyOrganisations: {shipper: SHIPPER},
    },
    drafter,
    CARRIER,
  );
  await ctx.service.submit(record.id, 1, drafter, CARRIER);
  await ctx.service.commit(record.id, 1, {by: approver}, 'bpm');
  return record.id;
}

/**
 * Runs a title command over HTTP as a user: the raw answer.
 * @param {object} ctx
 * @param {string} id the B/L
 * @param {string} name the command
 * @param {object} user the caller
 * @param {object} [body] the command's arguments
 * @return {!Promise<object>}
 */
function command(ctx, id, name, user, body = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/title/${name}`,
    headers: ctx.as(user),
    payload: body,
  });
}

/**
 * Runs a command expected to succeed: its answer's body.
 * @param {object} ctx
 * @param {string} id
 * @param {string} name
 * @param {object} user
 * @param {object} [body]
 * @return {!Promise<object>}
 */
async function ok(ctx, id, name, user, body = {}) {
  const res = await command(ctx, id, name, user, body);
  expect(res.statusCode, `${name}: ${res.body}`).to.equal(200);
  return res.json();
}

/**
 * Everything a command could have changed on a B/L: its title, its chain, its versions and the
 * title events published. A refused command leaves it as it was.
 * @param {object} ctx
 * @param {string} id
 * @return {!Promise<object>}
 */
async function footprint(ctx, id) {
  return {
    title: await ctx.repo.getTitle(id),
    chain: await ctx.repo.listTitleEntries(id),
    versions: await ctx.repo.listVersions(id),
    events: ctx.published.filter(e => e.type.startsWith('records.title.'))
      .length,
  };
}

/**
 * Expects a refused command: its status, the refusal's code and the pack's reason, and nothing
 * recorded.
 * @param {object} ctx
 * @param {string} id
 * @param {function(): !Promise<object>} attempt runs the command: its answer
 * @param {{status: number, code: string, message?: string}} expected
 * @return {!Promise<void>}
 */
async function expectRefused(ctx, id, attempt, {status, code, message}) {
  const before = await footprint(ctx, id);
  const res = await attempt();
  expect(res.statusCode, res.body).to.equal(status);
  expect(res.json().details.code).to.equal(code);
  if (message !== undefined) {
    expect(res.json().message).to.equal(message);
  }
  expect(await footprint(ctx, id)).to.deep.equal(before);
}

/**
 * Issues a negotiable B/L and has the shipper endorse it in blank to bank A: its id. Bank A is
 * then the holder of a blank-endorsed B/L, the shipper a past holder.
 * @param {object} ctx
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function blankToBankA(ctx, reference) {
  const id = await committedBl(ctx, reference);
  await ok(ctx, id, 'issue', staffOf(CARRIER));
  await ok(ctx, id, 'endorse', staffOf(SHIPPER), {to: BANK_A, inBlank: true});
  return id;
}

for (const store of stores()) {
  describe(`blank endorsement and transfer of possession (CB-37), ${store.name}`, () => {
    let ctx;
    let identity;
    beforeEach(async () => {
      identity = standInIdentity();
      ctx = await makeHttp(store, {
        signer: await createLocalSigner(),
        audit: NOTHING_ANCHORED,
        organisations: identity,
      });
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('the mixed journey (Done when 2)', () => {
      /**
       * Runs issue → blank to bank A → transfer to bank B → named to the buyer → surrender →
       * release, each step by the organisation that may run it: each step's answer.
       * @param {string} id
       * @return {!Promise<!Array<object>>}
       */
      async function mixedJourney(id) {
        return [
          await ok(ctx, id, 'issue', staffOf(CARRIER)),
          await ok(ctx, id, 'endorse', staffOf(SHIPPER), {
            to: BANK_A,
            inBlank: true,
          }),
          await ok(ctx, id, 'transfer', staffOf(BANK_A), {to: BANK_B}),
          await ok(ctx, id, 'endorse', staffOf(BANK_B), {
            to: BUYER,
            inBlank: false,
          }),
          await ok(ctx, id, 'surrender', staffOf(BUYER)),
          await ok(ctx, id, 'release', staffOf(CARRIER)),
        ];
      }

      it('moves the title step by step: holder, state and endorsement after each command', async () => {
        const id = await committedBl(ctx, nextReference('MIX'));
        const steps = await mixedJourney(id);
        expect(
          steps.map(s => [s.title.state, s.title.holder, s.title.endorsement]),
        ).to.deep.equal([
          ['issued', SHIPPER, 'none'],
          ['with-holder', BANK_A, 'blank'],
          ['with-holder', BANK_B, 'blank'],
          ['with-holder', BUYER, 'named'],
          ['surrendered', CARRIER, 'named'],
          ['accomplished', null, 'named'],
        ]);
      });

      it('records the chain of title: commands, from and to, the acting organisation and the endorsement of each entry', async () => {
        const id = await committedBl(ctx, nextReference('MIX'));
        const steps = await mixedJourney(id);
        const chain = steps.at(-1).chain;
        expect(chain.map(e => e.command)).to.deep.equal([
          'issue',
          'endorse',
          'transfer',
          'endorse',
          'surrender',
          'release',
        ]);
        expect(chain.map(e => [e.from, e.to])).to.deep.equal([
          [null, SHIPPER],
          [SHIPPER, BANK_A],
          [BANK_A, BANK_B],
          [BANK_B, BUYER],
          [BUYER, CARRIER],
          [CARRIER, null],
        ]);
        expect(chain.map(e => e.actor.org)).to.deep.equal([
          CARRIER,
          SHIPPER,
          BANK_A,
          BANK_B,
          BUYER,
          CARRIER,
        ]);
        expect(chain.map(e => e.endorsement)).to.deep.equal([
          'none',
          'blank',
          'blank',
          'named',
          'named',
          'named',
        ]);
      });

      it('gives a chain that verifies, every entry signed with the platform key', async () => {
        const id = await committedBl(ctx, nextReference('MIX'));
        await mixedJourney(id);
        const entries = await ctx.repo.listTitleEntries(id);
        const keys = (
          await ctx.app.inject({url: '/records/title/keys'})
        ).json();
        const checked = await verifyTitleChain(entries, keys);
        expect(checked.valid, JSON.stringify(checked)).to.equal(true);
        expect(entries).to.have.length(6);
        for (const entry of entries) {
          expect(entry.signature.split('.'), `seq ${entry.seq}`).to.have.length(
            3,
          );
        }
      });

      it('publishes every entry for the audit trail and its anchoring: one records.title.<command> event each, with the signed entry', async () => {
        const id = await committedBl(ctx, nextReference('MIX'));
        await mixedJourney(id);
        const entries = await ctx.repo.listTitleEntries(id);
        const events = ctx.published.filter(e =>
          e.type.startsWith('records.title.'),
        );
        expect(events.map(e => e.type)).to.deep.equal([
          'records.title.issue',
          'records.title.endorse',
          'records.title.transfer',
          'records.title.endorse',
          'records.title.surrender',
          'records.title.release',
        ]);
        expect(events.map(e => e.data.entry)).to.deep.equal(
          JSON.parse(JSON.stringify(entries)),
        );
      });

      it("gives a title proof whose chain verifies with the bundle's own keys, the anchor pending until the trail is anchored", async () => {
        const id = await committedBl(ctx, nextReference('MIX'));
        await mixedJourney(id);
        for (const org of [CARRIER, BANK_A, BUYER]) {
          const res = await ctx.app.inject({
            method: 'GET',
            url: `/records/${id}/title/proof`,
            headers: ctx.as(staffOf(org)),
          });
          expect(res.statusCode, `${org}: ${res.body}`).to.equal(200);
          const bundle = res.json();
          expect(bundle.format).to.equal('lrfe-title-proof/1');
          expect(bundle.entries.map(e => e.command)).to.deep.equal([
            'issue',
            'endorse',
            'transfer',
            'endorse',
            'surrender',
            'release',
          ]);
          const checked = await verifyTitleChain(bundle.entries, bundle.jwks);
          expect(checked.valid, org).to.equal(true);
          expect(bundle.anchor).to.deep.include({pending: true});
        }
      });
    });

    describe('the endorsee is never written into the stored document (Done when 3)', () => {
      it('adds no version and keeps the document and its hash through the whole journey; every entry names that hash', async () => {
        const id = await committedBl(ctx, nextReference('HASH'));
        const record = await ctx.repo.getRecord(id);
        const versions = structuredClone(await ctx.repo.listVersions(id));
        const hash = billOfLadingHash((await ctx.repo.getVersion(id, 1)).data);
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        await ok(ctx, id, 'endorse', staffOf(SHIPPER), {
          to: BANK_A,
          inBlank: true,
        });
        await ok(ctx, id, 'transfer', staffOf(BANK_A), {to: BANK_B});
        await ok(ctx, id, 'endorse', staffOf(BANK_B), {
          to: BUYER,
          inBlank: false,
        });
        expect(await ctx.repo.listVersions(id)).to.deep.equal(versions);
        expect((await ctx.repo.getRecord(id)).currentVersion).to.equal(
          record.currentVersion,
        );
        const stored = (await ctx.repo.getVersion(id, 1)).data;
        expect(billOfLadingHash(stored)).to.equal(hash);
        expect(stored.document.documentParties).to.not.have.property(
          'endorsee',
        );
        const entries = await ctx.repo.listTitleEntries(id);
        expect(entries.map(e => e.documentHash)).to.deep.equal(
          entries.map(() => hash),
        );
      });

      it("writes the DCSA document out with the chain's endorsee: none after the blank endorsement and the transfer, the buyer after the named endorsement", async () => {
        const id = await committedBl(ctx, nextReference('DCSA'));
        const dcsa = FORMATS['dcsa-3.0'];
        const steps = [
          ['issue', CARRIER, {}],
          ['endorse', SHIPPER, {to: BANK_A, inBlank: true}],
          ['transfer', BANK_A, {to: BANK_B}],
          ['endorse', BANK_B, {to: BUYER, inBlank: false}],
          ['surrender', BUYER, {}],
        ];
        const written = [];
        for (const [name, org, body] of steps) {
          const view = await ok(ctx, id, name, staffOf(org), body);
          const endorsee = endorseeOf(view.chain);
          const out = dcsa.fromModel((await ctx.repo.getVersion(id, 1)).data, {
            status: 'ISSUED',
            endorsee: endorsee === BUYER ? BUYER_PARTY : null,
          });
          written.push([endorsee, out.documentParties.endorsee ?? null]);
        }
        expect(written).to.deep.equal([
          [null, null],
          [null, null],
          [null, null],
          [BUYER, BUYER_PARTY],
          [BUYER, BUYER_PARTY],
        ]);
      });
    });

    describe('any later holder may endorse a blank-endorsed B/L to a name again', () => {
      it('the holder of a blank-endorsed B/L may transfer it or endorse it, to a name or in blank', async () => {
        const id = await blankToBankA(ctx, nextReference('LIST'));
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: ctx.as(staffOf(BANK_A)),
        });
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().allowedCommands).to.include.members([
          'endorse',
          'transfer',
        ]);
      });

      it('the blank endorsee endorses it to a name: the B/L is then endorsed to that organisation', async () => {
        const id = await blankToBankA(ctx, nextReference('NAME-A'));
        const view = await ok(ctx, id, 'endorse', staffOf(BANK_A), {
          to: BUYER,
          inBlank: false,
        });
        expect([view.title.holder, view.title.endorsement]).to.deep.equal([
          BUYER,
          'named',
        ]);
      });

      it('a holder by transfer endorses it to a name', async () => {
        const id = await blankToBankA(ctx, nextReference('NAME-B'));
        await ok(ctx, id, 'transfer', staffOf(BANK_A), {to: BANK_B});
        const view = await ok(ctx, id, 'endorse', staffOf(BANK_B), {
          to: BUYER,
          inBlank: false,
        });
        expect([view.title.holder, view.title.endorsement]).to.deep.equal([
          BUYER,
          'named',
        ]);
      });

      it('once endorsed to a name, the holder is no longer offered transfer', async () => {
        const id = await blankToBankA(ctx, nextReference('NAMED-LIST'));
        const view = await ok(ctx, id, 'endorse', staffOf(BANK_A), {
          to: BUYER,
          inBlank: false,
        });
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title`,
          headers: ctx.as(staffOf(BUYER)),
        });
        expect(res.json().allowedCommands).to.include('endorse');
        expect(res.json().allowedCommands).to.not.include('transfer');
        expect(view.title.holder).to.equal(BUYER);
      });
    });

    describe('refusals (Done when 1)', () => {
      it('a transfer of a B/L endorsed to a name is refused 409 with the reason, nothing recorded', async () => {
        const id = await blankToBankA(ctx, nextReference('T-NAMED'));
        await ok(ctx, id, 'endorse', staffOf(BANK_A), {
          to: BUYER,
          inBlank: false,
        });
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'transfer', staffOf(BUYER), {to: BANK_B}),
          {
            status: 409,
            code: 'not-endorsed-in-blank',
            message: TITLE_WORDING.notEndorsedInBlank('named'),
          },
        );
      });

      it('a transfer of a B/L not endorsed yet is refused 409 with the reason, nothing recorded', async () => {
        const id = await committedBl(ctx, nextReference('T-NONE'));
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'transfer', staffOf(SHIPPER), {to: BANK_A}),
          {
            status: 409,
            code: 'not-endorsed-in-blank',
            message: TITLE_WORDING.notEndorsedInBlank('none'),
          },
        );
      });

      it('a blank endorsement by a past holder is refused 403, nothing recorded', async () => {
        const id = await blankToBankA(ctx, nextReference('B-PAST'));
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'endorse', staffOf(SHIPPER), {
              to: BANK_B,
              inBlank: true,
            }),
          {
            status: 403,
            code: 'not-holder',
            message: TITLE_WORDING.notHolder('endorse'),
          },
        );
      });

      it('a blank endorsement by the carrier is refused 403, nothing recorded', async () => {
        const id = await committedBl(ctx, nextReference('B-CARRIER'));
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'endorse', staffOf(CARRIER), {
              to: BANK_A,
              inBlank: true,
            }),
          {
            status: 403,
            code: 'not-holder',
            message: TITLE_WORDING.notHolder('endorse'),
          },
        );
      });

      it('a transfer by a past holder is refused 403, nothing recorded', async () => {
        const id = await blankToBankA(ctx, nextReference('T-PAST'));
        await ok(ctx, id, 'transfer', staffOf(BANK_A), {to: BANK_B});
        for (const past of [SHIPPER, BANK_A]) {
          await expectRefused(
            ctx,
            id,
            () => command(ctx, id, 'transfer', staffOf(past), {to: BUYER}),
            {
              status: 403,
              code: 'not-holder',
              message: TITLE_WORDING.notHolder('transfer'),
            },
          );
        }
      });

      it('a transfer by the carrier is refused 403, nothing recorded', async () => {
        const id = await blankToBankA(ctx, nextReference('T-CARRIER'));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'transfer', staffOf(CARRIER), {to: BUYER}),
          {
            status: 403,
            code: 'not-holder',
            message: TITLE_WORDING.notHolder('transfer'),
          },
        );
      });

      for (const [label, to] of [
        ['not registered', UNKNOWN],
        ['not active', SUSPENDED],
      ]) {
        it(`a blank endorsement to an organisation ${label} is refused 422, nothing recorded`, async () => {
          const id = await committedBl(ctx, nextReference('B-REG'));
          await ok(ctx, id, 'issue', staffOf(CARRIER));
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'endorse', staffOf(SHIPPER), {
                to,
                inBlank: true,
              }),
            {status: 422, code: 'unregistered-organisation'},
          );
          expect(identity.asked).to.include(to);
        });

        it(`a transfer to an organisation ${label} is refused 422, nothing recorded`, async () => {
          const id = await blankToBankA(ctx, nextReference('T-REG'));
          await expectRefused(
            ctx,
            id,
            () => command(ctx, id, 'transfer', staffOf(BANK_A), {to}),
            {status: 422, code: 'unregistered-organisation'},
          );
          expect(identity.asked).to.include(to);
        });

        it(`a later holder's named endorsement to an organisation ${label} is refused 422, nothing recorded`, async () => {
          const id = await blankToBankA(ctx, nextReference('N-REG'));
          await ok(ctx, id, 'transfer', staffOf(BANK_A), {to: BANK_B});
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'endorse', staffOf(BANK_B), {
                to,
                inBlank: false,
              }),
            {status: 422, code: 'unregistered-organisation'},
          );
        });
      }

      it('the name of an object property as `to` is an organisation not registered (422), never a crash', async () => {
        const id = await blankToBankA(ctx, nextReference('T-PROTO'));
        for (const to of ['toString', '__proto__', 'constructor']) {
          const res = await command(ctx, id, 'transfer', staffOf(BANK_A), {
            to,
          });
          expect(res.statusCode, `${to}: ${res.body}`).to.equal(422);
        }
        expect((await ctx.repo.getTitle(id)).holder).to.equal(BANK_A);
      });
    });

    describe('switching a blank-endorsed B/L to paper (Done when 4)', () => {
      for (const [label, body] of [
        ['without confirmBearer', {}],
        ['with confirmBearer false', {confirmBearer: false}],
      ]) {
        it(`is refused 409 ${label}, with the pack's warning, nothing recorded`, async () => {
          const id = await blankToBankA(ctx, nextReference('PAPER'));
          await expectRefused(
            ctx,
            id,
            () => command(ctx, id, 'switch-to-paper', staffOf(BANK_A), body),
            {
              status: 409,
              code: 'bearer-unconfirmed',
              message: TITLE_WORDING.bearerUnconfirmed,
            },
          );
        });
      }

      it('is refused the same way after a transfer', async () => {
        const id = await blankToBankA(ctx, nextReference('PAPER-T'));
        await ok(ctx, id, 'transfer', staffOf(BANK_A), {to: BANK_B});
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'switch-to-paper', staffOf(BANK_B)),
          {
            status: 409,
            code: 'bearer-unconfirmed',
            message: TITLE_WORDING.bearerUnconfirmed,
          },
        );
      });

      it('succeeds with confirmBearer true: switched to paper, no holder, one more signed entry', async () => {
        const id = await blankToBankA(ctx, nextReference('PAPER-OK'));
        const view = await ok(ctx, id, 'switch-to-paper', staffOf(BANK_A), {
          confirmBearer: true,
        });
        expect([view.title.state, view.title.holder]).to.deep.equal([
          'switched-to-paper',
          null,
        ]);
        expect(view.chain.map(e => e.command)).to.deep.equal([
          'issue',
          'endorse',
          'switch-to-paper',
        ]);
        expect(view.allowedCommands).to.deep.equal([]);
      });

      it('a confirmBearer that is not a boolean (a text) is refused 400 by the request check, the title unchanged', async () => {
        const id = await blankToBankA(ctx, nextReference('PAPER-TXT'));
        const res = await command(ctx, id, 'switch-to-paper', staffOf(BANK_A), {
          confirmBearer: 'yes',
        });
        expect(res.statusCode, res.body).to.equal(400);
        expect((await ctx.repo.getTitle(id)).state).to.equal('with-holder');
      });
    });
  });
}
