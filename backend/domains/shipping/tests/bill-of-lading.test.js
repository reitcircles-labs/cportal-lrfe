import {readFileSync, readdirSync} from 'node:fs';

import {BadRequestError} from '@lrfe/common';
import {expect} from 'chai';

import {
  SCHEMA_VERSION,
  assertBillOfLading,
  billOfLadingHash,
  canonicalBillOfLading,
  checkBillOfLading,
} from '../src/bill-of-lading/index.js';

const EXAMPLES = new URL('../dcsa/3.0.3/examples/', import.meta.url);
const EXAMPLE_FILES = readdirSync(EXAMPLES).filter(f => f.endsWith('.json'));

/**
 * A DCSA example as a B/L of the model: the status left out (the title engine's).
 *
 * @param {string} file an example's file name
 * @return {object}
 */
function example(file = 'td-regular.json') {
  const document = JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8'));
  delete document.transportDocumentStatus;
  return {schemaVersion: SCHEMA_VERSION, document};
}

/**
 * The same value with the keys of every object in reverse order.
 *
 * @param {*} value
 * @return {*}
 */
function reversedKeys(value) {
  if (Array.isArray(value)) {
    return value.map(reversedKeys);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map(k => [k, reversedKeys(value[k])]),
    );
  }
  return value;
}

const messages = bl => checkBillOfLading(bl).map(p => p.message);

