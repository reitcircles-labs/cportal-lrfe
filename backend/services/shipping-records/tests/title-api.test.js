import {AppError, createLocalSigner} from '@lrfe/common';
import {billOfLadingHash} from '@lrfe/domain-shipping/bill-of-lading';
import {expect} from 'chai';

import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-34: the title engine's API. The title commands are calls of shipping-records,
 * POST /records/:id/title/:command (issue, void, endorse, transfer, surrender, release, deliver,
 * switch-to-paper), and GET /records/:id/title reads a B/L's title, the commands the caller may run
 * on it and its chain of title. The caller's organisation always comes from the session, never
 * from the request. Who sees a title: the carrier, the current holder, past holders and the
 * consignee; anyone else gets 404 "B/L not found", for reads and commands alike, before any
 * refusal that would tell the B/L's state. A refused command writes nothing and publishes nothing.
 * The organisation a B/L goes to, and the shipper of an issue, must be registered and active
 * (identity's answer, a stand-in here).
 *
 * Interfaces chosen for the builder (the design leaves them open):
 * - The read and every command's answer: {recordId, title, allowedCommands, chain}: `title` as
 *   CB-31 reads it (null before issue), `allowedCommands` only the commands this API offers,
 *   `chain` the B/L's chain-of-title entries as stored (CB-32), [] before issue.
 * - A command's body: {to?, inBlank?, confirmBearer?}; anything else in it (an `organisation`,
 *   an `actor`, a `kind`) is ignored.
 * - Permissions: issue, void, release, deliver need bl.issue; endorse, transfer, surrender,
 *   switch-to-paper need bl.endorse; the read needs bl.read. A user of no organisation: 403.
 * - Unknown command: 400 {details.code: 'unknown-command'}, "Unknown command: <name>". amend,
 *   split and surrender-for-amendment are offered since CB-35 (title-amend-split.test.js).
 * - An organisation not registered, or not active: 422 {details.code:
 *   'unregistered-organisation'}; identity not answering: 503. The title service's option
 *   `organisations` is the client: standingOf(id) → 'active' | 'inactive' | 'unknown'.
 */

/** The organisations of the tests: the carrier owns the B/Ls. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const CONSIGNEE = 'org-consignee';
const STRANGER = 'org-stranger';
const SUSPENDED = 'org-suspended';
const UNKNOWN = 'org-unknown';

/** Every B/L permission, as the demo role bld has them after CB-34. */
const ALL_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/** The refusal texts of the engine (TITLE_WORDING, docs/title-states.md). */
const ONLY_HOLDER_ENDORSES = 'Only the current holder may endorse this B/L';
const ONLY_CARRIER_RELEASES =
  'Only the carrier that issued this B/L may release it';

/** How many references nextReference gave. */
let references = 0;

/**
 * A new transport document reference, so each B/L of a test is new (DCSA allows 20 characters).
 * @param {string} label
 * @return {string}
 */
function nextReference(label) {
  references += 1;
  return `CB34-${label}-${references}`;
}

/**
 * A person of an organisation, with the B/L permissions given (all by default).
 * @param {string} org
 * @param {!Array<string>} [perms]
 * @return {{id: string, name: string, org: string, perms: !Array<string>}}
 */
function staffOf(org, perms = ALL_PERMS) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org, perms};
}

/**
 * Identity as the title service's client sees it: whether an organisation is registered and
 * active. `asked` lists the ids asked about; `down` makes every call fail as when identity cannot
 * be reached; `meanwhile`, when set, runs once before the next answer (something landing while a
 * command waits on identity, after it has read the B/L and before it writes).
 * @return {{
 *   standingOf: function(string): !Promise<string>,
 *   asked: !Array<string>,
 *   down: boolean,
 *   meanwhile: ?function(): !Promise<*>,
 * }}
 */
