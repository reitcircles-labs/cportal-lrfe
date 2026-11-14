import {readFileSync} from 'node:fs';

import {expect} from 'chai';

import {
  FORMATS,
  assertBillOfLading,
  billOfLadingHash,
} from '../src/bill-of-lading/index.js';
import {endorseeOf} from '../src/title/index.js';

/**
 * CB-37: the endorsee is not written into the stored document (decision, Jira CB-37 comment
 * 11579). The chain of title records each endorsement; when a B/L is written out in DCSA, the
 * converter overlays the latest named endorsement's organisation as `documentParties.endorsee`
 * (DCSA eBL 3.0: no endorsee on a B/L to order means blank endorsed). After a blank endorsement,
 * and the transfers after it, there is no endorsee; after a later named endorsement, that one.
 *
 * Interfaces chosen for the builder (the design leaves them open; no route writes a B/L out in
 * DCSA yet, so the converter is tested as a function):
 * - `endorseeOf(entries)` in `@lrfe/domain-shipping/title`: from a B/L's chain of title (CB-32
 *   entries, in seq order), the organisation the B/L is endorsed to by name: the `to` of the
 *   latest `endorse` entry when its `endorsement` is `named`; null when that entry is a blank
 *   endorsement, or there is no endorsement. Commands after it (transfer, surrender, release)
 *   do not change it.
 * - `fromModel(billOfLading, {status, endorsee})` of the DCSA 3.0 converter: `endorsee` absent
 *   (undefined) writes the document as stored (as before CB-37); null writes it without any
 *   `documentParties.endorsee` (a stored one is left out: blank endorsed); a DCSA Endorsee party
 *   (e.g. `{partyName}`) is written as `documentParties.endorsee`. Never changes the B/L it is
 *   given. An endorsee on a B/L not to order (`isToOrder` false) is an error: DCSA allows one
 *   only on a B/L to order.
 */

const EXAMPLES = new URL('../dcsa/3.0.3/examples/', import.meta.url);
const dcsa = FORMATS['dcsa-3.0'];

const CARRIER = 'org-carrier';
const SHIPPER = 'org-shipper';
const BANK_A = 'org-bank-a';
const BANK_B = 'org-bank-b';
const BUYER = 'org-buyer';

/**
 * The party the service would build from the buyer's organisation: a DCSA Endorsee needs its
 * name and at least one identifying code.
 */
const BUYER_PARTY = Object.freeze({
  partyName: 'Buyer Trading Ltd',
  identifyingCodes: [{codeListProvider: 'GLEIF', partyCode: 'BUYER-LEI-0001'}],
});

/**
 * DCSA's regular example (a B/L to order) as a B/L of the model.
 * @return {{schemaVersion: string, document: object}}
 */
function negotiableBl() {
  const external = JSON.parse(
    readFileSync(new URL('td-regular.json', EXAMPLES), 'utf8'),
  );
  return dcsa.toModel(external).billOfLading;
}

/**
 * A chain entry as far as endorseeOf reads it.
 * @param {number} seq
 * @param {string} command
 * @param {?string} from
 * @param {?string} to
 * @param {string} endorsement the title's endorsement after the command
 * @return {object}
 */
function entry(seq, command, from, to, endorsement) {
  return {seq, command, from, to, endorsement};
}

/** The mixed journey of CB-37: issue, blank, transfer, named, surrender, release. */
const MIXED = Object.freeze([
  entry(1, 'issue', null, SHIPPER, 'none'),
  entry(2, 'endorse', SHIPPER, BANK_A, 'blank'),
  entry(3, 'transfer', BANK_A, BANK_B, 'blank'),
  entry(4, 'endorse', BANK_B, BUYER, 'named'),
  entry(5, 'surrender', BUYER, CARRIER, 'named'),
  entry(6, 'release', CARRIER, null, 'named'),
]);

