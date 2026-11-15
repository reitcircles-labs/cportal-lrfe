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

describe('recordKind.anchorProduct: the product named in the anchoring metadata (CB-49)', () => {
  it('takes none, or a pack name', () => {
    expect(() => checkDomainPack(packWith({}))).not.to.throw();
    expect(() =>
      checkDomainPack(packWith({anchorProduct: 'shipping'})),
    ).not.to.throw();
  });

  it('refuses anything that is not a pack name (it goes on chain as it is)', () => {
    for (const anchorProduct of ['Shipping', 'a b', '', 7, {}]) {
      expect(() => checkDomainPack(packWith({anchorProduct}))).to.throw(
        /anchorProduct/,
      );
    }
  });
});
