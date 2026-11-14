import {createEventBus, createLocalSigner} from '@lrfe/common';
import {
  billOfLadingHash,
  formatsFromSettings,
} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';
import {ForeignKeyConstraintError, UniqueConstraintError} from 'sequelize';

import {ShippingRecordsService} from '../src/records.service.js';
import {TitleService} from '../src/title.service.js';
import {exampleWithReference, makeClock, stores} from './helpers.js';

/** The organisations of the tests: the carrier owns the B/Ls. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const CONSIGNEE = 'org-consignee';
const STRANGER = 'org-stranger';

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/**
 * A person of an organisation, running title commands.
 * @param {string} org
 * @return {{id: string, name: string, org: string}}
 */
function staffOf(org) {
  return {id: `u-${org}`, name: `Staff of ${org}`, org};
}

/**
 * A DCSA transport document of a kind: the example B/L (to order), or one to a named consignee
 * (`straight`), or a sea waybill.
 * @param {string} reference
 * @param {string} kind `negotiable`, `straight` or `waybill`
 * @return {object}
 */
function documentOf(reference, kind) {
  const document = exampleWithReference(reference);
  if (kind === 'negotiable') {
    return document;
  }
  let typeCode = 'BOL';
  if (kind === 'waybill') {
    typeCode = 'SWB';
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
    transportDocumentTypeCode: typeCode,
    isToOrder: false,
    documentParties: {...document.documentParties, consignee},
  };
}

/**
 * The record and title services on a store, sharing its transactions.
 * @param {{open: function(): Promise<object>}} store
 * @param {{modules?: !ReadonlyArray<string>}} [options] the title modules on (all by default)
 * @return {Promise<object>}
 */
async function makeServices(store, {modules = modulesFromSettings({})} = {}) {
  const {repo, atomic, close, sequelize} = await store.open();
  const bus = createEventBus({driver: 'memory', source: 'shipping-records'});
  let events = bus;
  if (atomic) {
    events = {...bus, atomic};
  }
  const clock = makeClock();
  const records = new ShippingRecordsService({
    repo,
    events,
    formats: formatsFromSettings({}),
    clock,
  });
  // CB-32: every applied command adds a signed chain entry, so the title service needs a signer
  const signer = await createLocalSigner();
  const titles = new TitleService({repo, events, modules, clock, signer});
  return {
    repo,
    events,
    clock,
    sequelize,
    records,
    titles,
    signer,
    close: async () => {
      await close?.();
    },
  };
}

/**
 * A B/L of the carrier with its first version committed: the record's id.
 * @param {object} ctx makeServices' answer
 * @param {string} reference
 * @param {{kind?: string, links?: object}} [options] the kind of B/L, and its parties' links to
 *     organisations (by default the shipper's, and the consignee's for the other kinds)
 * @return {Promise<string>}
 */
async function committedBl(ctx, reference, {kind = 'negotiable', links} = {}) {
  let partyOrganisations = links;
  if (partyOrganisations === undefined) {
    partyOrganisations = {shipper: SHIPPER};
    if (kind !== 'negotiable') {
      partyOrganisations.consignee = CONSIGNEE;
    }
  }
  const body = {
    format: 'dcsa-3.0',
    document: documentOf(reference, kind),
    partyOrganisations,
  };
  const record = await ctx.records.createRecord(body, drafter, CARRIER);
  await ctx.records.submit(record.id, 1, drafter, CARRIER);
  await ctx.records.commit(record.id, 1, {by: approver}, 'bpm');
  return record.id;
}

/**
 * Runs a title command expected to be refused: the error.
 * @param {!Promise<*>} pending the command's promise
 * @return {Promise<!Error>}
 */
async function refused(pending) {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('The command was not refused');
}

/**
 * Wraps an async function so that its first `count` calls answer together, once all of them have
 * their value: every caller has read before any goes on.
 * @param {function(...*): !Promise<*>} fn
 * @param {number} count
 * @return {function(...*): !Promise<*>}
 */