describe('the endorsee of a B/L written out (CB-37)', () => {
  describe('endorseeOf: the latest named endorsement in the chain of title', () => {
    it('is null for no chain and for an issued B/L not endorsed yet', () => {
      expect(endorseeOf([])).to.equal(null);
      expect(endorseeOf(MIXED.slice(0, 1))).to.equal(null);
    });

    it('is null after a blank endorsement', () => {
      expect(endorseeOf(MIXED.slice(0, 2))).to.equal(null);
    });

    it('stays null after a transfer of the blank-endorsed B/L', () => {
      expect(endorseeOf(MIXED.slice(0, 3))).to.equal(null);
    });

    it('is the organisation of a later named endorsement', () => {
      expect(endorseeOf(MIXED.slice(0, 4))).to.equal(BUYER);
    });

    it('keeps the named endorsee through surrender and release', () => {
      expect(endorseeOf(MIXED.slice(0, 5))).to.equal(BUYER);
      expect(endorseeOf(MIXED)).to.equal(BUYER);
    });

    it('is the latest of several named endorsements', () => {
      const chain = [
        entry(1, 'issue', null, SHIPPER, 'none'),
        entry(2, 'endorse', SHIPPER, BANK_A, 'named'),
        entry(3, 'endorse', BANK_A, BUYER, 'named'),
      ];
      expect(endorseeOf(chain)).to.equal(BUYER);
    });

    it('is null when a named endorsee endorses the B/L on in blank', () => {
      const chain = [
        entry(1, 'issue', null, SHIPPER, 'none'),
        entry(2, 'endorse', SHIPPER, BANK_A, 'named'),
        entry(3, 'endorse', BANK_A, BANK_B, 'blank'),
      ];
      expect(endorseeOf(chain)).to.equal(null);
    });

    it('never changes the chain it reads', () => {
      const chain = structuredClone(MIXED);
      endorseeOf(chain);
      expect(chain).to.deep.equal(MIXED);
    });
  });

  describe("the DCSA 3.0 converter's endorsee overlay (fromModel)", () => {
    it('writes the document as stored when no endorsee is given (as before CB-37)', () => {
      const billOfLading = negotiableBl();
      const out = dcsa.fromModel(billOfLading, {status: 'ISSUED'});
      expect(out).to.deep.equal({
        transportDocumentStatus: 'ISSUED',
        ...billOfLading.document,
      });
    });

    it('writes a named endorsement’s organisation as documentParties.endorsee', () => {
      const out = dcsa.fromModel(negotiableBl(), {
        status: 'ISSUED',
        endorsee: BUYER_PARTY,
      });
      expect(out.documentParties.endorsee).to.deep.equal(BUYER_PARTY);
    });

    it('keeps every other party and field as stored', () => {
      const billOfLading = negotiableBl();
      const out = dcsa.fromModel(billOfLading, {
        status: 'ISSUED',
        endorsee: BUYER_PARTY,
      });
      const expected = structuredClone(billOfLading.document);
      expected.documentParties.endorsee = BUYER_PARTY;
      expect(out).to.deep.equal({
        transportDocumentStatus: 'ISSUED',
        ...expected,
      });
    });

    it('writes no endorsee for a blank-endorsed B/L (endorsee null), even one stored in the document', () => {
      const billOfLading = negotiableBl();
      billOfLading.document.documentParties.endorsee = {
        partyName: 'Written At Drafting Ltd',
      };
      const out = dcsa.fromModel(billOfLading, {
        status: 'ISSUED',
        endorsee: null,
      });
      expect(out.documentParties).to.not.have.property('endorsee');
      expect(out.documentParties.shipper).to.deep.equal(
        billOfLading.document.documentParties.shipper,
      );
    });

    it('replaces an endorsee stored in the document with the named endorsement’s', () => {
      const billOfLading = negotiableBl();
      billOfLading.document.documentParties.endorsee = {
        partyName: 'Written At Drafting Ltd',
      };
      const out = dcsa.fromModel(billOfLading, {
        status: 'ISSUED',
        endorsee: BUYER_PARTY,
      });
      expect(out.documentParties.endorsee).to.deep.equal(BUYER_PARTY);
    });

    it('writes a DCSA document that is still a valid B/L of the model', () => {
      const out = dcsa.fromModel(negotiableBl(), {
        status: 'ISSUED',
        endorsee: BUYER_PARTY,
      });
      const {billOfLading} = dcsa.toModel(out);
      expect(assertBillOfLading(billOfLading)).to.equal(billOfLading);
    });

    it('never changes the stored B/L or its hash', () => {
      const billOfLading = negotiableBl();
      const copy = structuredClone(billOfLading);
      const hash = billOfLadingHash(billOfLading);
      const party = {partyName: 'Buyer Trading Ltd'};
      const out = dcsa.fromModel(billOfLading, {
        status: 'ISSUED',
        endorsee: party,
      });
      out.documentParties.endorsee.partyName = 'Changed After Writing';
      dcsa.fromModel(billOfLading, {status: 'ISSUED', endorsee: null});
      expect(billOfLading).to.deep.equal(copy);
      expect(billOfLadingHash(billOfLading)).to.equal(hash);
      expect(party).to.deep.equal({partyName: 'Buyer Trading Ltd'});
    });

    it('refuses an endorsee on a B/L not to order (DCSA allows one only to order)', () => {
      const billOfLading = negotiableBl();
      billOfLading.document.isToOrder = false;
      expect(() =>
        dcsa.fromModel(billOfLading, {status: 'ISSUED', endorsee: BUYER_PARTY}),
      ).to.throw(/to order/);
    });

    it('refuses an endorsee on a B/L that names a consignee (DCSA: a consignee or an endorsee, not both)', () => {
      const billOfLading = negotiableBl();
      billOfLading.document.documentParties.consignee = {
        partyName: 'Consignee Ltd',
      };
      const copy = structuredClone(billOfLading);
      expect(() =>
        dcsa.fromModel(billOfLading, {status: 'ISSUED', endorsee: BUYER_PARTY}),
      ).to.throw(/consignee/);
      expect(billOfLading).to.deep.equal(copy);
    });

    it('follows the mixed journey: no endorsee after the blank endorsement and the transfer, the buyer after the named one', () => {
      const billOfLading = negotiableBl();
      const endorseeAfter = n => {
        const org = endorseeOf(MIXED.slice(0, n));
        const party = org === BUYER ? BUYER_PARTY : null;
        return dcsa.fromModel(billOfLading, {status: 'ISSUED', endorsee: party})
          .documentParties.endorsee;
      };
      expect(endorseeAfter(2)).to.equal(undefined);
      expect(endorseeAfter(3)).to.equal(undefined);
      expect(endorseeAfter(4)).to.deep.equal(BUYER_PARTY);
      expect(endorseeAfter(6)).to.deep.equal(BUYER_PARTY);
    });
  });
});
