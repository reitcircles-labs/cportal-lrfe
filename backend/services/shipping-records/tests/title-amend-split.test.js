import {AppError, createLocalSigner} from '@lrfe/common';
import {billOfLadingHash} from '@lrfe/domain-shipping/bill-of-lading';
import {TITLE_WORDING, modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {verifyTitleChain} from '../src/chain.js';
import {makeHttp, stores} from './helpers.js';
import {
  CONTAINER_A,
  CONTAINER_B,
  OTHER_PORT,
  PARENT_CARGO,
  PARENT_PORT,
  blWithCargo,
  splitBody,
  splitByContainer,
  splitDividingContainer,
  twoContainerBl,
} from './split-documents.js';

/**
 * CB-35: amendment and split into child B/Ls, through the API (POST /records/:id/title/:command,
 * GET /records/:id/title, GET /records/:id/title/proof).
 *
 * Done when:
 * 1. An amendment keeps the holder and the chain, with the new version's hash in its entry.
 * 2. A split closes the parent and issues children whose cargo adds up to the parent's; each
 *    child's chain starts from the parent's last entry and verifies (offline too: the audit
 *    service's title-split-proof.test.js runs verifyTitleProof on a child's bundle).
 * 3. Part of a cargo is never released against a B/L that stays open (partial release refused).
 *
 * Interfaces chosen for the builder (the design leaves them open):
 * - surrender-for-amendment: no arguments; needs bl.endorse. amend and split need bl.issue.
 * - amend's body: {format, document, partyOrganisations?}, as POST /records takes a B/L. The
 *   document is converted and checked like any document (400 with `details.problems` when not
 *   valid; 400 for an unknown format); its carrier code and transport document reference must be
 *   the B/L's (400 `different-reference`); it must stay a B/L to order (400 `kind-changed`).
 *   Without partyOrganisations the new version keeps the current version's.
 * - amend writes version currentVersion + 1, committed by the engine (no four-eyes review: the
 *   holder's surrender-for-amendment is the authority), its seal linked to the version before
 *   (service.verify stays intact) and its `records.record.committed` event published, in the same
 *   transaction as the title and the chain entry. The title's issuedVersion and documentHash are
 *   the new version's; the entry `amend` (from the carrier to returnTo) names the new hash.
 * - split's body: {children: [{format, document}, ...]} (at least two). Each child is a B/L to
 *   order of the same carrier code, with its own reference (not the parent's, not another
 *   child's: 400 `child-reference`; one the carrier already has: 409). Cargo check (400
 *   `cargo-mismatch`): the children name exactly the parent's containers (none missing, none
 *   added; a container may be named by several children when its cargo is divided) and, per
 *   container, their packages (outerPackaging.numberOfPackages) and gross weights add up to the
 *   parent's. Ports of discharge may differ.
 * - split's answer: the parent's view plus `children: [{recordId, recordNo}]`, in the order given.
 * - Each child: a record of the carrier (status committed, version 1 committed by the engine,
 *   its `records.record.committed` event), a title {negotiable, with-holder, holder = returnTo,
 *   endorsement as the parent's, issuedVersion 1, revision 1}, and one chain entry with command
 *   `issue-from-split` (from null, to returnTo, its document's hash), whose previousHash is the
 *   parent's last entryHash (the `split` entry), published as `records.title.issue-from-split`.
 * - A child's title proof carries `parent: {recordId, recordNo, entries}` (the parent's whole
 *   chain), so the child's first entry links offline; a B/L of its own has no `parent`.
 * - Partial release (Done when 3): the B/L is the unit of release. release runs only from
 *   `surrendered` (the whole B/L handed back), and a release body naming part of the cargo
 *   (`containers`, `equipmentReferences`, `cargoItems`, `consignmentItems`, `part`, `quantity`)
 *   is refused 400 `partial-release`, nothing recorded. Releasing part of a cargo means splitting
 *   it into its own B/L first; releasing one child leaves the others and the parent as they are.
 */

/** The organisations of the tests: the carrier owns the B/Ls. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const STRANGER = 'org-stranger';

/** Every B/L permission, as the demo role bld has them. */
const ALL_PERMS = ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'];

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/** The body keys that name part of a cargo: a release with any of them is refused. */
const PARTIAL_RELEASE_BODIES = Object.freeze([
  {containers: [CONTAINER_A]},
  {equipmentReferences: [CONTAINER_A]},
  {cargoItems: [{equipmentReference: CONTAINER_A}]},
  {consignmentItems: [{carrierBookingReference: 'CBR_123_REGULAR'}]},
  {part: 1},
  {quantity: 100},
]);

/** How many references nextReference gave. */
let references = 0;

/**
 * A new transport document reference, so each B/L of a test is new (DCSA allows 20 characters).
 * @param {string} label
 * @return {string}
 */
function nextReference(label) {
  references += 1;
  // (changed: CB-35 build) long labels and counters past 99 went over DCSA's 20 characters; the
  // label is cut so the counter, which makes the reference unique, always fits.
  const suffix = `-${references}`;
  return `CB35-${label}`.slice(0, 20 - suffix.length) + suffix;
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
 * Identity as the title service's client sees it: the organisations of the tests are active.
 * @return {{standingOf: function(string): !Promise<string>}}
 */
function standInIdentity() {
  const active = new Set([CARRIER, SHIPPER, BANK, STRANGER]);
  return {
    async standingOf(id) {
      return active.has(id) ? 'active' : 'unknown';
    },
  };
}

/**
 * The audit service as the title service's client sees it, with nothing anchored yet.
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
 * A B/L to order of the carrier with two containers (split-documents.js), its shipper linked,
 * its first version committed: its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function committedBl(ctx, reference) {
  const record = await ctx.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: twoContainerBl(reference),
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
 * Reads a B/L's title over HTTP as a user: the raw answer.
 * @param {object} ctx
 * @param {string} id
 * @param {object} user
 * @return {!Promise<object>}
 */
function read(ctx, id, user) {
  return ctx.app.inject({
    method: 'GET',
    url: `/records/${id}/title`,
    headers: ctx.as(user),
  });
}

/**
 * Reads a B/L's title proof over HTTP as a user: the raw answer.
 * @param {object} ctx
 * @param {string} id
 * @param {object} user
 * @return {!Promise<object>}
 */
function proof(ctx, id, user) {
  return ctx.app.inject({
    method: 'GET',
    url: `/records/${id}/title/proof`,
    headers: ctx.as(user),
  });
}

/**
 * Everything a command could have changed: the B/L's title, chain and versions, the carrier's
 * records (a split adds some) and every event published. A refused command leaves it as it was.
 * @param {object} ctx
 * @param {string} id
 * @return {!Promise<object>}
 */
async function footprint(ctx, id) {
  return {
    title: await ctx.repo.getTitle(id),
    chain: await ctx.repo.listTitleEntries(id),
    versions: await ctx.repo.listVersions(id),
    records: (await ctx.repo.listRecords({organisationId: CARRIER, limit: 500}))
      .total,
    events: ctx.published.length,
  };
}

/**
 * Expects a refused command: its status, the refusal's code and reason when given, and nothing
 * recorded or published.
 * @param {object} ctx
 * @param {string} id
 * @param {function(): !Promise<object>} attempt runs the command: its answer
 * @param {{status: number, code?: string, message?: string}} expected
 * @return {!Promise<object>} the refusal's body
 */
async function expectRefused(ctx, id, attempt, {status, code, message}) {
  const before = await footprint(ctx, id);
  const res = await attempt();
  expect(res.statusCode, res.body).to.equal(status);
  if (code !== undefined) {
    expect(res.json().details?.code, res.body).to.equal(code);
  }
  if (message !== undefined) {
    expect(res.json().message).to.equal(message);
  }
  expect(await footprint(ctx, id)).to.deep.equal(before);
  return res.json();
}

/**
 * Issues a B/L to the shipper, who endorses it to the bank by name: its id. The bank holds it.
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

/**
 * A B/L the bank has surrendered for amendment: its id. The carrier holds it, to go back to the
 * bank.
 * @param {object} ctx
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function heldForAmendment(ctx, reference) {
  const id = await endorsedToBank(ctx, reference);
  await ok(ctx, id, 'surrender-for-amendment', staffOf(BANK));
  return id;
}

/**
 * The amended document of a B/L: the same reference, discharged at OTHER_PORT instead.
 * @param {string} reference
 * @return {!Object}
 */
function amendedDocument(reference) {
  const document = twoContainerBl(reference);
  return {
    ...document,
    transports: {
      ...document.transports,
      portOfDischarge: {UNLocationCode: OTHER_PORT},
    },
  };
}

/**
 * The B/L's reference, as committedBl stored it.
 * @param {object} ctx
 * @param {string} id
 * @return {!Promise<string>}
 */
async function referenceOf(ctx, id) {
  return (await ctx.repo.getRecord(id)).recordNo;
}

for (const store of stores()) {
  describe(`amendment and split into child B/Ls (CB-35), ${store.name}`, () => {
    let ctx;
    beforeEach(async () => {
      ctx = await makeHttp(store, {
        signer: await createLocalSigner(),
        audit: NOTHING_ANCHORED,
        organisations: standInIdentity(),
      });
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('surrender for amendment', () => {
      it('the holder surrenders the B/L for amendment: the carrier holds it, to go back to the holder', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA'));
        const view = await ok(
          ctx,
          id,
          'surrender-for-amendment',
          staffOf(BANK),
        );
        expect(view.title).to.include({
          state: 'amendment-requested',
          holder: CARRIER,
          returnTo: BANK,
          endorsement: 'named',
        });
        const last = view.chain.at(-1);
        expect([
          last.command,
          last.from,
          last.to,
          last.actor.org,
        ]).to.deep.equal(['surrender-for-amendment', BANK, CARRIER, BANK]);
        const types = ctx.published.map(e => e.type);
        expect(types).to.include('records.title.surrender-for-amendment');
      });

      it('is offered to the holder; amend and split are offered to the carrier once it is surrendered for amendment', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA-OFFER'));
        const holder = (await read(ctx, id, staffOf(BANK))).json();
        expect(holder.allowedCommands).to.include('surrender-for-amendment');
        const carrierBefore = (await read(ctx, id, staffOf(CARRIER))).json();
        expect(carrierBefore.allowedCommands).to.not.include('amend');
        expect(carrierBefore.allowedCommands).to.not.include('split');
        await ok(ctx, id, 'surrender-for-amendment', staffOf(BANK));
        const carrier = (await read(ctx, id, staffOf(CARRIER))).json();
        expect(carrier.allowedCommands).to.include.members(['amend', 'split']);
        expect(carrier.allowedCommands).to.not.include('release');
        const bank = (await read(ctx, id, staffOf(BANK))).json();
        expect(bank.allowedCommands).to.deep.equal([]);
      });

      it('by a past holder is refused 403 with the reason, nothing recorded', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA-PAST'));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'surrender-for-amendment', staffOf(SHIPPER)),
          {
            status: 403,
            code: 'not-holder',
            message: TITLE_WORDING.notHolder('surrender-for-amendment'),
          },
        );
      });

      it('by the carrier, which is not the holder, is refused 403, nothing recorded', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA-CARRIER'));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'surrender-for-amendment', staffOf(CARRIER)),
          {status: 403, code: 'not-holder'},
        );
      });

      it('by an organisation that does not see the B/L gets 404 "B/L not found", nothing recorded', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA-OUT'));
        const body = await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'surrender-for-amendment', staffOf(STRANGER)),
          {status: 404},
        );
        expect(body.message).to.equal('B/L not found');
      });

      it('of a B/L already surrendered for delivery is refused 409, nothing recorded', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA-STATE'));
        await ok(ctx, id, 'surrender', staffOf(BANK));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'surrender-for-amendment', staffOf(CARRIER)),
          {status: 409, code: 'wrong-state'},
        );
      });

      it('needs bl.endorse: 403 without it', async () => {
        const id = await endorsedToBank(ctx, nextReference('SFA-PERM'));
        await expectRefused(
          ctx,
          id,
          () =>
            command(
              ctx,
              id,
              'surrender-for-amendment',
              staffOf(BANK, ['bl.read', 'bl.issue']),
            ),
          {status: 403},
        );
      });
    });

    describe('amend (Done when 1)', () => {
      it('the carrier amends: a new committed version, the holder back to returnTo, the chain kept with the new hash', async () => {
        const reference = nextReference('AMEND');
        const id = await heldForAmendment(ctx, reference);
        const chainBefore = await ctx.repo.listTitleEntries(id);
        const view = await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });

        const record = await ctx.repo.getRecord(id);
        expect(record.currentVersion).to.equal(2);
        const version = await ctx.repo.getVersion(id, 2);
        expect(version.state).to.equal('committed');
        expect(
          version.data.document.transports.portOfDischarge.UNLocationCode,
        ).to.equal(OTHER_PORT);
        const newHash = billOfLadingHash(version.data);
        expect(newHash).to.not.equal(chainBefore[0].documentHash);

        expect(view.title).to.include({
          state: 'with-holder',
          holder: BANK,
          returnTo: null,
          endorsement: 'named',
          issuedVersion: 2,
          documentHash: newHash,
        });
        expect(view.chain.slice(0, chainBefore.length)).to.deep.equal(
          JSON.parse(JSON.stringify(chainBefore)),
        );
        const last = view.chain.at(-1);
        expect([
          last.command,
          last.from,
          last.to,
          last.actor.org,
          last.documentHash,
          last.previousHash,
        ]).to.deep.equal([
          'amend',
          CARRIER,
          BANK,
          CARRIER,
          newHash,
          chainBefore.at(-1).entryHash,
        ]);
      });

      it('gives a chain that verifies after the amendment, every entry signed', async () => {
        const reference = nextReference('AMEND-VER');
        const id = await heldForAmendment(ctx, reference);
        await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        const keys = (
          await ctx.app.inject({url: '/records/title/keys'})
        ).json();
        const entries = await ctx.repo.listTitleEntries(id);
        expect(entries.map(e => e.command)).to.deep.equal([
          'issue',
          'endorse',
          'surrender-for-amendment',
          'amend',
        ]);
        const checked = await verifyTitleChain(entries, keys);
        expect(checked.valid, JSON.stringify(checked)).to.equal(true);
      });

      it('commits the new version like any other: sealed after the version before, its event published, the record verifies', async () => {
        const reference = nextReference('AMEND-SEAL');
        const id = await heldForAmendment(ctx, reference);
        await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        const first = await ctx.repo.getVersion(id, 1);
        const second = await ctx.repo.getVersion(id, 2);
        expect(second.seal).to.be.a('string');
        expect(second.previousSeal).to.equal(first.seal);
        expect(second.documentHash).to.equal(billOfLadingHash(second.data));
        const committed = ctx.published.filter(
          e =>
            e.type === 'records.record.committed' &&
            e.data.recordId === id &&
            e.data.versionNumber === 2,
        );
        expect(committed).to.have.length(1);
        expect(committed[0].data.documentHash).to.equal(second.documentHash);
        const verified = await ctx.service.verify(id);
        expect(verified.intact, JSON.stringify(verified)).to.equal(true);
        const types = ctx.published
          .filter(e => e.type.startsWith('records.title.'))
          .map(e => e.type);
        expect(types.at(-1)).to.equal('records.title.amend');
      });

      it("keeps the version's links to organisations when the body gives none", async () => {
        const reference = nextReference('AMEND-LINKS');
        const id = await heldForAmendment(ctx, reference);
        await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        const second = await ctx.repo.getVersion(id, 2);
        expect(second.data.partyOrganisations).to.deep.equal({
          shipper: SHIPPER,
        });
      });

      it('the holder may move the amended B/L on as before', async () => {
        const reference = nextReference('AMEND-ON');
        const id = await heldForAmendment(ctx, reference);
        await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        const surrendered = await ok(ctx, id, 'surrender', staffOf(BANK));
        expect(surrendered.title.state).to.equal('surrendered');
        const released = await ok(ctx, id, 'release', staffOf(CARRIER));
        expect(released.title.state).to.equal('accomplished');
      });

      it('by the holder it went back from is refused 403: only the carrier amends', async () => {
        const reference = nextReference('AMEND-HOLDER');
        const id = await heldForAmendment(ctx, reference);
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(BANK), {
              format: 'dcsa-3.0',
              document: amendedDocument(reference),
            }),
          {
            status: 403,
            code: 'not-carrier',
            message: TITLE_WORDING.notCarrier('amend'),
          },
        );
      });

      it('by an organisation that does not see the B/L gets 404, nothing recorded', async () => {
        const reference = nextReference('AMEND-OUT');
        const id = await heldForAmendment(ctx, reference);
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(STRANGER), {
              format: 'dcsa-3.0',
              document: amendedDocument(reference),
            }),
          {status: 404},
        );
      });

      it('of a B/L not surrendered for amendment is refused 409, nothing recorded', async () => {
        const reference = nextReference('AMEND-STATE');
        const id = await endorsedToBank(ctx, reference);
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(CARRIER), {
              format: 'dcsa-3.0',
              document: amendedDocument(reference),
            }),
          {status: 409, code: 'wrong-state'},
        );
      });

      it('with a document of another reference is refused 400, nothing recorded', async () => {
        const id = await heldForAmendment(ctx, nextReference('AMEND-REF'));
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(CARRIER), {
              format: 'dcsa-3.0',
              document: amendedDocument(nextReference('OTHER')),
            }),
          {status: 400, code: 'different-reference'},
        );
      });

      it('with a document of another carrier code is refused 400, nothing recorded', async () => {
        const reference = nextReference('AMEND-CARR');
        const id = await heldForAmendment(ctx, reference);
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(CARRIER), {
              format: 'dcsa-3.0',
              document: {...amendedDocument(reference), carrierCode: 'HLCU'},
            }),
          {status: 400, code: 'different-reference'},
        );
      });

      it('with a document that is not valid is refused 400 with its problems, nothing recorded', async () => {
        const reference = nextReference('AMEND-BAD');
        const id = await heldForAmendment(ctx, reference);
        const document = amendedDocument(reference);
        document.utilizedTransportEquipments = [];
        const body = await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(CARRIER), {
              format: 'dcsa-3.0',
              document,
            }),
          {status: 400},
        );
        expect(body.details.problems).to.be.an('array').that.is.not.empty;
      });

      it('without a document is refused 400, nothing recorded', async () => {
        const id = await heldForAmendment(ctx, nextReference('AMEND-NONE'));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'amend', staffOf(CARRIER), {}),
          {status: 400},
        );
      });

      it('turning the B/L into a sea waybill is refused 400, nothing recorded', async () => {
        const reference = nextReference('AMEND-SWB');
        const id = await heldForAmendment(ctx, reference);
        await expectRefused(
          ctx,
          id,
          () =>
            command(ctx, id, 'amend', staffOf(CARRIER), {
              format: 'dcsa-3.0',
              document: {
                ...amendedDocument(reference),
                transportDocumentTypeCode: 'SWB',
                isToOrder: false,
              },
            }),
          {status: 400, code: 'kind-changed'},
        );
      });

      it('needs bl.issue: 403 without it', async () => {
        const reference = nextReference('AMEND-PERM');
        const id = await heldForAmendment(ctx, reference);
        await expectRefused(
          ctx,
          id,
          () =>
            command(
              ctx,
              id,
              'amend',
              staffOf(CARRIER, ['bl.read', 'bl.endorse']),
              {format: 'dcsa-3.0', document: amendedDocument(reference)},
            ),
          {status: 403},
        );
      });

      // (added: the decision on the point the design left open, CB-35 brief) an amendment while
      // the carrier has a version being drafted or in review would leave that draft after a
      // version it never saw: refused 409 `draft-open`, the carrier finishes or discards it first.
      for (const submitted of [false, true]) {
        const label = submitted ? 'in review' : 'being drafted';
        it(`while a version is ${label} is refused 409 draft-open, nothing recorded (added: open point decided)`, async () => {
          const reference = nextReference('AMEND-DRAFT');
          const id = await heldForAmendment(ctx, reference);
          const draft = await ctx.service.saveDraft(
            id,
            {
              format: 'dcsa-3.0',
              document: {
                ...twoContainerBl(reference),
                termsAndConditions: 'A draft of the carrier (CB-35).',
              },
            },
            drafter,
            CARRIER,
          );
          if (submitted) {
            await ctx.service.submit(id, draft.draftVersion, drafter, CARRIER);
          }
          const body = await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'amend', staffOf(CARRIER), {
                format: 'dcsa-3.0',
                document: amendedDocument(reference),
              }),
            {status: 409, code: 'draft-open'},
          );
          expect(body.message).to.match(/draft/i);
        });
      }

      it('two amendments at once: exactly one wins, one new version, one amend entry', async () => {
        const reference = nextReference('AMEND-RACE');
        const id = await heldForAmendment(ctx, reference);
        const answers = await Promise.all([
          command(ctx, id, 'amend', staffOf(CARRIER), {
            format: 'dcsa-3.0',
            document: amendedDocument(reference),
          }),
          command(ctx, id, 'amend', staffOf(CARRIER), {
            format: 'dcsa-3.0',
            document: {
              ...amendedDocument(reference),
              termsAndConditions: 'The other amendment (CB-35).',
            },
          }),
        ]);
        const statuses = answers.map(a => a.statusCode).sort();
        expect(statuses, answers.map(a => a.body).join(' | ')).to.deep.equal([
          200, 409,
        ]);
        const versions = await ctx.repo.listVersions(id);
        expect(versions).to.have.length(2);
        const entries = await ctx.repo.listTitleEntries(id);
        expect(entries.filter(e => e.command === 'amend')).to.have.length(1);
        const title = await ctx.repo.getTitle(id);
        expect(title.documentHash).to.equal(entries.at(-1).documentHash);
        expect(title.documentHash).to.equal(versions[1].documentHash);
        expect(
          ctx.published.filter(e => e.type === 'records.title.amend'),
        ).to.have.length(1);
      });
    });

    describe('split (Done when 2)', () => {
      /**
       * A B/L held for amendment and split by container into two children: its id, the answer
       * and the children's references.
       * @param {string} label
       * @return {!Promise<{id: string, view: object, references: !Array<string>}>}
       */
      async function splitByContainerBl(label) {
        const id = await heldForAmendment(ctx, nextReference(label));
        const childReferences = [nextReference('A'), nextReference('B')];
        const view = await ok(
          ctx,
          id,
          'split',
          staffOf(CARRIER),
          splitBody(splitByContainer(...childReferences)),
        );
        return {id, view, references: childReferences};
      }

      it('closes the parent: state split, no holder, no command offered to anyone', async () => {
        const {id, view} = await splitByContainerBl('SPLIT');
        expect(view.title).to.include({
          state: 'split',
          holder: null,
          returnTo: null,
        });
        expect(view.chain.at(-1)).to.include({
          command: 'split',
          from: CARRIER,
          to: null,
        });
        for (const org of [CARRIER, BANK]) {
          const res = await read(ctx, id, staffOf(org));
          expect(res.statusCode, res.body).to.equal(200);
          expect(res.json().allowedCommands, org).to.deep.equal([]);
        }
      });

      it('answers with the children, in the order given: their record ids and references', async () => {
        const {view, references: given} = await splitByContainerBl('SPLIT-ANS');
        expect(view.children.map(c => c.recordNo)).to.deep.equal(given);
        for (const child of view.children) {
          expect(child.recordId).to.be.a('string');
        }
      });

      it('creates the children as records of the carrier, each with its document committed as version 1', async () => {
        const {view, references: given} = await splitByContainerBl('SPLIT-REC');
        const documents = splitByContainer(...given);
        for (const [i, child] of view.children.entries()) {
          const record = await ctx.repo.getRecord(child.recordId);
          expect(record).to.include({
            organisationId: CARRIER,
            recordNo: given[i],
            status: 'committed',
            currentVersion: 1,
          });
          const version = await ctx.repo.getVersion(child.recordId, 1);
          expect(version.state).to.equal('committed');
          expect(version.seal).to.be.a('string');
          expect(version.data.document.transportDocumentReference).to.equal(
            documents[i].transportDocumentReference,
          );
          const verified = await ctx.service.verify(child.recordId);
          expect(verified.intact, JSON.stringify(verified)).to.equal(true);
        }
      });

      it('gives each child a first title: negotiable, held by the organisation the parent was to go back to, endorsed as the parent', async () => {
        const {view} = await splitByContainerBl('SPLIT-TITLE');
        for (const child of view.children) {
          const version = await ctx.repo.getVersion(child.recordId, 1);
          const title = await ctx.repo.getTitle(child.recordId);
          expect(title).to.include({
            kind: 'negotiable',
            state: 'with-holder',
            carrier: CARRIER,
            holder: BANK,
            endorsement: 'named',
            returnTo: null,
            issuedVersion: 1,
            documentHash: billOfLadingHash(version.data),
            revision: 1,
          });
        }
      });

      it("starts each child's chain from the parent's last entry (the split), and it verifies", async () => {
        const {id, view} = await splitByContainerBl('SPLIT-CHAIN');
        const parentChain = await ctx.repo.listTitleEntries(id);
        const splitEntry = parentChain.at(-1);
        expect(splitEntry.command).to.equal('split');
        const keys = (
          await ctx.app.inject({url: '/records/title/keys'})
        ).json();
        for (const child of view.children) {
          const entries = await ctx.repo.listTitleEntries(child.recordId);
          expect(entries).to.have.length(1);
          const version = await ctx.repo.getVersion(child.recordId, 1);
          expect(entries[0]).to.include({
            recordId: child.recordId,
            seq: 1,
            command: 'issue-from-split',
            from: null,
            to: BANK,
            endorsement: 'named',
            documentHash: billOfLadingHash(version.data),
            previousHash: splitEntry.entryHash,
          });
          expect(entries[0].actor.org).to.equal(CARRIER);
          const linked = await verifyTitleChain(entries, keys, {
            startPreviousHash: splitEntry.entryHash,
          });
          expect(linked.valid, JSON.stringify(linked)).to.equal(true);
          const alone = await verifyTitleChain(entries, keys);
          expect(alone.valid).to.equal(false);
        }
        const parentChecked = await verifyTitleChain(parentChain, keys);
        expect(parentChecked.valid).to.equal(true);
      });

      it("publishes the parent's split and each child's first entry and committed version, for the audit trail and its anchoring", async () => {
        const {id, view} = await splitByContainerBl('SPLIT-EVENTS');
        const split = ctx.published.filter(
          e => e.type === 'records.title.split',
        );
        expect(split).to.have.length(1);
        expect(split[0].data.recordId).to.equal(id);
        for (const child of view.children) {
          const [entry] = await ctx.repo.listTitleEntries(child.recordId);
          const titleEvents = ctx.published.filter(
            e =>
              e.type === 'records.title.issue-from-split' &&
              e.data.recordId === child.recordId,
          );
          expect(titleEvents).to.have.length(1);
          expect(titleEvents[0].data).to.deep.include({
            recordNo: child.recordNo,
            seq: 1,
          });
          expect(titleEvents[0].data.entry).to.deep.equal(
            JSON.parse(JSON.stringify(entry)),
          );
          const committed = ctx.published.filter(
            e =>
              e.type === 'records.record.committed' &&
              e.data.recordId === child.recordId &&
              e.data.versionNumber === 1,
          );
          expect(committed).to.have.length(1);
        }
      });

      it("gives a child's title proof the parent's chain, so its first entry links: the chain verifies from the parent's split", async () => {
        const {id, view} = await splitByContainerBl('SPLIT-PROOF');
        const child = view.children[0];
        const res = await proof(ctx, child.recordId, staffOf(BANK));
        expect(res.statusCode, res.body).to.equal(200);
        const bundle = res.json();
        expect(bundle.format).to.equal('lrfe-title-proof/1');
        expect(bundle.recordId).to.equal(child.recordId);
        expect(bundle.parent.recordId).to.equal(id);
        expect(bundle.parent.recordNo).to.equal(await referenceOf(ctx, id));
        expect(bundle.parent.entries.map(e => e.command)).to.deep.equal([
          'issue',
          'endorse',
          'surrender-for-amendment',
          'split',
        ]);
        const parentChecked = await verifyTitleChain(
          bundle.parent.entries,
          bundle.jwks,
        );
        expect(parentChecked.valid).to.equal(true);
        const checked = await verifyTitleChain(bundle.entries, bundle.jwks, {
          startPreviousHash: bundle.parent.entries.at(-1).entryHash,
        });
        expect(checked.valid).to.equal(true);
        expect(bundle.anchor).to.deep.include({pending: true});
      });

      it('a B/L of its own has no parent in its title proof', async () => {
        const id = await endorsedToBank(ctx, nextReference('NO-PARENT'));
        const res = await proof(ctx, id, staffOf(BANK));
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json()).to.not.have.property('parent');
      });

      it('lets the children name different ports of discharge (Jira CB-35 comment 11580)', async () => {
        const {view} = await splitByContainerBl('SPLIT-PORTS');
        const ports = [];
        for (const child of view.children) {
          const version = await ctx.repo.getVersion(child.recordId, 1);
          ports.push(
            version.data.document.transports.portOfDischarge.UNLocationCode,
          );
        }
        expect(ports).to.deep.equal([PARENT_PORT, OTHER_PORT]);
      });

      it("divides one container's cargo between two children when the packages and weights add up", async () => {
        const id = await heldForAmendment(ctx, nextReference('SPLIT-DIV'));
        const view = await ok(
          ctx,
          id,
          'split',
          staffOf(CARRIER),
          splitBody(
            splitDividingContainer(nextReference('A'), nextReference('B')),
          ),
        );
        expect(view.title.state).to.equal('split');
        expect(view.children).to.have.length(2);
      });

      it('splits into three children', async () => {
        const id = await heldForAmendment(ctx, nextReference('SPLIT-3'));
        const documents = [
          blWithCargo(nextReference('A'), {
            cargo: [{container: CONTAINER_A, packages: 100, weight: 3000}],
          }),
          blWithCargo(nextReference('B'), {
            cargo: [{container: CONTAINER_A, packages: 300, weight: 9000}],
          }),
          blWithCargo(nextReference('C'), {
            port: OTHER_PORT,
            cargo: [{container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]}],
          }),
        ];
        const view = await ok(
          ctx,
          id,
          'split',
          staffOf(CARRIER),
          splitBody(documents),
        );
        expect(view.children).to.have.length(3);
      });

      it('each child moves on by itself: the holder endorses one, the other stays', async () => {
        const {view} = await splitByContainerBl('SPLIT-ON');
        const [first, second] = view.children;
        const endorsed = await ok(
          ctx,
          first.recordId,
          'endorse',
          staffOf(BANK),
          {
            to: SHIPPER,
            inBlank: false,
          },
        );
        expect(endorsed.title.holder).to.equal(SHIPPER);
        expect((await ctx.repo.getTitle(second.recordId)).holder).to.equal(
          BANK,
        );
      });

      it('an organisation that does not see the parent gets 404 for a child', async () => {
        const {view} = await splitByContainerBl('SPLIT-READ');
        const res = await read(
          ctx,
          view.children[0].recordId,
          staffOf(STRANGER),
        );
        expect(res.statusCode, res.body).to.equal(404);
        const carrier = await read(
          ctx,
          view.children[0].recordId,
          staffOf(CARRIER),
        );
        expect(carrier.statusCode, carrier.body).to.equal(200);
        const holder = await read(
          ctx,
          view.children[0].recordId,
          staffOf(BANK),
        );
        expect(holder.statusCode, holder.body).to.equal(200);
      });

      describe('the parent is closed after the split', () => {
        /**
         * A body each command would take on an open B/L: valid documents, so only the state can
         * refuse it.
         * @param {string} name
         * @param {string} reference the parent's reference
         * @return {!Object}
         */
        const bodyOf = (name, reference) => {
          if (name === 'amend') {
            return {format: 'dcsa-3.0', document: amendedDocument(reference)};
          }
          if (name === 'split') {
            return splitBody(
              splitByContainer(nextReference('A'), nextReference('B')),
            );
          }
          return {};
        };
        for (const name of ['release', 'amend', 'split', 'void']) {
          it(`${name} of a split B/L by the carrier is refused 409, nothing recorded`, async () => {
            const {id} = await splitByContainerBl(`CLOSED-${name}`);
            const body = bodyOf(name, await referenceOf(ctx, id));
            await expectRefused(
              ctx,
              id,
              () => command(ctx, id, name, staffOf(CARRIER), body),
              {status: 409, code: 'closed'},
            );
          });
        }
      });

      describe("the cargo of the children must add up to the parent's", () => {
        const cases = [
          [
            'a container of the parent missing',
            () => [
              blWithCargo(nextReference('A'), {
                cargo: [{container: CONTAINER_A, packages: 200, weight: 6000}],
              }),
              blWithCargo(nextReference('B'), {
                cargo: [{container: CONTAINER_A, packages: 200, weight: 6000}],
              }),
            ],
          ],
          [
            'a container the parent does not carry',
            () => [
              ...splitByContainer(nextReference('A'), nextReference('B')),
              blWithCargo(nextReference('C'), {
                cargo: [{container: 'TGHU1234567', packages: 10, weight: 100}],
              }),
            ],
          ],
          [
            'packages not adding up (fewer)',
            () => [
              blWithCargo(nextReference('A'), {
                cargo: [{container: CONTAINER_A, packages: 250, weight: 7500}],
              }),
              blWithCargo(nextReference('B'), {
                cargo: [
                  {container: CONTAINER_A, packages: 100, weight: 4500},
                  {container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]},
                ],
              }),
            ],
          ],
          [
            'packages not adding up (more)',
            () => [
              blWithCargo(nextReference('A'), {
                cargo: [{container: CONTAINER_A, packages: 400, weight: 7500}],
              }),
              blWithCargo(nextReference('B'), {
                cargo: [
                  {container: CONTAINER_A, packages: 150, weight: 4500},
                  {container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]},
                ],
              }),
            ],
          ],
          [
            'weights not adding up',
            () => [
              blWithCargo(nextReference('A'), {
                cargo: [{container: CONTAINER_A, packages: 250, weight: 7500}],
              }),
              blWithCargo(nextReference('B'), {
                cargo: [
                  {container: CONTAINER_A, packages: 150, weight: 4000},
                  {container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]},
                ],
              }),
            ],
          ],
          [
            "a container's whole cargo given twice",
            () => [
              ...splitByContainer(nextReference('A'), nextReference('B')),
              blWithCargo(nextReference('C'), {
                cargo: [{container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]}],
              }),
            ],
          ],
        ];
        for (const [label, children] of cases) {
          it(`a split with ${label} is refused 400, nothing recorded`, async () => {
            const id = await heldForAmendment(ctx, nextReference('CARGO'));
            await expectRefused(
              ctx,
              id,
              () =>
                command(
                  ctx,
                  id,
                  'split',
                  staffOf(CARRIER),
                  splitBody(children()),
                ),
              {status: 400, code: 'cargo-mismatch'},
            );
          });
        }
      });

      describe('refusals', () => {
        it('by the holder it went back from is refused 403: only the carrier splits', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-HOLDER'));
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(BANK),
                splitBody(
                  splitByContainer(nextReference('A'), nextReference('B')),
                ),
              ),
            {
              status: 403,
              code: 'not-carrier',
              message: TITLE_WORDING.notCarrier('split'),
            },
          );
        });

        it('by an organisation that does not see the B/L gets 404, nothing recorded', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-OUT'));
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(STRANGER),
                splitBody(
                  splitByContainer(nextReference('A'), nextReference('B')),
                ),
              ),
            {status: 404},
          );
        });

        it('of a B/L with its holder (not surrendered for amendment) is refused 409, nothing recorded', async () => {
          const id = await endorsedToBank(ctx, nextReference('SPLIT-STATE'));
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER),
                splitBody(
                  splitByContainer(nextReference('A'), nextReference('B')),
                ),
              ),
            {status: 409, code: 'wrong-state'},
          );
        });

        it('into one child is refused 400 with the reason, nothing recorded', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-ONE'));
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER),
                splitBody([twoContainerBl(nextReference('A'))]),
              ),
            {
              status: 400,
              code: 'too-few-children',
              message: TITLE_WORDING.tooFewChildren,
            },
          );
        });

        for (const [label, body] of [
          ['no children', {}],
          ['an empty list', {children: []}],
          ['children that are not a list', {children: {length: 2}}],
          [
            'a child without a document',
            {children: [{format: 'dcsa-3.0'}, {format: 'dcsa-3.0'}]},
          ],
        ]) {
          it(`with ${label} is refused 400, nothing recorded`, async () => {
            const id = await heldForAmendment(ctx, nextReference('SPLIT-BODY'));
            await expectRefused(
              ctx,
              id,
              () => command(ctx, id, 'split', staffOf(CARRIER), body),
              {status: 400},
            );
          });
        }

        it('with a child document that is not valid is refused 400 with its problems, nothing recorded', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-BAD'));
          const documents = splitByContainer(
            nextReference('A'),
            nextReference('B'),
          );
          delete documents[1].transportDocumentTypeCode;
          const body = await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'split', staffOf(CARRIER), splitBody(documents)),
            {status: 400},
          );
          expect(body.details.problems).to.be.an('array').that.is.not.empty;
        });

        it("with a child of the parent's reference is refused 400, nothing recorded", async () => {
          const reference = nextReference('SPLIT-SAME');
          const id = await heldForAmendment(ctx, reference);
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER),
                splitBody(splitByContainer(reference, nextReference('B'))),
              ),
            {status: 400, code: 'child-reference'},
          );
        });

        it('with two children of the same reference is refused 400, nothing recorded', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-TWICE'));
          const reference = nextReference('A');
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER),
                splitBody(splitByContainer(reference, reference)),
              ),
            {status: 400, code: 'child-reference'},
          );
        });

        it('with a child of a reference the carrier already has is refused 409, nothing recorded', async () => {
          const taken = nextReference('TAKEN');
          await committedBl(ctx, taken);
          const id = await heldForAmendment(ctx, nextReference('SPLIT-TAKEN'));
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER),
                splitBody(splitByContainer(taken, nextReference('B'))),
              ),
            {status: 409},
          );
        });

        // (added: coordinator follow-up) the second child's reference is taken: every child is
        // checked before anything is written, so neither the parent nor the first child changes.
        it("with only the second child's reference taken is refused 409, the parent and the first child untouched (added: follow-up)", async () => {
          const taken = nextReference('TAKEN2');
          await committedBl(ctx, taken);
          const id = await heldForAmendment(ctx, nextReference('SPLIT-TK2'));
          const first = nextReference('A');
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER),
                splitBody(splitByContainer(first, taken)),
              ),
            {status: 409},
          );
          const found = await ctx.repo.findRecord({
            organisationId: CARRIER,
            carrierCode: twoContainerBl('X').carrierCode,
            recordNo: first,
          });
          expect(found).to.equal(null);
        });

        // (added: coordinator follow-up) as for amend: a split would close the B/L under a draft
        // the carrier has open; the carrier finishes or discards it first.
        for (const submitted of [false, true]) {
          const label = submitted ? 'in review' : 'being drafted';
          it(`while a version of the B/L is ${label} is refused 409 draft-open, nothing recorded (added: follow-up)`, async () => {
            const reference = nextReference('SPLIT-DRAFT');
            const id = await heldForAmendment(ctx, reference);
            const draft = await ctx.service.saveDraft(
              id,
              {
                format: 'dcsa-3.0',
                document: {
                  ...twoContainerBl(reference),
                  termsAndConditions: 'A draft of the carrier (CB-35).',
                },
              },
              drafter,
              CARRIER,
            );
            if (submitted) {
              await ctx.service.submit(
                id,
                draft.draftVersion,
                drafter,
                CARRIER,
              );
            }
            const body = await expectRefused(
              ctx,
              id,
              () =>
                command(
                  ctx,
                  id,
                  'split',
                  staffOf(CARRIER),
                  splitBody(
                    splitByContainer(nextReference('A'), nextReference('B')),
                  ),
                ),
              {status: 409, code: 'draft-open'},
            );
            expect(body.message).to.match(/draft/i);
          });
        }

        it('with a child of another carrier code is refused 400, nothing recorded', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-CARR'));
          const documents = splitByContainer(
            nextReference('A'),
            nextReference('B'),
          );
          documents[1] = {...documents[1], carrierCode: 'HLCU'};
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'split', staffOf(CARRIER), splitBody(documents)),
            {status: 400},
          );
        });

        it('with a child that is a sea waybill is refused 400, nothing recorded', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-SWB'));
          const documents = splitByContainer(
            nextReference('A'),
            nextReference('B'),
          );
          documents[1] = {
            ...documents[1],
            transportDocumentTypeCode: 'SWB',
            isToOrder: false,
          };
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'split', staffOf(CARRIER), splitBody(documents)),
            {status: 400, code: 'kind-changed'},
          );
        });

        it('needs bl.issue: 403 without it', async () => {
          const id = await heldForAmendment(ctx, nextReference('SPLIT-PERM'));
          await expectRefused(
            ctx,
            id,
            () =>
              command(
                ctx,
                id,
                'split',
                staffOf(CARRIER, ['bl.read', 'bl.endorse']),
                splitBody(
                  splitByContainer(nextReference('A'), nextReference('B')),
                ),
              ),
            {status: 403},
          );
        });
      });

      it('two splits at once: exactly one wins, and only its children exist', async () => {
        const id = await heldForAmendment(ctx, nextReference('SPLIT-RACE'));
        const first = [nextReference('A'), nextReference('B')];
        const second = [nextReference('C'), nextReference('D')];
        const answers = await Promise.all([
          command(
            ctx,
            id,
            'split',
            staffOf(CARRIER),
            splitBody(splitByContainer(...first)),
          ),
          command(
            ctx,
            id,
            'split',
            staffOf(CARRIER),
            splitBody(splitByContainer(...second)),
          ),
        ]);
        const statuses = answers.map(a => a.statusCode).sort();
        expect(statuses, answers.map(a => a.body).join(' | ')).to.deep.equal([
          200, 409,
        ]);
        const won = answers.find(a => a.statusCode === 200).json();
        const lost = won.children[0].recordNo === first[0] ? second : first;
        for (const reference of lost) {
          const found = await ctx.repo.findRecord({
            organisationId: CARRIER,
            carrierCode: twoContainerBl('X').carrierCode,
            recordNo: reference,
          });
          expect(found, reference).to.equal(null);
        }
        const entries = await ctx.repo.listTitleEntries(id);
        expect(entries.filter(e => e.command === 'split')).to.have.length(1);
        expect(
          ctx.published.filter(
            e => e.type === 'records.title.issue-from-split',
          ),
        ).to.have.length(2);
      });

      it('an amendment and a split at once: exactly one wins', async () => {
        const reference = nextReference('MIX-RACE');
        const id = await heldForAmendment(ctx, reference);
        const answers = await Promise.all([
          command(ctx, id, 'amend', staffOf(CARRIER), {
            format: 'dcsa-3.0',
            document: amendedDocument(reference),
          }),
          command(
            ctx,
            id,
            'split',
            staffOf(CARRIER),
            splitBody(splitByContainer(nextReference('A'), nextReference('B'))),
          ),
        ]);
        const statuses = answers.map(a => a.statusCode).sort();
        expect(statuses, answers.map(a => a.body).join(' | ')).to.deep.equal([
          200, 409,
        ]);
        const entries = await ctx.repo.listTitleEntries(id);
        expect(
          entries.filter(e => e.command === 'amend' || e.command === 'split'),
        ).to.have.length(1);
      });
    });

    describe('names from outside', () => {
      for (const name of [
        'toString',
        '__proto__',
        'constructor',
        'hasOwnProperty',
      ]) {
        it(`a child's format named ${name} is refused 400, never a crash, nothing recorded`, async () => {
          const id = await heldForAmendment(ctx, nextReference('NAME-FMT'));
          const documents = splitByContainer(
            nextReference('A'),
            nextReference('B'),
          );
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'split', staffOf(CARRIER), {
                children: [
                  {format: 'dcsa-3.0', document: documents[0]},
                  {format: name, document: documents[1]},
                ],
              }),
            {status: 400},
          );
        });

        it(`an amendment's format named ${name} is refused 400, never a crash, nothing recorded`, async () => {
          const reference = nextReference('NAME-AMD');
          const id = await heldForAmendment(ctx, reference);
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'amend', staffOf(CARRIER), {
                format: name,
                document: amendedDocument(reference),
              }),
            {status: 400},
          );
        });

        it(`a container named ${name}, not the parent's, is a cargo mismatch (400), never a crash`, async () => {
          const id = await heldForAmendment(ctx, nextReference('NAME-CTR'));
          const documents = [
            ...splitByContainer(nextReference('A'), nextReference('B')),
            blWithCargo(nextReference('C'), {
              cargo: [{container: name, packages: 1, weight: 1}],
            }),
          ];
          await expectRefused(
            ctx,
            id,
            () =>
              command(ctx, id, 'split', staffOf(CARRIER), splitBody(documents)),
            {status: 400},
          );
        });
      }
    });

    describe('no part of a cargo is released against a B/L that stays open (Done when 3)', () => {
      for (const body of PARTIAL_RELEASE_BODIES) {
        const key = Object.keys(body)[0];
        it(`a release naming part of the cargo (${key}) is refused 400, nothing recorded`, async () => {
          const id = await endorsedToBank(ctx, nextReference('PART'));
          await ok(ctx, id, 'surrender', staffOf(BANK));
          await expectRefused(
            ctx,
            id,
            () => command(ctx, id, 'release', staffOf(CARRIER), body),
            {status: 400, code: 'partial-release'},
          );
          expect((await ctx.repo.getTitle(id)).state).to.equal('surrendered');
        });
      }

      it('a release of a B/L its holder still holds is refused 409: only a whole surrendered B/L is released', async () => {
        const id = await endorsedToBank(ctx, nextReference('PART-HELD'));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'release', staffOf(CARRIER)),
          {status: 409, code: 'wrong-state'},
        );
      });

      it('a release of a B/L held for amendment is refused 409, nothing recorded', async () => {
        const id = await heldForAmendment(ctx, nextReference('PART-AMD'));
        await expectRefused(
          ctx,
          id,
          () => command(ctx, id, 'release', staffOf(CARRIER)),
          {status: 409, code: 'wrong-state'},
        );
      });

      it('after a split, releasing one child releases only that child: the other stays with its holder, the parent split', async () => {
        const id = await heldForAmendment(ctx, nextReference('PART-SPLIT'));
        const view = await ok(
          ctx,
          id,
          'split',
          staffOf(CARRIER),
          splitBody(splitByContainer(nextReference('A'), nextReference('B'))),
        );
        const [first, second] = view.children;
        await ok(ctx, first.recordId, 'surrender', staffOf(BANK));
        const released = await ok(
          ctx,
          first.recordId,
          'release',
          staffOf(CARRIER),
        );
        expect(released.title.state).to.equal('accomplished');
        expect((await ctx.repo.getTitle(second.recordId)).state).to.equal(
          'with-holder',
        );
        expect((await ctx.repo.getTitle(id)).state).to.equal('split');
        await expectRefused(
          ctx,
          second.recordId,
          () => command(ctx, second.recordId, 'release', staffOf(CARRIER)),
          {status: 409, code: 'wrong-state'},
        );
      });
    });
  });
}

