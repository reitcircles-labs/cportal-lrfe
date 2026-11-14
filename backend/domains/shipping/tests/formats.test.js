import {readFileSync, readdirSync} from 'node:fs';

import {BadRequestError} from '@lrfe/common';
import {expect} from 'chai';

import {
  FORMATS,
  SCHEMA_VERSION,
  assertBillOfLading,
  billOfLadingHash,
  formatNamed,
  formatsFromSettings,
} from '../src/bill-of-lading/index.js';

const EXAMPLES = new URL('../dcsa/3.0.3/examples/', import.meta.url);
const EXAMPLE_FILES = readdirSync(EXAMPLES).filter(f => f.endsWith('.json'));
const dcsa = FORMATS['dcsa-3.0'];

/**
 * One of DCSA's example transport documents, as DCSA writes it.
 *
 * @param {string} file the example's file name
 * @return {object}
 */
function dcsaExample(file) {
  return JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8'));
}

describe('B/L formats (CB-26)', () => {
  describe('the DCSA 3.0 converter', () => {
    for (const file of EXAMPLE_FILES) {
      it(`converts DCSA's example ${file} into the model and back without loss`, () => {
        const original = dcsaExample(file);
        const {billOfLading, status} = dcsa.toModel(original);
        expect(billOfLading.schemaVersion).to.equal(SCHEMA_VERSION);
        expect(status).to.equal(original.transportDocumentStatus);
        expect(assertBillOfLading(billOfLading)).to.equal(billOfLading);
        expect(dcsa.fromModel(billOfLading, {status})).to.deep.equal(original);
      });
    }

    it('keeps the status apart and drops the feedbacks (API messages)', () => {
      const original = dcsaExample('td-regular.json');
      original.feedbacks = [{severity: 'INFO', code: 'X', message: 'hello'}];
      const {billOfLading} = dcsa.toModel(original);
      expect(billOfLading.document).to.not.have.property(
        'transportDocumentStatus',
      );
      expect(billOfLading.document).to.not.have.property('feedbacks');
    });

    it('never changes the document it was given', () => {
      const original = dcsaExample('td-reefer.json');
      const copy = structuredClone(original);
      const {billOfLading} = dcsa.toModel(original);
      billOfLading.document.carrierCode = 'XXXX';
      expect(original).to.deep.equal(copy);
    });

    it('gives the same hash for the same B/L whatever its DCSA status', () => {
      const draft = dcsaExample('td-regular.json');
      const issued = {
        ...structuredClone(draft),
        transportDocumentStatus: 'ISSUED',
      };
      expect(billOfLadingHash(dcsa.toModel(draft).billOfLading)).to.equal(
        billOfLadingHash(dcsa.toModel(issued).billOfLading),
      );
    });

    it('refuses to write without a DCSA status, or a B/L of another model', () => {
      const {billOfLading} = dcsa.toModel(dcsaExample('td-regular.json'));
      expect(() => dcsa.fromModel(billOfLading, {status: 'LOST'})).to.throw(
        'Not a DCSA 3.0 status: LOST',
      );
      expect(() =>
        dcsa.fromModel(
          {...billOfLading, schemaVersion: 'dcsa-ebl/4.0'},
          {status: 'DRAFT'},
        ),
      ).to.throw(/not dcsa-ebl\/4.0/);
    });
  });

  describe('the LRFE_BL_FORMATS setting', () => {
    it('turns on DCSA 3.0 when not set', () => {
      expect(formatsFromSettings({}).map(f => f.name)).to.deep.equal([
        'dcsa-3.0',
      ]);
      expect(
        formatsFromSettings({LRFE_BL_FORMATS: ' '}).map(f => f.name),
      ).to.deep.equal(['dcsa-3.0']);
    });

    it('reads a list, ignoring spaces and repeats', () => {
      const formats = formatsFromSettings({
        LRFE_BL_FORMATS: ' dcsa-3.0 , dcsa-3.0',
      });
      expect(formats.map(f => f.name)).to.deep.equal(['dcsa-3.0']);
    });

    it('stops the start on an unknown name, naming it and the known ones', () => {
      expect(() =>
        formatsFromSettings({LRFE_BL_FORMATS: 'dcsa-3.0,bimco-1'}),
      ).to.throw(
        'LRFE_BL_FORMATS names an unknown B/L format: bimco-1. Known formats: dcsa-3.0',
      );
      expect(() =>
        formatsFromSettings({LRFE_BL_FORMATS: 'dcsa-3.0,'}),
      ).to.throw(
        'LRFE_BL_FORMATS has an empty name in its list. Known formats: dcsa-3.0',
      );
    });

    it("never takes an object's built-in names for formats", () => {
      for (const name of ['toString', 'constructor', '__proto__']) {
        expect(() => formatsFromSettings({LRFE_BL_FORMATS: name})).to.throw(
          `LRFE_BL_FORMATS names an unknown B/L format: ${name}`,
        );
        expect(() => formatNamed([], name)).to.throw(
          `Unknown B/L format: ${name}`,
        );
      }
    });

    it('answers 400 for a DCSA document that is not an object', () => {
      for (const bad of [null, 'text', []]) {
        expect(() => dcsa.toModel(bad)).to.throw(BadRequestError);
      }
    });
  });

  describe('a request naming a format', () => {
    it('gets the converter of a format that is on', () => {
      expect(formatNamed(formatsFromSettings({}), 'dcsa-3.0')).to.equal(dcsa);
    });

    it('is answered 400 for a known format that is not on', () => {
      expect(() => formatNamed([], 'dcsa-3.0'))
        .to.throw(BadRequestError)
        .with.property(
          'message',
          'The B/L format dcsa-3.0 is not on in this install (LRFE_BL_FORMATS: )',
        );
    });

    it('is answered 400 for an unknown format', () => {
      expect(() => formatNamed(formatsFromSettings({}), 'paper'))
        .to.throw(BadRequestError)
        .with.property(
          'message',
          'Unknown B/L format: paper. Formats on: dcsa-3.0',
        );
    });
  });
});
