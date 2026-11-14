import {randomUUID} from 'node:crypto';

import {AppError, createEventBus, createLocalSigner} from '@lrfe/common';
import {formatsFromSettings} from '@lrfe/domain-shipping/bill-of-lading';
import {modulesFromSettings} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {verifyTitleChain} from '../src/chain.js';
import {ShippingRecordsService} from '../src/records.service.js';
import {TitleService} from '../src/title.service.js';
import {
  ACTIVE_ORGANISATIONS,
  exampleWithReference,
  makeClock,
  makeHttp,
  stores,
} from './helpers.js';

/**
 * CB-33: the chain of title on the audit trail and the blockchain, on the shipping records side.
 * Each entry is published as `records.title.<command>` with {recordId, recordNo, seq, entry} in
 * the same transaction as the title and the entry (nothing on a refusal or a lost race); GET
 * /records/:id/title/proof gives the parties a title proof bundle (lrfe-title-proof/1): every
 * entry, the platform's keys and the audit's trail-entry proof of the last entry once anchored.
 *
 * The audit service is a stand-in here: the title service's `audit` client, whose
 * `entryProof(eventId)` answers what the audit service's route answers (an lrfe-audit-proof/1
 * proof; status `waiting` before the anchoring; 404 while the event is not on the trail). The
 * real route and the offline verifier are tested in the audit service's tests.
 */

/** The organisations of the tests: the carrier owns the B/Ls. */
const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK = 'org-bank';
const BUYER = 'org-buyer';
const CONSIGNEE = 'org-consignee';
const STRANGER = 'org-stranger';

/** The event data of a chain entry: nothing else, never the document. */
const EVENT_FIELDS = ['entry', 'recordId', 'recordNo', 'seq'];

/** The carrier's staff: one drafts and submits, the other approves (four-eyes). */
const drafter = {id: 'u-c1', name: 'Anna Shikongo', org: CARRIER};
const approver = {id: 'u-c2', name: 'Petrus Amutenya', org: CARRIER};

/**
 * A person of an organisation, running title commands and reading B/Ls.
 * @param {string} org
 * @return {{id: string, name: string, org: string, perms: !Array<string>}}
 */
function staffOf(org) {
  return {
    id: `u-${org}`,
    name: `Staff of ${org}`,
    org,
    perms: ['bl.read', 'bl.draft', 'bl.issue', 'bl.endorse'],
  };
}

/**
 * The events about the chain of title among those published.
 * @param {!Array<object>} published
 * @return {!Array<object>}
 */
function titleEvents(published) {
  return published.filter(e => e.type.startsWith('records.title.'));
}

/**
 * The audit service as the title service's client sees it, answering from the events published:
 * `mode` is `anchored` (a confirmed trail-entry proof), `waiting` (on the trail, not anchored yet)
 * or `missing` (not on the trail yet: 404). `asked` lists the eventIds asked for.
 * @param {function(): !Array<object>} published the events published by the service so far
 * @return {{entryProof: function(string): !Promise<object>, asked: !Array<string>, mode: string,
 *     answers: !Map<string, object>}}
 */
function standInAudit(published) {
  const audit = {
    mode: 'anchored',
    asked: [],
    answers: new Map(),
    async entryProof(eventId) {
      audit.asked.push(eventId);
      const event = published().find(e => e.id === eventId);
      if (!event || audit.mode === 'missing') {
        throw new AppError(404, 'There is no trail entry for this event');
      }
      const anchored = audit.mode === 'anchored';
      const proof = {
        format: 'lrfe-audit-proof/1',
        status: anchored ? 'confirmed' : 'waiting',
        item: {
          kind: 'trail-entry',
          seq: 100 + event.data.seq,
          ...(anchored ? {checkpointSeq: 200} : {}),
        },
        trail: {
          entry: {
            seq: 100 + event.data.seq,
            eventId,
            type: event.type,
            source: event.source,
            time: event.time,
            actor: event.actor,
            subjects: [`record:${event.data.recordId}`],
            data: event.data,
            prevHash: 'a'.repeat(64),
            contentHash: 'b'.repeat(64),
            hash: 'c'.repeat(64),
          },
          later: [],
          checkpoint: anchored ? {seq: 200, hash: 'd'.repeat(64)} : null,
        },
        leaf: anchored
          ? {
              key: 'trail-checkpoint:200',
              type: 2,
              item: 'd'.repeat(64),
              index: 7,
              hash: 'e'.repeat(64),
            }
          : null,
        tree: anchored
          ? {size: 8, path: [], peaks: ['f'.repeat(64)], root: '1'.repeat(64)}
          : null,
        anchor: anchored
          ? {network: 'preview', tx: '2'.repeat(64), address: 'addr_test1q'}
          : null,
      };
      audit.answers.set(eventId, proof);
      return structuredClone(proof);
    },
  };
  return audit;
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
 * A B/L of the carrier, its first version committed, the shipper linked (and for a straight B/L
 * the consignee): its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} reference
 * @param {{straight?: boolean}} [options] a straight B/L instead of a negotiable one
 * @return {!Promise<string>}
 */
