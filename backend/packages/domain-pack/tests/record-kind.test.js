import {expect} from 'chai';

import {checkDomainPack} from '../src/index.js';

/**
 * A pack with every section empty and the given record kind.
 * @param {?object} recordKind
 * @return {object}
 */
function packWith(recordKind) {
  return {
    name: 'demo',
    documents: {},
    identity: {},
    workflows: {},
    recordKind,
    wording: {edrms: {}, identity: {}, audit: {}, extracts: {}},
  };
}

describe('the recordKind section (CB-3)', () => {
  it('takes no record kind, an empty one and a full one', () => {
    expect(() => checkDomainPack(packWith(null))).not.to.throw();
    expect(() => checkDomainPack(packWith({}))).not.to.throw();
    const pack = checkDomainPack(
      packWith({
        source: 'things',
        committedEvent: 'things.thing.committed',
        businessKeyProcesses: ['thing-review'],
        linkedSubjects: [{kind: 'document', path: ['change', 'documentId']}],
        commitPermission: 'thing.commit',
        lookup: {recordNumber: /^TH-/i, instrumentNumber: /^\d+$/},
      }),
    );
    // frozen, and its patterns still work
    expect(Object.isFrozen(pack.recordKind.lookup.recordNumber)).to.equal(true);
    expect(pack.recordKind.lookup.recordNumber.test('th-1')).to.equal(true);
  });

  it('refuses a record kind that is not an object', () => {
    expect(() => checkDomainPack(packWith([]))).to.throw(
      /"recordKind" is not an object/,
    );
  });

  it('refuses names that are not texts', () => {
    for (const key of ['source', 'committedEvent', 'commitPermission']) {
      expect(() => checkDomainPack(packWith({[key]: 3})), key).to.throw(
        `recordKind.${key} is not a text`,
      );
    }
    expect(() =>
      checkDomainPack(packWith({businessKeyProcesses: 'x-review'})),
    ).to.throw(/businessKeyProcesses is not a list of texts/);
  });

  it('refuses linked subjects of an unknown kind or without a path', () => {
    expect(() => checkDomainPack(packWith({linkedSubjects: {}}))).to.throw(
      /linkedSubjects is not a list/,
    );
    expect(() =>
      checkDomainPack(
        packWith({linkedSubjects: [{kind: 'record', path: ['a']}]}),
      ),
    ).to.throw(/linkedSubjects\[0\].kind "record" is not one of/);
    expect(() =>
      checkDomainPack(packWith({linkedSubjects: [{kind: 'user', path: []}]})),
    ).to.throw(/linkedSubjects\[0\].path is not a list of keys/);
  });

  it('refuses lookup patterns that are not plain regular expressions', () => {
    expect(() =>
      checkDomainPack(packWith({lookup: {recordNumber: '^LR-'}})),
    ).to.throw(/lookup.recordNumber is not a regular expression/);
    expect(() =>
      checkDomainPack(packWith({lookup: {instrumentNumber: /x/g}})),
    ).to.throw(/lookup.instrumentNumber must be neither global nor sticky/);
  });
});
