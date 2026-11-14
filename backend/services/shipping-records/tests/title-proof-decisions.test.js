import {AppError, createLocalSigner} from '@lrfe/common';
import {expect} from 'chai';

import {titleEventIdOf} from '../src/title.service.js';
import {exampleWithReference, makeHttp, stores} from './helpers.js';

/**
 * CB-33, the points the agreed design leaves open, as decided for the build: the proof of a B/L
 * not issued yet is 404 "B/L not found"; while the audit service cannot answer the proof is 503,
 * never "pending"; the event of an entry has an id made from the B/L and the seq.
 */

const CARRIER = 'org-carrier';
const carrier = {
  id: 'u-carrier',
  name: 'Anna Shikongo',
  org: CARRIER,
  perms: ['bl.read', 'bl.draft'],
};
const approver = {id: 'u-approver', name: 'Petrus Amutenya', org: CARRIER};

/**
 * A committed B/L of the carrier, the shipper linked: its id.
 * @param {object} ctx makeHttp's answer
 * @param {string} reference
 * @return {!Promise<string>}
 */
async function committedBl(ctx, reference) {
  const record = await ctx.service.createRecord(
    {
      format: 'dcsa-3.0',
      document: exampleWithReference(reference),
      partyOrganisations: {shipper: 'org-shipper'},
    },
    carrier,
    CARRIER,
  );
  await ctx.service.submit(record.id, 1, carrier, CARRIER);
  await ctx.service.commit(record.id, 1, {by: approver}, 'bpm');
  return record.id;
}

for (const store of stores()) {
  describe(`the title proof's open points (CB-33), ${store.name}`, () => {
    let ctx;
    let failWith;
    beforeEach(async () => {
      failWith = null;
      const audit = {
        async entryProof() {
          throw failWith;
        },
      };
      ctx = await makeHttp(store, {signer: await createLocalSigner(), audit});
    });
    afterEach(async () => {
      await ctx.close();
    });

    /**
     * Reads the proof as the carrier.
     * @param {string} id
     * @return {!Promise<object>}
     */
    const proofOf = id =>
      ctx.app.inject({
        url: `/records/${id}/title/proof`,
        headers: ctx.as(carrier),
      });

    it('answers 404 "B/L not found" for a B/L not issued yet, even to its owner', async () => {
      const id = await committedBl(ctx, 'CB33-NOT-ISSUED');
      const res = await proofOf(id);
      expect(res.statusCode).to.equal(404);
      expect(res.json().message).to.equal('B/L not found');
    });

    it('answers 503 with a plain reason while the audit service cannot answer, never pending', async () => {
      const id = await committedBl(ctx, 'CB33-AUDIT-DOWN');
      await ctx.titles.apply(id, {name: 'issue'}, carrier);
      for (const status of [503, 502, 500]) {
        failWith = new AppError(status, 'The audit service cannot be reached');
        const res = await proofOf(id);
        expect(res.statusCode, String(status)).to.equal(503);
        expect(res.json().message).to.equal(
          'The proof on the blockchain cannot be read now: try again later.',
        );
        expect(res.body).not.to.include('pending');
      }
      failWith = new TypeError('fetch failed');
      expect((await proofOf(id)).statusCode).to.equal(503);
    });

    it("publishes each entry's event with an id made from the B/L and the seq", async () => {
      const id = await committedBl(ctx, 'CB33-EVENT-ID');
      await ctx.titles.apply(id, {name: 'issue'}, carrier);
      const [event] = ctx.published.filter(
        e => e.type === 'records.title.issue',
      );
      expect(event.id).to.equal(titleEventIdOf(id, 1));
      expect(event.id).to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(titleEventIdOf(id, 2)).not.to.equal(event.id);
    });
  });
}
