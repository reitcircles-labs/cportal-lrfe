import {expect} from 'chai';

import {checkDomainPack} from '../src/index.js';

/** A pack whose `documents` section is `documents`, every other section empty. */
function packWith(documents) {
  return {
    name: 'demo',
    documents,
    identity: {},
    workflows: {},
    recordKind: null,
    wording: {edrms: {}, identity: {}, audit: {}, extracts: {}},
  };
}

/** A small, valid `documents` section: one type with a reference and a text field. */
function validDocuments() {
  return {
    types: [
      {
        id: 'bill_of_lading',
        label: 'Bill of lading',
        refField: 'blNo',
        desc: 'A bill of lading',
        fields: [
          {
            k: 'blNo',
            label: 'B/L number',
            type: 'ref',
            required: true,
            search: 'reference',
          },
          {
            k: 'shipper',
            label: 'Shipper',
            type: 'text',
            required: false,
            search: 'name',
          },
        ],
      },
    ],
    fieldTypes: {ref: raw => ({value: raw, normalized: raw, checks: []})},
    formatReference: ref => ref,
    reading: {
      promptVersion: 'bl-1',
      prompt: {
        subject: 'bills of lading',
        notOfKind: 'a bill of lading',
        rules: ['One rule.'],
      },
      checkRows() {},
      crossChecks: {codes: ['x'], async check() {}},
      wrongPartyExample: 'e.g. the carrier instead of the shipper',
    },
    partyFields: ['shipper'],
    demo: {answer: {}, reading: () => ({})},
  };
}

/** Expects the section to fail the check with `message`. */
function refuses(documents, message) {
  expect(() => checkDomainPack(packWith(documents))).to.throw(message);
}

describe('the documents section (CB-3)', () => {
  it('takes an empty section and a complete one', () => {
    expect(() => checkDomainPack(packWith({}))).not.to.throw();
    expect(() => checkDomainPack(packWith(validDocuments()))).not.to.throw();
  });

  it('refuses types that are not a list, or a type without a valid id or label', () => {
    refuses({types: {}}, 'documents: "types" is not a list');
    const noId = validDocuments();
    noId.types[0].id = 'Bill of lading';
    refuses(noId, 'a type has no valid id ("Bill of lading")');
    const noLabel = validDocuments();
    noLabel.types[0].label = ' ';
    refuses(noLabel, 'type "bill_of_lading" has no label');
    const twice = validDocuments();
    twice.types.push(twice.types[0]);
    refuses(twice, 'the type "bill_of_lading" is given twice');
  });

  it('refuses a reference field that is not one of the fields', () => {
    const docs = validDocuments();
    docs.types[0].refField = 'number';
    refuses(docs, '"refField" is neither null nor one of its fields');
  });

  it('refuses a field with an unknown type, search role or no required flag', () => {
    const type = validDocuments();
    type.types[0].fields[1].type = 'port';
    refuses(type, 'the type "port" is neither "text" nor in "fieldTypes"');
    const role = validDocuments();
    role.types[0].fields[1].search = 'party';
    refuses(role, '"search" is not one of reference, number, name, place');
    const required = validDocuments();
    delete required.types[0].fields[0].required;
    refuses(required, 'field "blNo": "required" is not true or false');
    const twice = validDocuments();
    twice.types[0].fields.push(twice.types[0].fields[0]);
    refuses(twice, 'the field "blNo" is given twice');
  });

  it('needs the reading texts with document types', () => {
    const none = validDocuments();
    delete none.reading;
    refuses(none, '"reading" is needed with document types');
    const version = validDocuments();
    delete version.reading.promptVersion;
    refuses(version, '"reading.promptVersion" is not a text');
    const prompt = validDocuments();
    delete prompt.reading.prompt.notOfKind;
    refuses(
      prompt,
      '"reading.prompt" needs the texts "subject" and "notOfKind"',
    );
    const checks = validDocuments();
    checks.reading.crossChecks = {codes: 'x', check() {}};
    refuses(checks, '"reading.crossChecks" needs "codes"');
  });

  it('refuses hooks that are not functions', () => {
    const format = validDocuments();
    format.formatReference = 'T 1/2008';
    refuses(format, '"formatReference" is not a function');
    const fieldType = validDocuments();
    fieldType.fieldTypes.ref = /x/;
    refuses(fieldType, 'field type "ref" is not a function');
    const rows = validDocuments();
    rows.reading.checkRows = [];
    refuses(rows, '"reading.checkRows" is not a function');
    const demo = validDocuments();
    demo.demo = {answer: {}};
    refuses(demo, '"demo" needs a function "reading"');
    const party = validDocuments();
    party.partyFields = 'shipper';
    refuses(party, '"partyFields" is not a list of field keys');
  });
});
