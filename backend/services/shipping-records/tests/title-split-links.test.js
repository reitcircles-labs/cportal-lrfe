import {AppError, createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {makeHttp, stores} from './helpers.js';
import {
  OTHER_PORT,
  splitBody,
  splitByContainer,
  twoContainerBl,
} from './split-documents.js';

/**
 * CB-50: what the B/L page of the amendment and split screens reads, through the API.
 *
 * 1. The title read links a split's B/Ls: a split parent names its children (`splitInto:
 *    [{recordId, recordNo}]`, by number), a child its parent (`splitFrom:
 *    {recordId, recordNo}`); a B/L of its own has neither. The command answers carry the same.
 * 2. Earlier holders never get the new values: the record and version reads stay the carrier's
 *    own (404 for every other organisation, past holders included), for the amended B/L and for
 *    a split's children; the title read gives versions and hashes, never a document.
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

/** How many references nextReference gave. */
let references = 0;

/**
 * A new transport document reference, so each B/L of a test is new (at most 20 characters).
 * @param {string} label
 * @return {string}
 */
function nextReference(label) {
  references += 1;
  const suffix = `-${references}`;
  return `CB50-${label}`.slice(0, 20 - suffix.length) + suffix;
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

/** The audit service as the title service's client sees it, with nothing anchored yet. */
const NOTHING_ANCHORED = Object.freeze({
  /**
   * @return {!Promise<object>}
   */
  async entryProof() {
    throw new AppError(404, 'There is no trail entry for this event');
  },
});

/**
 * Runs a title command over HTTP as a user, expected to succeed: its answer's body.
 * @param {object} ctx makeHttp's answer
 * @param {string} id the B/L
 * @param {string} name the command
 * @param {object} user the caller
 * @param {object} [body] the command's arguments
 * @return {!Promise<object>}
 */
async function ok(ctx, id, name, user, body = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/records/${id}/title/${name}`,
    headers: ctx.as(user),
    payload: body,
  });
  expect(res.statusCode, `${name}: ${res.body}`).to.equal(200);
  return res.json();
}

/**
 * Reads a URL over HTTP as a user: the raw answer.
 * @param {object} ctx
 * @param {string} url
 * @param {object} user
 * @return {!Promise<object>}
 */
function get(ctx, url, user) {
  return ctx.app.inject({method: 'GET', url, headers: ctx.as(user)});
}

/**
 * Reads a B/L's title as a user, expected to succeed: its body.
 * @param {object} ctx
 * @param {string} id
 * @param {object} user
 * @return {!Promise<object>}
 */
async function readTitle(ctx, id, user) {
  const res = await get(ctx, `/records/${id}/title`, user);
  expect(res.statusCode, res.body).to.equal(200);
  return res.json();
}

/**
 * A B/L to order of the carrier with two containers, issued to the shipper and endorsed to the
 * bank by name, then surrendered for amendment by the bank: its id and reference.
 * @param {object} ctx
 * @param {string} label
 * @return {!Promise<{id: string, reference: string}>}
 */
async function heldForAmendment(ctx, label) {
  const reference = nextReference(label);
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
  await ok(ctx, record.id, 'issue', staffOf(CARRIER));
  await ok(ctx, record.id, 'endorse', staffOf(SHIPPER), {
    to: BANK,
    inBlank: false,
  });
  await ok(ctx, record.id, 'surrender-for-amendment', staffOf(BANK));
  return {id: record.id, reference};
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

for (const store of stores()) {
  describe(`the B/L page's reads of an amendment and a split (CB-50), ${store.name}`, () => {
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

    /**
     * A B/L held for amendment, split by container into two children.
     * @param {string} label
     * @return {!Promise<{id: string, reference: string, view: object, children: !Array<string>}>}
     */
    async function splitBl(label) {
      const {id, reference} = await heldForAmendment(ctx, label);
      const children = [nextReference('A'), nextReference('B')];
      const view = await ok(
        ctx,
        id,
        'split',
        staffOf(CARRIER),
        splitBody(splitByContainer(...children)),
      );
      return {id, reference, view, children};
    }

    describe('the title read links the B/Ls of a split', () => {
      // (changed: CB-50 build) "in the split's order" was asked first: that order is stored
      // nowhere (the children share one time), so the read names them by number
      it('a split parent names its children, by number, for its carrier', async () => {
        const {id, view, children} = await splitBl('PARENT');
        const read = await readTitle(ctx, id, staffOf(CARRIER));
        expect(read.splitInto).to.have.deep.members(view.children);
        expect(read.splitInto.map(c => c.recordNo)).to.deep.equal(
          [...children].sort(),
        );
      });

      it('the split answer names them the same way', async () => {
        const {view} = await splitBl('ANSWER');
        expect(view.splitInto).to.deep.equal(view.children);
      });

      it('an earlier holder of the parent sees its children named too', async () => {
        const {id, view} = await splitBl('EARLIER');
        const read = await readTitle(ctx, id, staffOf(SHIPPER));
        expect(read.roles).to.include('past-holder');
        expect(read.splitInto).to.deep.equal(view.children);
      });

      it('a child names the B/L it was split from, for its holder and its carrier', async () => {
        const {id, reference, view} = await splitBl('CHILD');
        for (const child of view.children) {
          for (const org of [BANK, CARRIER]) {
            const read = await readTitle(ctx, child.recordId, staffOf(org));
            expect(read.splitFrom, org).to.deep.equal({
              recordId: id,
              recordNo: reference,
            });
            expect(read, org).to.not.have.property('splitInto');
          }
        }
      });

      it('a B/L of its own has neither link, before and after an amendment', async () => {
        const {id, reference} = await heldForAmendment(ctx, 'OWN');
        const before = await readTitle(ctx, id, staffOf(CARRIER));
        expect(before).to.not.have.property('splitFrom');
        expect(before).to.not.have.property('splitInto');
        const amended = await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        expect(amended).to.not.have.property('splitFrom');
        expect(amended).to.not.have.property('splitInto');
      });

      it('an organisation that does not see the parent still gets 404 for it', async () => {
        const {id} = await splitBl('HIDDEN');
        const res = await get(ctx, `/records/${id}/title`, staffOf(STRANGER));
        expect(res.statusCode).to.equal(404);
      });
    });

    describe('earlier holders never get the new values', () => {
      it("an amended B/L's record and versions are the carrier's alone: 404 for its past and current holders", async () => {
        const {id, reference} = await heldForAmendment(ctx, 'AMENDED');
        await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        const urls = [
          `/records/${id}`,
          `/records/${id}/versions`,
          `/records/${id}/versions/1`,
          `/records/${id}/versions/2`,
        ];
        for (const org of [SHIPPER, BANK, STRANGER]) {
          for (const url of urls) {
            const res = await get(ctx, url, staffOf(org));
            expect(res.statusCode, `${org} ${url}`).to.equal(404);
          }
        }
        const own = await get(
          ctx,
          `/records/${id}/versions/2`,
          staffOf(CARRIER),
        );
        expect(own.statusCode).to.equal(200);
      });

      it('the title read gives an earlier holder the version number and hash, never the document', async () => {
        const {id, reference} = await heldForAmendment(ctx, 'NOVALUES');
        await ok(ctx, id, 'amend', staffOf(CARRIER), {
          format: 'dcsa-3.0',
          document: amendedDocument(reference),
        });
        const read = await readTitle(ctx, id, staffOf(SHIPPER));
        expect(read.title.issuedVersion).to.equal(2);
        expect(JSON.stringify(read)).to.not.include(OTHER_PORT);
        expect(JSON.stringify(read)).to.not.include('"document"');
      });

      it("a split's children are records of the carrier alone: 404 for the parent's earlier holder", async () => {
        const {view} = await splitBl('CHILDREN');
        for (const child of view.children) {
          for (const url of [
            `/records/${child.recordId}`,
            `/records/${child.recordId}/versions/1`,
            `/records/${child.recordId}/title`,
          ]) {
            const res = await get(ctx, url, staffOf(SHIPPER));
            expect(res.statusCode, url).to.equal(404);
          }
        }
      });
    });
  });
}
