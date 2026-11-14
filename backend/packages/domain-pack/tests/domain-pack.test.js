import {expect} from 'chai';

import {checkDomainPack, isPackName} from '../src/index.js';

/** A pack with every section and nothing in it, as the shipping pack was at first. */
function emptyPack(name = 'demo') {
  return {
    name,
    documents: {},
    identity: {},
    workflows: {},
    recordKind: null,
    wording: {edrms: {}, identity: {}, audit: {}, extracts: {}},
  };
}

describe('checkDomainPack (CB-3)', () => {
  it('takes an empty pack and freezes it', () => {
    const pack = checkDomainPack(emptyPack(), 'demo');
    expect(pack.name).to.equal('demo');
    expect(Object.isFrozen(pack)).to.equal(true);
    expect(Object.isFrozen(pack.wording.audit)).to.equal(true);
  });

  it('refuses a module without a pack, or a pack loaded under another name', () => {
    expect(() => checkDomainPack(undefined, 'land')).to.throw(/land.*no pack/);
    expect(() => checkDomainPack(emptyPack('ship'), 'land')).to.throw(
      /the module is the pack "ship"/,
    );
  });

  it('refuses a pack that misses a section', () => {
    for (const section of ['documents', 'identity', 'workflows', 'wording']) {
      const pack = emptyPack();
      delete pack[section];
      expect(() => checkDomainPack(pack), section).to.throw(`"${section}"`);
    }
    const pack = emptyPack();
    delete pack.wording.extracts;
    expect(() => checkDomainPack(pack)).to.throw(/wording: "extracts"/);
  });

  it('takes texts and functions as wording, nothing else', () => {
    const pack = emptyPack();
    pack.wording.extracts = {
      title: 'Extract',
      line: n => `No. ${n}`,
      more: {a: 'b'},
    };
    expect(() => checkDomainPack(pack)).not.to.throw();
    const bad = emptyPack();
    bad.wording.audit = {count: 3};
    expect(() => checkDomainPack(bad)).to.throw(
      /wording.audit.count is not a text/,
    );
  });

  it('knows a pack name', () => {
    expect(isPackName('land')).to.equal(true);
    expect(isPackName('shipping')).to.equal(true);
    for (const name of ['', 'Land', '../land', 'land/x', '1land']) {
      expect(isPackName(name), name).to.equal(false);
    }
  });
});