function standInIdentity() {
  const standings = new Map([
    [CARRIER, 'active'],
    [SHIPPER, 'active'],
    [BANK, 'active'],
    [BUYER, 'active'],
    [CONSIGNEE, 'active'],
    [STRANGER, 'active'],
    [SUSPENDED, 'inactive'],
  ]);
  const identity = {
    asked: [],
    down: false,
    meanwhile: null,
    async standingOf(id) {
      identity.asked.push(id);
      if (identity.meanwhile !== null) {
        const meanwhile = identity.meanwhile;
        identity.meanwhile = null;
        await meanwhile();
      }
      if (identity.down) {
        throw new AppError(503, 'The identity service cannot be reached');
      }
      return standings.get(id) ?? 'unknown';
    },
  };
  return identity;
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
 * A B/L of the carrier with its first version committed: its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} reference
 * @param {{straight?: boolean, shipper?: string}} [options] a straight B/L (its consignee
 *     linked), and the shipper's organisation (SHIPPER by default)
 * @return {!Promise<string>}
 */
async function committedBl(
  ctx,
  reference,
  {straight = false, shipper = SHIPPER} = {},
) {
  const partyOrganisations = {shipper};
  if (straight) {
    partyOrganisations.consignee = CONSIGNEE;
  }
  const record = await ctx.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: documentOf(reference, straight),
      partyOrganisations,
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
 * @param {string} name the command, as it goes in the path
 * @param {?object} user the caller, null for no token
 * @param {object} [body] the command's arguments
 * @return {!Promise<object>}
 */
function command(ctx, id, name, user, body = {}) {
  const headers = user ? ctx.as(user) : {};
  return ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/title/${name}`,
    headers,
    payload: body,
  });
}

/**
 * Reads a B/L's title over HTTP as a user: the raw answer.
 * @param {object} ctx
 * @param {string} id
 * @param {?object} user the caller, null for no token
 * @return {!Promise<object>}
 */
function read(ctx, id, user) {
  const headers = user ? ctx.as(user) : {};
  return ctx.app.inject({
    method: 'GET',
    url: `/records/${id}/title`,
    headers,
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
 * Everything a command could have changed on a B/L: its title, its chain and the title events
 * published. A refused command leaves it as it was.
 * @param {object} ctx
 * @param {string} id
 * @return {!Promise<object>}
 */
async function footprint(ctx, id) {
  return {
    title: await ctx.repo.getTitle(id),
    chain: await ctx.repo.listTitleEntries(id),
    events: ctx.published.filter(e => e.type.startsWith('records.title.'))
      .length,
  };
}

/**
 * Issues a negotiable B/L to the shipper and has the shipper endorse it to the bank: its id. The
 * shipper is then a past holder, the bank the holder.
 * @param {object} ctx
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function endorsedToBank(ctx, reference) {
  const id = await committedBl(ctx, reference);
  await ok(ctx, id, 'issue', staffOf(CARRIER));
  await ok(ctx, id, 'endorse', staffOf(SHIPPER), {to: BANK, inBlank: false});
  return id;
}

for (const store of stores()) {
  describe(`the title engine's API (CB-34), ${store.name}`, () => {
    let ctx;
    let identity;
    beforeEach(async () => {
      identity = standInIdentity();
      ctx = await makeHttp(store, {
        signer: await createLocalSigner(),
        organisations: identity,
      });
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('the negotiable journey (Done when 1)', () => {
      it('runs issue, endorse to the bank, the bank endorses to the buyer, the buyer surrenders, the carrier releases', async () => {
        const id = await committedBl(ctx, 'CB34-JOURNEY');

        const issued = await ok(ctx, id, 'issue', staffOf(CARRIER));
        expect([
          issued.title.state,
          issued.title.holder,
          issued.title.carrier,
        ]).to.deep.equal(['issued', SHIPPER, CARRIER]);

        const toBank = await ok(ctx, id, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: false,
        });
        expect([
          toBank.title.state,
          toBank.title.holder,
          toBank.title.endorsement,
        ]).to.deep.equal(['with-holder', BANK, 'named']);

        const toBuyer = await ok(ctx, id, 'endorse', staffOf(BANK), {
          to: BUYER,
          inBlank: false,
        });
        expect([toBuyer.title.state, toBuyer.title.holder]).to.deep.equal([
          'with-holder',
          BUYER,
        ]);

        const surrendered = await ok(ctx, id, 'surrender', staffOf(BUYER));
        expect([
          surrendered.title.state,
          surrendered.title.holder,
        ]).to.deep.equal(['surrendered', CARRIER]);

        const released = await ok(ctx, id, 'release', staffOf(CARRIER));
        expect([released.title.state, released.title.holder]).to.deep.equal([
          'accomplished',
          null,
        ]);

        const res = await read(ctx, id, staffOf(CARRIER));
        expect(res.statusCode, res.body).to.equal(200);
        const view = res.json();
        expect(view.chain.map(e => e.command)).to.deep.equal([
          'issue',
          'endorse',
          'endorse',
          'surrender',
          'release',
        ]);
        expect(view.chain.map(e => [e.from, e.to])).to.deep.equal([
          [null, SHIPPER],
          [SHIPPER, BANK],
          [BANK, BUYER],
          [BUYER, CARRIER],
          [CARRIER, null],
        ]);
        expect(view.chain.map(e => e.actor.org)).to.deep.equal([
          CARRIER,
          SHIPPER,
          BANK,
          BUYER,
          CARRIER,
        ]);
        expect(view.allowedCommands).to.deep.equal([]);
        const types = ctx.published
          .filter(e => e.type.startsWith('records.title.'))
          .map(e => e.type);
        expect(types).to.deep.equal([
          'records.title.issue',
          'records.title.endorse',
          'records.title.endorse',
          'records.title.surrender',
          'records.title.release',
        ]);
      });

      it('answers a command with the title as GET /records/:id/title reads it for the caller', async () => {
        const id = await committedBl(ctx, 'CB34-ANSWER');
        const answer = await ok(ctx, id, 'issue', staffOf(CARRIER));
        const res = await read(ctx, id, staffOf(CARRIER));
        expect(res.statusCode, res.body).to.equal(200);
        expect(answer).to.deep.equal(res.json());
      });
    });

    describe('the other commands', () => {
      it('issues a B/L from its committed version: the kind from the document, the carrier from the session, the shipper as first holder', async () => {
        const id = await committedBl(ctx, 'CB34-ISSUE');
        const view = await ok(ctx, id, 'issue', staffOf(CARRIER));
        const version = await ctx.repo.getVersion(id, 1);
        expect(view.recordId).to.equal(id);
        expect(view.title).to.include({
          kind: 'negotiable',
          state: 'issued',
          carrier: CARRIER,
          holder: SHIPPER,
          endorsement: 'none',
          issuedVersion: 1,
          documentHash: billOfLadingHash(version.data),
          revision: 1,
        });
        expect(view.chain).to.have.length(1);
      });

      it('voids an issued B/L, as the carrier', async () => {
        const id = await committedBl(ctx, 'CB34-VOID');
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        const view = await ok(ctx, id, 'void', staffOf(CARRIER));
        expect(view.title.state).to.equal('void');
      });

      it('delivers a straight B/L to its consignee, as the carrier', async () => {
        const id = await committedBl(ctx, 'CB34-DELIVER', {straight: true});
        const issued = await ok(ctx, id, 'issue', staffOf(CARRIER));
        expect([
          issued.title.kind,
          issued.title.holder,
          issued.title.consignee,
        ]).to.deep.equal(['straight', null, CONSIGNEE]);
        const view = await ok(ctx, id, 'deliver', staffOf(CARRIER));
        expect(view.title.state).to.equal('delivered');
      });

      it('switches a B/L to paper, as its holder', async () => {
        const id = await endorsedToBank(ctx, 'CB34-PAPER');
        const view = await ok(ctx, id, 'switch-to-paper', staffOf(BANK), {
          confirmBearer: false,
        });
        expect([view.title.state, view.title.holder]).to.deep.equal([
          'switched-to-paper',
          null,
        ]);
      });

      it('endorses in blank and transfers the B/L to a registered organisation', async () => {
        const id = await committedBl(ctx, 'CB34-TRANSFER');
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        const blank = await ok(ctx, id, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: true,
        });
        expect(blank.title.endorsement).to.equal('blank');
        const view = await ok(ctx, id, 'transfer', staffOf(BANK), {
          to: BUYER,
        });
        expect([view.title.holder, view.title.endorsement]).to.deep.equal([
          BUYER,
          'blank',
        ]);
      });
    });

    describe('reading a title', () => {
      it('before issue: no title, no chain, and issue for the carrier that owns the B/L', async () => {
        const id = await committedBl(ctx, 'CB34-READ-BEFORE');
        const res = await read(ctx, id, staffOf(CARRIER));
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json()).to.deep.equal({
          recordId: id,
          title: null,
          allowedCommands: ['issue'],
          chain: [],
        });
      });

      it('gives the state, holder, endorsement, the commands the caller may run now and the signed chain', async () => {
        const id = await endorsedToBank(ctx, 'CB34-READ-FIELDS');
        const res = await read(ctx, id, staffOf(BANK));
        expect(res.statusCode, res.body).to.equal(200);
        const view = res.json();
        expect(view.title).to.include({
          state: 'with-holder',
          holder: BANK,
          endorsement: 'named',
          carrier: CARRIER,
        });
        expect(view.allowedCommands).to.include.members([
          'endorse',
          'surrender',
          'switch-to-paper',
        ]);
        expect(view.allowedCommands).to.not.include('release');
        const stored = await ctx.repo.listTitleEntries(id);
        expect(view.chain).to.deep.equal(JSON.parse(JSON.stringify(stored)));
        for (const entry of view.chain) {
          expect(entry.entryHash).to.match(/^[0-9a-f]{64}$/);
          expect(entry.signature.split('.')).to.have.length(3);
        }
      });

      // (changed: CB-35) amendment and split are offered now: title-amend-split.test.js lists them.

      it("lists only the commands the user's permissions allow (added: review, permissions besides the organisation's role)", async () => {
        const before = await committedBl(ctx, 'CB34-READ-PERMS-1');
        const reader = await read(ctx, before, staffOf(CARRIER, ['bl.read']));
        expect(reader.statusCode, reader.body).to.equal(200);
        expect(reader.json().allowedCommands).to.deep.equal([]);
        const endorser = await read(
          ctx,
          before,
          staffOf(CARRIER, ['bl.read', 'bl.endorse']),
        );
        expect(endorser.json().allowedCommands).to.deep.equal([]);

        const id = await endorsedToBank(ctx, 'CB34-READ-PERMS-2');
        const holderReader = await read(ctx, id, staffOf(BANK, ['bl.read']));
        expect(holderReader.json().allowedCommands).to.deep.equal([]);
        const holderIssuer = await read(
          ctx,
          id,
          staffOf(BANK, ['bl.read', 'bl.issue']),
        );
        expect(holderIssuer.json().allowedCommands).to.deep.equal([]);
        const holderEndorser = await read(
          ctx,
          id,
          staffOf(BANK, ['bl.read', 'bl.endorse']),
        );
        expect(holderEndorser.json().allowedCommands).to.include.members([
          'endorse',
          'surrender',
        ]);
        const answer = await ok(
          ctx,
          id,
          'endorse',
          staffOf(BANK, ['bl.endorse', 'bl.read']),
          {
            to: BUYER,
            inBlank: false,
          },
        );
        expect(answer.allowedCommands).to.deep.equal([]);
      });

      it('the carrier, the current holder and a past holder read it; only the holder may move it', async () => {
        const id = await endorsedToBank(ctx, 'CB34-READ-PARTIES');
        const carrier = await read(ctx, id, staffOf(CARRIER));
        const holder = await read(ctx, id, staffOf(BANK));
        const past = await read(ctx, id, staffOf(SHIPPER));
        for (const res of [carrier, holder, past]) {
          expect(res.statusCode, res.body).to.equal(200);
          expect(res.json().title.holder).to.equal(BANK);
        }
        expect(past.json().allowedCommands).to.deep.equal([]);
        expect(carrier.json().allowedCommands).to.not.include('endorse');
      });

      it('a past holder still reads it once the B/L has moved on twice', async () => {
        const id = await endorsedToBank(ctx, 'CB34-READ-PAST');
        await ok(ctx, id, 'endorse', staffOf(BANK), {
          to: BUYER,
          inBlank: false,
        });
        for (const org of [SHIPPER, BANK]) {
          const res = await read(ctx, id, staffOf(org));
          expect(res.statusCode, `${org}: ${res.body}`).to.equal(200);
          expect(res.json().title.holder).to.equal(BUYER);
        }
      });

      it('the consignee of a straight B/L reads it', async () => {
        const id = await committedBl(ctx, 'CB34-READ-CONSIGNEE', {
          straight: true,
        });
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        const res = await read(ctx, id, staffOf(CONSIGNEE));
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().title.consignee).to.equal(CONSIGNEE);
      });

      it('any other organisation gets 404 "B/L not found", before and after issue, and for a B/L that does not exist', async () => {
        const id = await endorsedToBank(ctx, 'CB34-READ-STRANGER');
        const notIssued = await committedBl(ctx, 'CB34-READ-STRANGER-2');
        const missing = '00000000-0000-4000-8000-000000000000';
        for (const target of [id, notIssued, missing]) {
          const res = await read(ctx, target, staffOf(STRANGER));
          expect(res.statusCode, res.body).to.equal(404);
          expect(res.json().message).to.equal('B/L not found');
        }
        // before issue only the carrier that owns it sees it, not its future shipper
        const shipper = await read(ctx, notIssued, staffOf(SHIPPER));
        expect(shipper.statusCode, shipper.body).to.equal(404);
      });

      it('without a token: 401; without bl.read: 403', async () => {
        const id = await endorsedToBank(ctx, 'CB34-READ-AUTH');
        expect((await read(ctx, id, null)).statusCode).to.equal(401);
        const res = await read(ctx, id, staffOf(BANK, ['bl.draft']));
        expect(res.statusCode, res.body).to.equal(403);
      });
    });

    describe('a command by an organisation that may not run it (Done when 2)', () => {
      it("a past holder's endorsement is refused 403 with the engine's reason, and nothing is recorded", async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-PAST');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'endorse', staffOf(SHIPPER), {
          to: BUYER,
          inBlank: false,
        });
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().message).to.equal(ONLY_HOLDER_ENDORSES);
        expect(res.json().details.code).to.equal('not-holder');
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it("the carrier's endorsement is refused 403: only the current holder endorses", async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-CARRIER');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'endorse', staffOf(CARRIER), {
          to: BUYER,
          inBlank: false,
        });
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().message).to.equal(ONLY_HOLDER_ENDORSES);
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it("the holder's release is refused 403: only the carrier releases", async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-RELEASE');
        await ok(ctx, id, 'surrender', staffOf(BANK));
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'release', staffOf(BANK));
        expect(res.statusCode, res.body).to.equal(403);
        expect(res.json().message).to.equal(ONLY_CARRIER_RELEASES);
        expect(res.json().details.code).to.equal('not-carrier');
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('an organisation that does not see the B/L gets 404 "B/L not found" for every command, even one its state would refuse, and nothing is recorded', async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-STRANGER');
        const before = await footprint(ctx, id);
        const attempts = [
          ['issue', {}],
          ['void', {}],
          ['endorse', {to: STRANGER, inBlank: false}],
          ['transfer', {to: STRANGER}],
          ['surrender', {}],
          ['release', {}],
          ['deliver', {}],
          ['switch-to-paper', {confirmBearer: true}],
        ];
        for (const [name, body] of attempts) {
          const res = await command(ctx, id, name, staffOf(STRANGER), body);
          expect(res.statusCode, `${name}: ${res.body}`).to.equal(404);
          expect(res.json().message, name).to.equal('B/L not found');
        }
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('an organisation that does not see the B/L gets 404 before issue too', async () => {
        const id = await committedBl(ctx, 'CB34-REFUSE-BEFORE');
        const res = await command(ctx, id, 'issue', staffOf(STRANGER));
        expect(res.statusCode, res.body).to.equal(404);
        expect(res.json().message).to.equal('B/L not found');
        expect(await ctx.repo.getTitle(id)).to.equal(null);
      });

      it("a reader's command the state does not allow is refused with the engine's reason (409), nothing recorded", async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-STATE');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'void', staffOf(CARRIER));
        expect(res.statusCode, res.body).to.equal(409);
        expect(res.json().details.code).to.equal('wrong-state');
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('without a token: 401, nothing recorded', async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-TOKEN');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'surrender', null);
        expect(res.statusCode, res.body).to.equal(401);
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('a user of no organisation is refused 403', async () => {
        const id = await endorsedToBank(ctx, 'CB34-REFUSE-NOORG');
        const before = await footprint(ctx, id);
        const user = {id: 'u-x', name: 'Lukas Haufiku', perms: ALL_PERMS};
        const res = await command(ctx, id, 'surrender', user);
        expect(res.statusCode, res.body).to.equal(403);
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });
    });

    describe('the permissions of the shipping pack', () => {
      for (const [name, body] of [
        ['issue', {}],
        ['void', {}],
        ['release', {}],
        ['deliver', {}],
      ]) {
        it(`${name} needs bl.issue: 403 without it`, async () => {
          const id = await committedBl(ctx, nextReference('PERM'));
          const user = staffOf(CARRIER, ['bl.read', 'bl.draft', 'bl.endorse']);
          const res = await command(ctx, id, name, user, body);
          expect(res.statusCode, res.body).to.equal(403);
          expect(await ctx.repo.getTitle(id)).to.equal(null);
        });
      }

      for (const [name, body] of [
        ['endorse', {to: BUYER, inBlank: false}],
        ['transfer', {to: BUYER}],
        ['surrender', {}],
        ['switch-to-paper', {confirmBearer: true}],
      ]) {
        it(`${name} needs bl.endorse: 403 without it`, async () => {
          const id = await endorsedToBank(ctx, nextReference('PERM'));
          const before = await footprint(ctx, id);
          const user = staffOf(BANK, ['bl.read', 'bl.draft', 'bl.issue']);
          const res = await command(ctx, id, name, user, body);
          expect(res.statusCode, res.body).to.equal(403);
          expect(await footprint(ctx, id)).to.deep.equal(before);
        });
      }
    });

    describe('the organisation comes from the session, never from the request', () => {
      it("an organisation or actor in the body is ignored: the command runs as the session's organisation", async () => {
        const id = await committedBl(ctx, 'CB34-SESSION');
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        const view = await ok(ctx, id, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: false,
          organisation: BUYER,
          actor: {id: 'u-forged', name: 'Forged', org: BUYER},
        });
        const entry = view.chain.at(-1);
        expect(entry.actor).to.deep.equal({
          id: staffOf(SHIPPER).id,
          name: staffOf(SHIPPER).name,
          org: SHIPPER,
        });
        expect([entry.from, entry.to]).to.deep.equal([SHIPPER, BANK]);
      });

      it("naming the holder's organisation in the body does not let another organisation in: 404", async () => {
        const id = await endorsedToBank(ctx, 'CB34-SESSION-FORGED');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'surrender', staffOf(STRANGER), {
          organisation: BANK,
          actor: {id: 'u-forged', org: BANK},
        });
        expect(res.statusCode, res.body).to.equal(404);
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('a kind in the body of issue is ignored: the kind is read from the document', async () => {
        const id = await committedBl(ctx, 'CB34-SESSION-KIND');
        const view = await ok(ctx, id, 'issue', staffOf(CARRIER), {
          kind: 'waybill',
        });
        expect(view.title.kind).to.equal('negotiable');
      });
    });

    describe('command names from the request', () => {
      it('an unknown command is refused 400 "Unknown command", nothing recorded', async () => {
        const id = await endorsedToBank(ctx, 'CB34-NAME-UNKNOWN');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'burn', staffOf(BANK));
        expect(res.statusCode, res.body).to.equal(400);
        expect(res.json().message).to.equal('Unknown command: burn');
        expect(res.json().details.code).to.equal('unknown-command');
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      for (const name of [
        'toString',
        '__proto__',
        'constructor',
        'hasOwnProperty',
        'valueOf',
      ]) {
        it(`the name of an object property, ${name}, is an unknown command (400), never a crash`, async () => {
          const id = await endorsedToBank(ctx, nextReference('NAME'));
          const before = await footprint(ctx, id);
          const res = await command(ctx, id, name, staffOf(BANK));
          expect(res.statusCode, res.body).to.equal(400);
          expect(res.json().details.code).to.equal('unknown-command');
          expect(await footprint(ctx, id)).to.deep.equal(before);
        });
      }

      // (changed: CB-35) amend, split and surrender-for-amendment are no longer 400
      // not-available: title-amend-split.test.js.

      it('an endorsement without the organisation to receive it is refused 400, nothing recorded', async () => {
        const id = await endorsedToBank(ctx, 'CB34-NAME-NO-TO');
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'endorse', staffOf(BANK), {
          inBlank: false,
        });
        expect(res.statusCode, res.body).to.equal(400);
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });
    });

    describe('possession moves only between registered, active organisations', () => {
      for (const [label, to] of [
        ['not registered', UNKNOWN],
        ['suspended', SUSPENDED],
      ]) {
        it(`an endorsement to an organisation ${label} is refused 422, nothing recorded`, async () => {
          const id = await endorsedToBank(ctx, nextReference('REG'));
          const before = await footprint(ctx, id);
          const res = await command(ctx, id, 'endorse', staffOf(BANK), {
            to,
            inBlank: false,
          });
          expect(res.statusCode, res.body).to.equal(422);
          expect(res.json().details.code).to.equal('unregistered-organisation');
          expect(res.json().message).to.match(/registered/);
          expect(identity.asked).to.include(to);
          expect(await footprint(ctx, id)).to.deep.equal(before);
        });

        it(`an issue whose shipper is ${label} is refused 422, nothing recorded`, async () => {
          const id = await committedBl(ctx, nextReference('REG'), {
            shipper: to,
          });
          const res = await command(ctx, id, 'issue', staffOf(CARRIER));
          expect(res.statusCode, res.body).to.equal(422);
          expect(res.json().details.code).to.equal('unregistered-organisation');
          expect(res.json().message).to.match(/shipper/i);
          expect(await ctx.repo.getTitle(id)).to.equal(null);
          expect(await ctx.repo.listTitleEntries(id)).to.deep.equal([]);
        });
      }

      it('a transfer to an organisation not registered is refused 422, nothing recorded', async () => {
        const id = await committedBl(ctx, 'CB34-REG-TRANSFER');
        await ok(ctx, id, 'issue', staffOf(CARRIER));
        await ok(ctx, id, 'endorse', staffOf(SHIPPER), {
          to: BANK,
          inBlank: true,
        });
        const before = await footprint(ctx, id);
        const res = await command(ctx, id, 'transfer', staffOf(BANK), {
          to: UNKNOWN,
        });
        expect(res.statusCode, res.body).to.equal(422);
        expect(res.json().details.code).to.equal('unregistered-organisation');
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('while identity cannot answer, the command is refused 503 and nothing is recorded', async () => {
        const id = await endorsedToBank(ctx, 'CB34-REG-DOWN');
        const before = await footprint(ctx, id);
        identity.down = true;
        const res = await command(ctx, id, 'endorse', staffOf(BANK), {
          to: BUYER,
          inBlank: false,
        });
        expect(res.statusCode, res.body).to.equal(503);
        expect(await footprint(ctx, id)).to.deep.equal(before);
      });

      it('an organisation that does not see the B/L gets 404 even naming an unregistered organisation', async () => {
        const id = await endorsedToBank(ctx, 'CB34-REG-STRANGER');
        const res = await command(ctx, id, 'endorse', staffOf(STRANGER), {
          to: UNKNOWN,
          inBlank: false,
        });
        expect(res.statusCode, res.body).to.equal(404);
      });
    });

    describe('issue binds the version current when it is written (CB-31 review)', () => {
      /**
       * The B/L's second version, its draft saved: the document changed.
       * @param {string} id
       * @param {string} reference
       * @return {!Promise<void>}
       */
      async function saveSecondDraft(id, reference) {
        const document = {
          ...documentOf(reference, false),
          termsAndConditions: 'Changed for version 2 (CB-34).',
        };
        await ctx.service.saveDraft(
          id,
          {
            format: 'dcsa-3.0',
            document,
            partyOrganisations: {shipper: SHIPPER},
          },
          drafter,
          CARRIER,
        );
      }

      it('a version committed while the B/L is being issued: the issue is refused 409, never binding the old version (changed: review, made deterministic)', async () => {
        const reference = 'CB34-RACE-COMMIT';
        const id = await committedBl(ctx, reference);
        let landed = false;
        // lands after the issue has read version 1, before it writes the title
        identity.meanwhile = async () => {
          await saveSecondDraft(id, reference);
          await ctx.service.submit(id, 2, drafter, CARRIER);
          await ctx.service.commit(id, 2, {by: approver}, 'bpm');
          landed = true;
        };
        const res = await command(ctx, id, 'issue', staffOf(CARRIER));
        expect(landed).to.equal(true);
        expect(res.statusCode, res.body).to.equal(409);
        expect(res.json().details.code).to.equal('changed-meanwhile');
        expect(await ctx.repo.getTitle(id)).to.equal(null);
        expect(await ctx.repo.listTitleEntries(id)).to.deep.equal([]);
        // issued again, it binds the version current now
        const view = await ok(ctx, id, 'issue', staffOf(CARRIER));
        expect(view.title.issuedVersion).to.equal(2);
        const version = await ctx.repo.getVersion(id, 2);
        expect(view.title.documentHash).to.equal(
          billOfLadingHash(version.data),
        );
        expect(view.chain[0].documentHash).to.equal(view.title.documentHash);
      });

      it('a new version submitted for review while the B/L is being issued: the issue is refused 409 (changed: review, made deterministic)', async () => {
        const reference = 'CB34-RACE-REVIEW';
        const id = await committedBl(ctx, reference);
        let landed = false;
        identity.meanwhile = async () => {
          await saveSecondDraft(id, reference);
          await ctx.service.submit(id, 2, drafter, CARRIER);
          landed = true;
        };
        const res = await command(ctx, id, 'issue', staffOf(CARRIER));
        expect(landed).to.equal(true);
        expect(res.statusCode, res.body).to.equal(409);
        expect(res.json().details.code).to.equal('in-review');
        expect(await ctx.repo.getTitle(id)).to.equal(null);
        expect(await ctx.repo.listTitleEntries(id)).to.deep.equal([]);
      });
    });
  });
}