describe('the amendment and split modules (CB-38), memory', () => {
  /**
   * The service with only some title modules on.
   * @param {string} setting LRFE_BL_MODULES
   * @return {!Promise<object>}
   */
  async function withModules(setting) {
    return makeHttp(stores()[0], {
      signer: await createLocalSigner(),
      audit: NOTHING_ANCHORED,
      organisations: standInIdentity(),
      modules: modulesFromSettings({LRFE_BL_MODULES: setting}),
    });
  }

  it('amendment off: surrender for amendment is refused 409 "not enabled", not offered, nothing recorded', async () => {
    const ctx = await withModules('negotiable,blank-endorsement');
    try {
      const id = await endorsedToBank(ctx, nextReference('MOD-AMD'));
      const holder = (await read(ctx, id, staffOf(BANK))).json();
      expect(holder.allowedCommands).to.not.include('surrender-for-amendment');
      await expectRefused(
        ctx,
        id,
        () => command(ctx, id, 'surrender-for-amendment', staffOf(BANK)),
        {
          status: 409,
          code: 'module-off',
          message: TITLE_WORDING.moduleOff('amendment'),
        },
      );
    } finally {
      await ctx.close();
    }
  });

  it('split off: the amendment works, the split is refused 409 "not enabled", not offered, nothing recorded', async () => {
    const ctx = await withModules('negotiable,amendment');
    try {
      const reference = nextReference('MOD-SPLIT');
      const id = await heldForAmendment(ctx, reference);
      const carrier = (await read(ctx, id, staffOf(CARRIER))).json();
      expect(carrier.allowedCommands).to.include('amend');
      expect(carrier.allowedCommands).to.not.include('split');
      await expectRefused(
        ctx,
        id,
        () =>
          command(
            ctx,
            id,
            'split',
            staffOf(CARRIER),
            splitBody(splitByContainer(nextReference('A'), nextReference('B'))),
          ),
        {
          status: 409,
          code: 'module-off',
          message: TITLE_WORDING.moduleOff('split'),
        },
      );
      const amended = await ok(ctx, id, 'amend', staffOf(CARRIER), {
        format: 'dcsa-3.0',
        document: amendedDocument(reference),
      });
      expect(amended.title.state).to.equal('with-holder');
    } finally {
      await ctx.close();
    }
  });

  it('amendment off: amend of a B/L left waiting for an amendment is refused 409 "not enabled", nothing recorded', async () => {
    const on = await withModules('negotiable,amendment');
    let id;
    let reference;
    try {
      reference = nextReference('MOD-WAIT');
      id = await heldForAmendment(on, reference);
      // the same store with the module off: a new service on the B/Ls as they are
      const off = await makeHttp(
        {open: async () => ({repo: on.repo})},
        {
          signer: await createLocalSigner(),
          audit: NOTHING_ANCHORED,
          organisations: standInIdentity(),
          modules: modulesFromSettings({LRFE_BL_MODULES: 'negotiable'}),
        },
      );
      try {
        await expectRefused(
          off,
          id,
          () =>
            command(off, id, 'amend', staffOf(CARRIER), {
              format: 'dcsa-3.0',
              document: amendedDocument(reference),
            }),
          {
            status: 409,
            code: 'module-off',
            message: TITLE_WORDING.moduleOff('amendment'),
          },
        );
      } finally {
        await off.app.close();
      }
    } finally {
      await on.close();
    }
  });
});