async function committedBl(ctx, reference, {straight = false} = {}) {
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
    drafter,
    CARRIER,
  );
  await ctx.service.submit(record.id, 1, drafter, CARRIER);
  await ctx.service.commit(record.id, 1, {by: approver}, 'bpm');
  return record.id;
}

/**
 * Issues a committed B/L to the shipper, who endorses it to the bank, who endorses it to the
 * buyer: three chain entries. Its id.
 * @param {object} ctx
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function journey(ctx, reference) {
  const id = await committedBl(ctx, reference);
  await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
  await ctx.titles.apply(
    id,
    {name: 'endorse', to: BANK, inBlank: false},
    staffOf(SHIPPER),
  );
  await ctx.titles.apply(
    id,
    {name: 'endorse', to: BUYER, inBlank: false},
    staffOf(BANK),
  );
  return id;
}

/**
 * Runs something expected to fail: the error.
 * @param {!Promise<*>} pending
 * @return {!Promise<!Error>}
 */
async function refused(pending) {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('It was not refused');
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
 * An event bus that keeps what is published inside `atomic` until the transaction ends: kept
 * when it succeeds, dropped when it fails. `outside` lists what was published outside any
 * transaction.
 * @return {object}
 */
function transactionalEvents() {
  const bus = {
    committed: [],
    outside: [],
    open: null,
    async publish(type, data = {}, {actor} = {}) {
      const event = {
        id: randomUUID(),
        type,
        source: 'shipping-records',
        time: new Date().toISOString(),
        actor: actor ? {id: actor.id, name: actor.name, org: actor.org} : null,
        data,
      };
      if (bus.open) {
        bus.open.push(event);
      } else {
        bus.outside.push(event);
      }
      return event;
    },
    subscribe() {
      return () => {};
    },
    async atomic(fn) {
      const outer = bus.open;
      const mine = [];
      bus.open = mine;
      try {
        const value = await fn();
        bus.committed.push(...mine);
        return value;
      } finally {
        bus.open = outer;
      }
    },
  };
  return bus;
}

for (const store of stores()) {
  describe(`the chain of title on the audit trail (CB-33), ${store.name}`, () => {
    let ctx;
    let audit;
    beforeEach(async () => {
      audit = standInAudit(() => ctx.published);
      ctx = await makeHttp(store, {signer: await createLocalSigner(), audit});
    });
    afterEach(async () => {
      await ctx.close();
    });

    describe('an event per chain entry', () => {
      it('publishes records.title.<command> for every entry, from shipping-records, with the full signed entry', async () => {
        const id = await journey(ctx, 'CB33-EVENTS');
        const chain = await ctx.repo.listTitleEntries(id);
        const record = await ctx.repo.getRecord(id);
        const events = titleEvents(ctx.published);
        expect(events.map(e => e.type)).to.deep.equal([
          'records.title.issue',
          'records.title.endorse',
          'records.title.endorse',
        ]);
        for (const [i, event] of events.entries()) {
          expect(event.source).to.equal('shipping-records');
          expect(event.data).to.deep.equal({
            recordId: id,
            recordNo: record.recordNo,
            seq: i + 1,
            entry: chain[i],
          });
        }
        expect(events.map(e => e.actor.id)).to.deep.equal([
          staffOf(CARRIER).id,
          staffOf(SHIPPER).id,
          staffOf(BANK).id,
        ]);
      });

      it('never puts the document in the event: only the record, its number, the seq and the entry', async () => {
        const id = await committedBl(ctx, 'CB33-NO-DOC');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const [event] = titleEvents(ctx.published);
        expect(Object.keys(event.data).sort()).to.deep.equal(EVENT_FIELDS);
        const text = JSON.stringify(event.data);
        expect(text).not.to.include('documentParties');
        expect(text).not.to.include('consignmentItems');
      });

      it('publishes nothing on a refusal', async () => {
        const id = await committedBl(ctx, 'CB33-REFUSED');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const before = titleEvents(ctx.published).length;
        expect(before, 'the issue is published').to.equal(1);
        // the carrier may not endorse (403), the holder may not release (409), no such command (400)
        const refusals = [
          [CARRIER, {name: 'endorse', to: BANK, inBlank: false}],
          [SHIPPER, {name: 'release'}],
          [SHIPPER, {name: 'toString'}],
          [CARRIER, {name: 'issue'}],
        ];
        for (const [org, command] of refusals) {
          const error = await refused(
            ctx.titles.apply(id, command, staffOf(org)),
          );
          expect(error.statusCode, command.name).to.be.within(400, 499);
        }
        expect(titleEvents(ctx.published)).to.have.length(before);
        expect(await ctx.repo.listTitleEntries(id)).to.have.length(1);
      });

      it('publishes one event for the winner of two endorsements at once, none for the loser', async () => {
        const id = await committedBl(ctx, 'CB33-RACE');
        await ctx.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        const racing = new TitleService({
          repo: {...ctx.repo, getTitle: together(ctx.repo.getTitle, 2)},
          events: ctx.titles.events,
          modules: modulesFromSettings({}),
          organisations: ACTIVE_ORGANISATIONS,
          clock: makeClock(),
          signer: ctx.titles.signer,
          audit,
        });
        const results = await Promise.allSettled(
          [BANK, BUYER].map(to =>
            racing.apply(
              id,
              {name: 'endorse', to, inBlank: false},
              staffOf(SHIPPER),
            ),
          ),
        );
        expect(results.filter(r => r.status === 'fulfilled')).to.have.length(1);
        const endorsed = titleEvents(ctx.published).filter(
          e => e.type === 'records.title.endorse',
        );
        expect(endorsed).to.have.length(1);
        const chain = await ctx.repo.listTitleEntries(id);
        expect(endorsed[0].data.entry).to.deep.equal(chain[1]);
      });
    });

    describe('in the same transaction as the title and its entry', () => {
      /**
       * The record and title services on this store, the title service publishing on `events`
       * and writing through `repo` (by default the store's).
       * @param {object} events
       * @param {function(object): object} [wrapRepo]
       * @return {!Promise<object>}
       */
      async function servicesOn(events, wrapRepo = repo => repo) {
        const records = new ShippingRecordsService({
          repo: ctx.repo,
          events: createEventBus({
            driver: 'memory',
            source: 'shipping-records',
          }),
          formats: formatsFromSettings({}),
          clock: makeClock(),
        });
        const titles = new TitleService({
          repo: wrapRepo(ctx.repo),
          events,
          modules: modulesFromSettings({}),
          organisations: ACTIVE_ORGANISATIONS,
          clock: makeClock(),
          signer: await createLocalSigner(),
          audit,
        });
        return {service: records, titles, repo: ctx.repo};
      }

      it('publishes the event inside the transaction, never outside it', async () => {
        const events = transactionalEvents();
        const services = await servicesOn(events);
        const id = await committedBl(services, 'CB33-ATOMIC');
        await services.titles.apply(id, {name: 'issue'}, staffOf(CARRIER));
        expect(events.outside.map(e => e.type)).to.deep.equal([]);
        expect(events.committed.map(e => e.type)).to.deep.equal([
          'records.title.issue',
        ]);
      });

      it('publishes nothing when the transaction fails after the title is written', async () => {
        const events = transactionalEvents();
        const services = await servicesOn(events, repo => ({
          ...repo,
          appendTitleEntry: async () => {
            throw new Error('The disk is full');
          },
        }));
        const id = await committedBl(services, 'CB33-ROLLBACK');
        await refused(
          services.titles.apply(id, {name: 'issue'}, staffOf(CARRIER)),
        );
        expect(events.committed).to.deep.equal([]);
        expect(events.outside).to.deep.equal([]);
        // the same bus keeps the event of a transaction that succeeds
        const working = await servicesOn(events);
        const other = await committedBl(working, 'CB33-ROLLBACK-OK');
        await working.titles.apply(other, {name: 'issue'}, staffOf(CARRIER));
        expect(events.committed.map(e => e.type)).to.deep.equal([
          'records.title.issue',
        ]);
        expect(events.outside).to.deep.equal([]);
      });
    });

    describe('the title proof (GET /records/:id/title/proof)', () => {
      /**
       * Reads the proof as a user.
       * @param {string} id
       * @param {object} user
       * @param {string} [query]
       * @return {!Promise<object>}
       */
      const proofAs = (id, user, query = '') =>
        ctx.app.inject({
          method: 'GET',
          url: `/records/${id}/title/proof${query}`,
          headers: ctx.as(user),
        });

      it('gives the bundle: format, the record, every entry, the keys and the anchor of the last entry', async () => {
        const id = await journey(ctx, 'CB33-PROOF');
        const res = await proofAs(id, staffOf(CARRIER));
        expect(res.statusCode, res.body).to.equal(200);
        const body = res.json();
        const chain = await ctx.repo.listTitleEntries(id);
        const keys = await ctx.app.inject({url: '/records/title/keys'});
        const last = titleEvents(ctx.published).at(-1);
        expect(body.format).to.equal('lrfe-title-proof/1');
        expect(body.recordId).to.equal(id);
        expect(body.recordNo).to.equal((await ctx.repo.getRecord(id)).recordNo);
        expect(body.entries).to.deep.equal(JSON.parse(JSON.stringify(chain)));
        expect(body.jwks).to.deep.equal(keys.json());
        expect(audit.asked.at(-1)).to.equal(last.id);
        expect(body.anchor).to.deep.equal(audit.answers.get(last.id));
        expect(body.anchor.trail.entry.data.entry).to.deep.equal(
          body.entries.at(-1),
        );
        expect(body.latest).to.equal(true);
      });

      it("gives a chain that verifies with the bundle's own keys", async () => {
        const id = await journey(ctx, 'CB33-VERIFIES');
        const body = (await proofAs(id, staffOf(BUYER))).json();
        const checked = await verifyTitleChain(body.entries, body.jwks);
        expect(checked.valid).to.equal(true);
      });

      it('never holds the document', async () => {
        const id = await journey(ctx, 'CB33-PROOF-NO-DOC');
        const res = await proofAs(id, staffOf(CARRIER));
        expect(res.statusCode, res.body).to.equal(200);
        const body = res.json();
        expect(body.entries).to.have.length(3);
        expect(body).not.to.have.any.keys('document', 'data', 'versions');
        expect(JSON.stringify(body)).not.to.include('documentParties');
      });

      it('says pending before the anchoring, and while the entry is not on the audit trail yet', async () => {
        const id = await journey(ctx, 'CB33-PENDING');
        for (const mode of ['waiting', 'missing']) {
          audit.mode = mode;
          const res = await proofAs(id, staffOf(CARRIER));
          expect(res.statusCode, `${mode}: ${res.body}`).to.equal(200);
          const body = res.json();
          expect(body.anchor, mode).to.deep.equal({pending: true});
          expect(body.entries, mode).to.have.length(3);
          expect(body.latest, mode).to.equal(true);
        }
      });

      it('gives an older entry (?seq=1): the entries up to it, its anchor, not the latest, naming the newer seq', async () => {
        const id = await journey(ctx, 'CB33-OLDER');
        const res = await proofAs(id, staffOf(CARRIER), '?seq=1');
        expect(res.statusCode, res.body).to.equal(200);
        const body = res.json();
        const first = titleEvents(ctx.published)[0];
        expect(body.entries).to.have.length(1);
        expect(body.entries[0].seq).to.equal(1);
        expect(body.anchor).to.deep.equal(audit.answers.get(first.id));
        expect(body.latest).to.equal(false);
        expect(body.latestSeq).to.equal(3);
      });

      it('says latest for the last seq asked by number', async () => {
        const id = await journey(ctx, 'CB33-LAST');
        const body = (await proofAs(id, staffOf(CARRIER), '?seq=3')).json();
        expect(body.entries).to.have.length(3);
        expect(body.latest).to.equal(true);
      });

      it('refuses a seq beyond the chain (404) and one that is not a number from 1 (400)', async () => {
        const id = await journey(ctx, 'CB33-BAD-SEQ');
        expect(
          (await proofAs(id, staffOf(CARRIER), '?seq=4')).statusCode,
        ).to.equal(404);
        for (const seq of ['0', '-1', 'abc', 'toString', '1.5']) {
          const res = await proofAs(id, staffOf(CARRIER), `?seq=${seq}`);
          expect(res.statusCode, seq).to.equal(400);
        }
      });

      it('lets the carrier, the current holder and the consignee read it', async () => {
        const id = await journey(ctx, 'CB33-PARTIES');
        for (const org of [CARRIER, BUYER]) {
          const res = await proofAs(id, staffOf(org));
          expect(res.statusCode, `${org}: ${res.body}`).to.equal(200);
        }
        const straight = await committedBl(ctx, 'CB33-STRAIGHT', {
          straight: true,
        });
        await ctx.titles.apply(straight, {name: 'issue'}, staffOf(CARRIER));
        const res = await proofAs(straight, staffOf(CONSIGNEE));
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().entries).to.have.length(1);
      });

      it('answers 404 to another organisation, a user of no organisation and for an unknown B/L', async () => {
        const id = await journey(ctx, 'CB33-STRANGERS');
        for (const user of [
          staffOf(STRANGER),
          {...staffOf(STRANGER), org: undefined},
        ]) {
          const res = await proofAs(id, user);
          expect(res.statusCode).to.equal(404);
          expect(res.json().message).to.equal('B/L not found');
        }
        const unknown = await proofAs(
          '00000000-0000-4000-8000-000000000099',
          staffOf(CARRIER),
        );
        expect(unknown.statusCode).to.equal(404);
        expect(audit.asked).to.have.length(0);
      });

      it('refuses a call without a token (401)', async () => {
        const id = await journey(ctx, 'CB33-NO-TOKEN');
        const res = await ctx.app.inject({url: `/records/${id}/title/proof`});
        expect(res.statusCode).to.equal(401);
      });
    });
  });
}