function together(fn, count) {
  let waiting = [];
  return async (...args) => {
    const value = await fn(...args);
    await new Promise(resolve => {
      waiting.push(resolve);
      if (waiting.length === count) {
        for (const release of waiting) {
          release();
        }
        waiting = [];
      }
    });
    return value;
  };
}

/**
 * A title service whose callers all read the title before any of them writes: two commands
 * fired at once then always race for the same revision.
 * @param {object} ctx
 * @return {!TitleService}
 */
function racingTitles(ctx) {
  const repo = {...ctx.repo, getTitle: together(ctx.repo.getTitle, 2)};
  return new TitleService({
    repo,
    events: ctx.events,
    modules: modulesFromSettings({}),
    clock: ctx.clock,
    signer: ctx.signer,
  });
}

for (const store of stores()) {
  describe(`the holder ledger (CB-31), ${store.name}`, () => {
    let ctx;
    beforeEach(async () => {
      ctx = await makeServices(store);
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('issuing a B/L', () => {
      it('issues a negotiable B/L to its shipper, from the committed version', async () => {
        const id = await committedBl(ctx, 'CB31-ISSUE-1');
        const view = await ctx.titles.apply(
          id,
          {name: 'issue'},
          staffOf(CARRIER),
        );
        const version = await ctx.repo.getVersion(id, 1);
        expect(view.recordId).to.equal(id);
        expect(view.title).to.include({
          kind: 'negotiable',
          state: 'issued',
          carrier: CARRIER,
          holder: SHIPPER,
          endorsement: 'none',
          consignee: null,
          returnTo: null,
          issuedVersion: 1,
          documentHash: billOfLadingHash(version.data),
          revision: 1,
        });
        expect(view.title.documentHash).to.equal(version.documentHash);
        expect(view.allowedCommands).to.deep.equal(['void']);
        expect(await ctx.repo.getTitle(id)).to.include({
          recordId: id,
          holder: SHIPPER,
          revision: 1,
        });
      });

      it('issues a straight B/L and a sea waybill to their consignee, with no holder', async () => {
        for (const kind of ['straight', 'waybill']) {
          const id = await committedBl(ctx, `CB31-ISSUE-${kind}`, {kind});
          const view = await ctx.titles.apply(
            id,
            {name: 'issue'},
            staffOf(CARRIER),
          );
          expect(view.title).to.include({
            kind,
            state: 'issued',
            carrier: CARRIER,
            holder: null,
            consignee: CONSIGNEE,
          });
        }
      });

      it('takes the kind and parties from the document, never from the command', async () => {
        const id = await committedBl(ctx, 'CB31-ISSUE-ARGS');
        const view = await ctx.titles.apply(
          id,
          {name: 'issue', kind: 'waybill', shipper: STRANGER},
          staffOf(CARRIER),
        );
        expect(view.title).to.include({kind: 'negotiable', holder: SHIPPER});
      });

      it('refuses a B/L without a committed version (409), storing nothing', async () => {
        const body = {
          format: 'dcsa-3.0',
          document: documentOf('CB31-DRAFT', 'negotiable'),
          partyOrganisations: {shipper: SHIPPER},
        };
        const record = await ctx.records.createRecord(body, drafter, CARRIER);
        const before = await ctx.titles.read(record.id, staffOf(CARRIER));
        expect(before).to.deep.equal({
          recordId: record.id,
          title: null,
          allowedCommands: [],
        });
        const error = await refused(
          ctx.titles.apply(record.id, {name: 'issue'}, staffOf(CARRIER)),
        );
        expect(error.statusCode).to.equal(409);
        expect(error.details.code).to.equal('not-committed');
        expect(await ctx.repo.getTitle(record.id)).to.equal(null);
      });

      it('refuses while a new version is in review (409), and issues the current one while a draft is open', async () => {
        const id = await committedBl(ctx, 'CB31-REVIEW');
        const body = {
          format: 'dcsa-3.0',
          document: documentOf('CB31-REVIEW', 'negotiable'),
          partyOrganisations: {shipper: SHIPPER},
        };
        await ctx.records.saveDraft(id, body, drafter, CARRIER);
        const read = await ctx.titles.read(id, staffOf(CARRIER));
        expect(read.allowedCommands).to.deep.equal(['issue']);
        await ctx.records.submit(id, 2, drafter, CARRIER);
        const error = await refused(
          ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER)),
        );
        expect(error.statusCode).to.equal(409);
        expect(error.details.code).to.equal('in-review');
        expect(error.message).to.match(/in review/);

        await ctx.records.reject(
          id,
          2,
          {by: approver, comment: 'Not yet'},
          'bpm',
        );
        const view = await ctx.titles.apply(
          id,
          {name: 'issue'},
          staffOf(CARRIER),
        );
        expect(view.title.issuedVersion).to.equal(1);
        const current = await ctx.repo.getVersion(id, 1);
        expect(view.title.documentHash).to.equal(current.documentHash);
      });

      it('refuses a negotiable B/L whose shipper has no organisation (400)', async () => {
        const id = await committedBl(ctx, 'CB31-NO-SHIPPER', {links: {}});
        const error = await refused(
          ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER)),
        );
        expect(error.statusCode).to.equal(400);
        expect(error.details.code).to.equal('missing-shipper');
        expect(error.message).to.match(/organisation of its shipper/);
        expect(await ctx.repo.getTitle(id)).to.equal(null);
      });

      it('answers 404 to another organisation, and for an unknown B/L, as the records do', async () => {
        const id = await committedBl(ctx, 'CB31-OTHER');
        for (const org of [SHIPPER, STRANGER]) {
          const error = await refused(
            ctx.titles.apply(id, {name: 'issue'}, staffOf(org)),
          );
          expect(error.statusCode).to.equal(404);
          expect(error.message).to.equal('B/L not found');
        }
        const noOrg = await refused(
          ctx.titles.read(id, {id: 'u-x', name: 'No organisation'}),
        );
        expect(noOrg.statusCode).to.equal(404);
        const unknown = await refused(
          ctx.titles.read(
            '00000000-0000-4000-8000-000000000000',
            staffOf(CARRIER),
          ),
        );
        expect(unknown.statusCode).to.equal(404);
        expect(await ctx.repo.getTitle(id)).to.equal(null);
      });

      it('refuses a second issue (409)', async () => {
        const id = await committedBl(ctx, 'CB31-TWICE');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const error = await refused(
          ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER)),
        );
        expect(error.statusCode).to.equal(409);
        expect(error.details.code).to.equal('already-issued');
      });
    });

    describe('commands through the service', () => {
      it('moves a negotiable B/L from holder to holder until it is accomplished', async () => {
        const id = await committedBl(ctx, 'CB31-JOURNEY');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const steps = [
          [
            SHIPPER,
            {name: 'endorse', to: BANK, inBlank: true},
            {state: 'with-holder', holder: BANK, endorsement: 'blank'},
          ],
          [
            BANK,
            {name: 'transfer', to: BUYER},
            {state: 'with-holder', holder: BUYER, endorsement: 'blank'},
          ],
          [
            BUYER,
            {name: 'endorse', to: BANK, inBlank: false},
            {state: 'with-holder', holder: BANK, endorsement: 'named'},
          ],
          [BANK, {name: 'surrender'}, {state: 'surrendered', holder: CARRIER}],
          [CARRIER, {name: 'release'}, {state: 'accomplished', holder: null}],
        ];
        let revision = 1;
        for (const [org, command, expected] of steps) {
          const view = await ctx.titles.apply(id, command, staffOf(org));
          revision += 1;
          expect(view.title, command.name).to.include({
            ...expected,
            revision,
          });
          expect(await ctx.repo.getTitle(id), command.name).to.include({
            ...expected,
            revision,
          });
        }
        const final = await ctx.titles.read(id, staffOf(CARRIER));
        expect(final.allowedCommands).to.deep.equal([]);
      });

      it('runs an amendment and a switch to paper', async () => {
        const id = await committedBl(ctx, 'CB31-AMEND');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const asked = await ctx.titles.apply(
          id,
          {name: 'surrender-for-amendment'},
          staffOf(SHIPPER),
        );
        expect(asked.title).to.include({
          state: 'amendment-requested',
          holder: CARRIER,
          returnTo: SHIPPER,
        });
        const amended = await ctx.titles.apply(
          id,
          {name: 'amend'},
          staffOf(CARRIER),
        );
        expect(amended.title).to.include({
          state: 'with-holder',
          holder: SHIPPER,
          returnTo: null,
        });
        const paper = await ctx.titles.apply(
          id,
          {name: 'switch-to-paper'},
          staffOf(SHIPPER),
        );
        expect(paper.title).to.include({
          state: 'switched-to-paper',
          holder: null,
        });
      });

      it('delivers a straight B/L and voids a sea waybill', async () => {
        const straight = await committedBl(ctx, 'CB31-DELIVER', {
          kind: 'straight',
        });
        await ctx.titles.apply(straight, {name: 'issue'}, staffOf(CARRIER));
        const delivered = await ctx.titles.apply(
          straight,
          {name: 'deliver'},
          staffOf(CARRIER),
        );
        expect(delivered.title.state).to.equal('delivered');
        const waybill = await committedBl(ctx, 'CB31-VOID', {kind: 'waybill'});
        await ctx.titles.apply(waybill, {name: 'issue'}, staffOf(CARRIER));
        const voided = await ctx.titles.apply(
          waybill,
          {name: 'void'},
          staffOf(CARRIER),
        );
        expect(voided.title.state).to.equal('void');
      });

      it("refuses the consignee a carrier's command (403), the title unchanged", async () => {
        const id = await committedBl(ctx, 'CB31-NOT-CARRIER', {
          kind: 'waybill',
        });
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const before = await ctx.repo.getTitle(id);
        for (const name of ['deliver', 'void']) {
          const error = await refused(
            ctx.titles.apply(id, {name}, staffOf(CONSIGNEE)),
          );
          expect(error.statusCode, name).to.equal(403);
          expect(error.details, name).to.deep.equal({code: 'not-carrier'});
          expect(error.message, name).to.equal(
            `Only the carrier that issued this B/L may ${name} it`,
          );
        }
        expect(await ctx.repo.getTitle(id)).to.deep.equal(before);
      });

      it('leaves a split to CB-35 (409), the title unchanged', async () => {
        const id = await committedBl(ctx, 'CB31-SPLIT');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        await ctx.titles.apply(
          id,
          {name: 'surrender-for-amendment'},
          staffOf(SHIPPER),
        );
        const before = await ctx.repo.getTitle(id);
        const error = await refused(
          ctx.titles.apply(id, {name: 'split', children: 2}, staffOf(CARRIER)),
        );
        expect(error.statusCode).to.equal(409);
        expect(await ctx.repo.getTitle(id)).to.deep.equal(before);
      });

      it('changes nothing on a refusal, answering its reason and code', async () => {
        const id = await committedBl(ctx, 'CB31-REFUSED');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        await ctx.titles.apply(
          id,
          {name: 'endorse', to: BANK, inBlank: false},
          staffOf(SHIPPER),
        );
        const before = await ctx.repo.getTitle(id);
        const cases = [
          [
            CARRIER,
            {name: 'endorse', to: BUYER, inBlank: false},
            403,
            'not-holder',
          ],
          [BANK, {name: 'release'}, 409, 'wrong-state'],
          [CARRIER, {name: 'deliver'}, 409, 'wrong-kind'],
          [BANK, {name: 'transfer', to: BUYER}, 409, 'not-endorsed-in-blank'],
          [
            BANK,
            {name: 'endorse', to: BANK, inBlank: false},
            409,
            'same-holder',
          ],
          [CARRIER, {name: 'void'}, 409, 'wrong-state'],
          [BANK, {name: 'endorse', inBlank: false}, 400, 'missing-recipient'],
          [BANK, {name: 'toString'}, 400, 'unknown-command'],
        ];
        for (const [org, command, status, code] of cases) {
          const error = await refused(
            ctx.titles.apply(id, command, staffOf(org)),
          );
          expect(error.statusCode, code).to.equal(status);
          expect(error.details, code).to.deep.equal({code});
          expect(error.message, code).to.be.a('string').and.not.equal('');
        }
        expect(await ctx.repo.getTitle(id)).to.deep.equal(before);
      });
    });

    describe('reading a title', () => {
      it('shows the carrier, the holder and the consignee their commands, and nobody else', async () => {
        const id = await committedBl(ctx, 'CB31-READ');
        const unissued = await ctx.titles.read(id, staffOf(CARRIER));
        expect(unissued).to.deep.equal({
          recordId: id,
          title: null,
          allowedCommands: ['issue'],
        });
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const holder = await ctx.titles.read(id, staffOf(SHIPPER));
        expect(holder.title.holder).to.equal(SHIPPER);
        expect(holder.allowedCommands).to.include.members([
          'endorse',
          'surrender',
        ]);
        expect(holder.allowedCommands).to.not.include('void');
        const carrier = await ctx.titles.read(id, staffOf(CARRIER));
        expect(carrier.allowedCommands).to.deep.equal(['void']);
        const stranger = await refused(ctx.titles.read(id, staffOf(STRANGER)));
        expect(stranger.statusCode).to.equal(404);
        expect(stranger.message).to.equal('B/L not found');

        const straight = await committedBl(ctx, 'CB31-READ-S', {
          kind: 'straight',
        });
        await ctx.titles.apply(straight, {name: 'issue'}, staffOf(CARRIER));
        const consignee = await ctx.titles.read(straight, staffOf(CONSIGNEE));
        expect(consignee.title.consignee).to.equal(CONSIGNEE);
        expect(consignee.allowedCommands).to.deep.equal([]);
      });
    });

    describe('modules off', () => {
      it('refuses a negotiable B/L with only sea waybills on (409), issuing a straight one', async () => {
        const waybillOnly = await makeServices(store, {
          modules: modulesFromSettings({LRFE_BL_MODULES: 'waybill'}),
        });
        try {
          const id = await committedBl(waybillOnly, 'CB31-OFF');
          const error = await refused(
            waybillOnly.titles.apply(id, {name: 'issue'}, staffOf(CARRIER)),
          );
          expect(error.statusCode).to.equal(409);
          expect(error.details.code).to.equal('module-off');
          expect(error.message).to.equal(
            'Negotiable B/Ls are not enabled on this platform',
          );
          expect(await waybillOnly.repo.getTitle(id)).to.equal(null);
          const read = await waybillOnly.titles.read(id, staffOf(CARRIER));
          expect(read.allowedCommands).to.deep.equal([]);
          const straight = await committedBl(waybillOnly, 'CB31-ON', {
            kind: 'straight',
          });
          const view = await waybillOnly.titles.apply(
            straight,
            {name: 'issue'},
            staffOf(CARRIER),
          );
          expect(view.title.state).to.equal('issued');
        } finally {
          await waybillOnly.close();
        }
      });

      it('refuses an endorsement in blank with blank endorsement off (409), the title unchanged', async () => {
        const noBlank = await makeServices(store, {
          modules: modulesFromSettings({LRFE_BL_MODULES: 'negotiable'}),
        });
        try {
          const id = await committedBl(noBlank, 'CB31-NO-BLANK');
          await noBlank.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const before = await noBlank.repo.getTitle(id);
          const error = await refused(
            noBlank.titles.apply(
              id,
              {name: 'endorse', to: BANK, inBlank: true},
              staffOf(SHIPPER),
            ),
          );
          expect(error.statusCode).to.equal(409);
          expect(error.message).to.equal(
            'Endorsing in blank is not enabled on this platform',
          );
          expect(await noBlank.repo.getTitle(id)).to.deep.equal(before);
        } finally {
          await noBlank.close();
        }
      });
    });

    describe('commands at the same moment', () => {
      it('lets exactly one of two endorsements read together win; the other gets 409', async () => {
        for (let round = 1; round <= 5; round++) {
          const id = await committedBl(ctx, `CB31-RACE-${round}`);
          await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const racing = racingTitles(ctx);
          const targets = [BANK, BUYER];
          const results = await Promise.allSettled(
            targets.map(to =>
              racing.apply(
                id,
                {name: 'endorse', to, inBlank: false},
                staffOf(SHIPPER),
              ),
            ),
          );
          const won = results.filter(r => r.status === 'fulfilled');
          const lost = results.filter(r => r.status === 'rejected');
          expect(won, `round ${round}`).to.have.length(1);
          expect(lost, `round ${round}`).to.have.length(1);
          expect(lost[0].reason.statusCode).to.equal(409);
          expect(lost[0].reason.message).to.equal(
            'This B/L changed meanwhile: read it again',
          );
          expect(lost[0].reason.details).to.deep.equal({
            code: 'changed-meanwhile',
          });
          const winner = won[0].value.title.holder;
          expect(targets).to.include(winner);
          expect(await ctx.repo.getTitle(id)).to.include({
            holder: winner,
            revision: 2,
          });
        }
      });

      it('lets exactly one of two endorsements fired at once win, however they interleave', async () => {
        for (let round = 1; round <= 10; round++) {
          const id = await committedBl(ctx, `CB31-FIRED-${round}`);
          await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const targets = [BANK, BUYER];
          const results = await Promise.allSettled(
            targets.map(to =>
              ctx.titles.apply(
                id,
                {name: 'endorse', to, inBlank: false},
                staffOf(SHIPPER),
              ),
            ),
          );
          const won = results.filter(r => r.status === 'fulfilled');
          const lost = results.filter(r => r.status === 'rejected');
          expect(won, `round ${round}`).to.have.length(1);
          expect(lost, `round ${round}`).to.have.length(1);
          // read together: 409; read after the winner: the shipper no longer sees the B/L (404)
          expect([409, 404]).to.include(lost[0].reason.statusCode);
          const stored = await ctx.repo.getTitle(id);
          expect(stored.holder).to.equal(won[0].value.title.holder);
          expect(stored.revision).to.equal(2);
        }
      });

      it('issues once when two issues race (409 for the other)', async () => {
        for (let round = 1; round <= 3; round++) {
          const id = await committedBl(ctx, `CB31-ISSUE-RACE-${round}`);
          const racing = racingTitles(ctx);
          const results = await Promise.allSettled([
            racing.apply(id, {name: 'issue'}, staffOf(CARRIER)),
            racing.apply(id, {name: 'issue'}, staffOf(CARRIER)),
          ]);
          const won = results.filter(r => r.status === 'fulfilled');
          const lost = results.filter(r => r.status === 'rejected');
          expect(won).to.have.length(1);
          expect(lost).to.have.length(1);
          expect(lost[0].reason.details).to.deep.equal({
            code: 'changed-meanwhile',
          });
          expect(await ctx.repo.getTitle(id)).to.include({revision: 1});
        }
      });
    });

    describe('one title per B/L', () => {
      it('never stores a second title for the same B/L', async () => {
        const id = await committedBl(ctx, 'CB31-ONE');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const first = await ctx.repo.getTitle(id);
        const second = {...first, holder: STRANGER};
        expect(await ctx.repo.createTitle(second)).to.equal(null);
        expect(await ctx.repo.getTitle(id)).to.deep.equal(first);
      });

      if (store.name === 'PostgreSQL') {
        it('has the database refuse a second row for the same B/L, and a row for no B/L', async () => {
          const id = await committedBl(ctx, 'CB31-CONSTRAINT');
          await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
          const row = await ctx.repo.getTitle(id);
          const {Title} = ctx.repo.models;
          const duplicate = await refused(
            Title.create({...row, holder: STRANGER}),
          );
          expect(duplicate).to.be.instanceOf(UniqueConstraintError);
          const orphan = await refused(
            Title.create({
              ...row,
              recordId: '00000000-0000-4000-8000-000000000000',
            }),
          );
          expect(orphan).to.be.instanceOf(ForeignKeyConstraintError);
          const [rows] = await ctx.sequelize.query(
            'SELECT count(*)::int AS n FROM shipping_records.bl_title WHERE "recordId" = :id',
            {replacements: {id}},
          );
          expect(rows[0].n).to.equal(1);
        });
      }
    });
  });
}