describe('the bill-of-lading model (CB-25)', () => {
  describe('valid B/Ls', () => {
    it('has six DCSA examples to test with', () => {
      expect(EXAMPLE_FILES).to.have.length(6);
    });

    for (const file of EXAMPLE_FILES) {
      it(`accepts DCSA's example ${file}`, () => {
        expect(checkBillOfLading(example(file))).to.deep.equal([]);
      });
    }

    it('accepts links of parties to organisations', () => {
      const bl = example();
      bl.partyOrganisations = {shipper: 'org-1', issuingParty: 'org-2'};
      if (bl.document.documentParties.notifyParties?.length) {
        bl.partyOrganisations['notifyParties.0'] = 'org-3';
      }
      expect(checkBillOfLading(bl)).to.deep.equal([]);
    });

    it('returns a valid B/L from assertBillOfLading', () => {
      const bl = example();
      expect(assertBillOfLading(bl)).to.equal(bl);
    });
  });

  describe('the record around the document', () => {
    it('refuses another schema version', () => {
      const bl = {...example(), schemaVersion: 'dcsa-ebl/2.0'};
      expect(messages(bl)).to.include(
        `schemaVersion must be ${SCHEMA_VERSION}`,
      );
    });

    it('refuses a missing document or a B/L that is not an object', () => {
      expect(messages({schemaVersion: SCHEMA_VERSION})).to.deep.equal([
        'document must be a DCSA transport document',
      ]);
      expect(messages(null)).to.deep.equal(['A B/L must be an object']);
    });

    it('refuses the status and feedbacks inside the document', () => {
      const bl = example();
      bl.document.transportDocumentStatus = 'ISSUED';
      bl.document.feedbacks = [];
      const paths = checkBillOfLading(bl).map(p => p.path);
      expect(paths).to.include.members([
        'transportDocumentStatus',
        'feedbacks',
      ]);
    });
  });

  describe("DCSA's schema", () => {
    it('names a missing required field', () => {
      const bl = example();
      delete bl.document.carrierCode;
      expect(messages(bl)).to.include(
        'carrierCode is missing (DCSA requires it)',
      );
    });

    it('names a missing field deep in the document', () => {
      const bl = example();
      delete bl.document.transports.portOfLoading;
      expect(messages(bl)).to.include(
        'transports.portOfLoading is missing (DCSA requires it)',
      );
    });

    it('refuses a value longer than DCSA allows', () => {
      const bl = example();
      bl.document.transportDocumentReference = 'X'.repeat(21);
      expect(checkBillOfLading(bl).map(p => p.path)).to.include(
        'transportDocumentReference',
      );
    });

    it('refuses a code that is not in the code list', () => {
      const bl = example();
      bl.document.transportDocumentTypeCode = 'XYZ';
      expect(messages(bl)).to.include(
        'transportDocumentTypeCode must be one of: BOL, SWB',
      );
    });

    it('refuses a date in the wrong format', () => {
      const bl = example();
      bl.document.issueDate = '14/11/2026';
      expect(checkBillOfLading(bl).map(p => p.path)).to.include('issueDate');
    });

    it('lists every problem, not only the first', () => {
      const bl = example();
      delete bl.document.carrierCode;
      bl.document.transportDocumentTypeCode = 'XYZ';
      expect(checkBillOfLading(bl)).to.have.length.of.at.least(2);
    });
  });

  describe('containers only', () => {
    it('refuses a B/L without containers, with a clear message', () => {
      const bl = example();
      bl.document.utilizedTransportEquipments = [];
      expect(() => assertBillOfLading(bl))
        .to.throw(BadRequestError)
        .with.property('message')
        .that.matches(/goods in containers only: list at least one container/);
    });

    it('explains a missing container list once, as the containers-only rule', () => {
      const bl = example();
      delete bl.document.utilizedTransportEquipments;
      const problems = checkBillOfLading(bl).filter(
        p => p.path === 'utilizedTransportEquipments',
      );
      expect(problems).to.have.length(1);
      expect(problems[0].message).to.match(/containers only/);
    });

    it('refuses a cargo item that is not in one of the containers', () => {
      const bl = example();
      bl.document.consignmentItems[0].cargoItems[0].equipmentReference =
        'ZZZU9999999';
      expect(messages(bl)).to.include(
        'This platform holds B/Ls for goods in containers only: ' +
          'consignmentItems[0].cargoItems[0] is in container ZZZU9999999, ' +
          "which is not one of this B/L's containers",
      );
    });

    it('refuses a container listed twice', () => {
      const bl = example();
      const equipments = bl.document.utilizedTransportEquipments;
      equipments.push(structuredClone(equipments[0]));
      const reference = equipments[0].equipment.equipmentReference;
      expect(messages(bl)).to.include(
        `Container ${reference} is listed more than once`,
      );
    });

    it('gives the 400 error every problem in its details', () => {
      const bl = example();
      bl.document.utilizedTransportEquipments = [];
      delete bl.document.carrierCode;
      try {
        assertBillOfLading(bl);
        expect.fail('no error');
      } catch (error) {
        expect(error.statusCode).to.equal(400);
        expect(error.message).to.match(/and \d+ more/);
        expect(error.details.problems.length).to.be.at.least(2);
      }
    });
  });

  describe("DCSA's party conditions", () => {
    it('refuses a sea waybill to order', () => {
      const bl = example();
      bl.document.transportDocumentTypeCode = 'SWB';
      bl.document.isToOrder = true;
      expect(messages(bl)).to.include(
        'A sea waybill (SWB) cannot be to order: isToOrder must be false',
      );
    });

    it('requires a consignee on a B/L that is not to order', () => {
      const bl = example();
      bl.document.isToOrder = false;
      delete bl.document.documentParties.consignee;
      delete bl.document.documentParties.endorsee;
      expect(messages(bl)).to.include(
        'A B/L that is not to order must name its consignee',
      );
    });

    it('refuses an endorsee on a B/L that is not to order', () => {
      const bl = example();
      bl.document.isToOrder = false;
      bl.document.documentParties.consignee = structuredClone(
        bl.document.documentParties.shipper,
      );
      bl.document.documentParties.endorsee = structuredClone(
        bl.document.documentParties.shipper,
      );
      expect(messages(bl)).to.include.members([
        'Only a B/L to order can have an endorsee',
        'A B/L names a consignee or an endorsee, not both',
      ]);
    });
  });

  describe('consignee or endorsee', () => {
    it('refuses a B/L to order that names both a consignee and an endorsee', () => {
      const bl = example();
      bl.document.isToOrder = true;
      const {shipper} = bl.document.documentParties;
      bl.document.documentParties.consignee = structuredClone(shipper);
      bl.document.documentParties.endorsee = structuredClone(shipper);
      expect(messages(bl)).to.include(
        'A B/L names a consignee or an endorsee, not both',
      );
      expect(messages(bl)).to.not.include(
        'Only a B/L to order can have an endorsee',
      );
    });

    it('still reports a schema error on a container listed twice', () => {
      const bl = example();
      const equipments = bl.document.utilizedTransportEquipments;
      equipments.push(structuredClone(equipments[0]));
      delete equipments[1].isShipperOwned;
      expect(messages(bl)).to.include(
        'utilizedTransportEquipments[1].isShipperOwned is missing (DCSA requires it)',
      );
    });
  });

  describe('links of parties to organisations', () => {
    it('refuses a party the document does not have', () => {
      const bl = example();
      bl.partyOrganisations = {'notifyParties.9': 'org-1', carrier: 'org-2'};
      expect(messages(bl)).to.include.members([
        'partyOrganisations.notifyParties.9: the document has no party notifyParties.9',
        'partyOrganisations.carrier: the document has no party carrier',
      ]);
    });

    it('refuses an empty organisation id and a links value that is not an object', () => {
      const bl = example();
      bl.partyOrganisations = {shipper: ' '};
      expect(messages(bl)).to.include(
        'partyOrganisations.shipper must be an organisation id',
      );
      bl.partyOrganisations = ['org-1'];
      expect(messages(bl)).to.include('partyOrganisations must be an object');
    });
  });

  describe('the canonical form and the hash', () => {
    it('gives the same hash whatever the order of the fields', () => {
      const bl = example('td-dangerous-goods.json');
      const shuffled = reversedKeys(bl);
      expect(JSON.stringify(shuffled)).to.not.equal(JSON.stringify(bl));
      expect(canonicalBillOfLading(shuffled)).to.equal(
        canonicalBillOfLading(bl),
      );
      expect(billOfLadingHash(shuffled)).to.equal(billOfLadingHash(bl));
    });

    it('gives the same hash every time, as 64 hex characters', () => {
      const hash = billOfLadingHash(example());
      expect(hash).to.match(/^[0-9a-f]{64}$/);
      expect(billOfLadingHash(example())).to.equal(hash);
    });

    it('changes the hash when any value changes, or the schema version', () => {
      const bl = example();
      const before = billOfLadingHash(bl);
      bl.document.consignmentItems[0].cargoItems[0].cargoGrossWeight.value += 1;
      expect(billOfLadingHash(bl)).to.not.equal(before);
      expect(
        billOfLadingHash({...example(), schemaVersion: 'dcsa-ebl/3.1'}),
      ).to.not.equal(before);
    });

    it('does not change the hash when a party is linked to an organisation', () => {
      const bl = example();
      const before = billOfLadingHash(bl);
      bl.partyOrganisations = {shipper: 'org-1'};
      expect(billOfLadingHash(bl)).to.equal(before);
    });

    it('keeps the order of lists (it is part of the document)', () => {
      const bl = example();
      bl.document.carrierClauses = ['first', 'second'];
      const before = billOfLadingHash(bl);
      bl.document.carrierClauses.reverse();
      expect(billOfLadingHash(bl)).to.not.equal(before);
    });
  });
});
