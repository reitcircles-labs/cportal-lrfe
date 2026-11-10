import {expect} from 'chai';

import {DEFAULT_DOMAIN, domain, loadDomainPack} from '../src/index.js';

describe('the domain pack (CB-3)', () => {
  it('is the land pack when LRFE_DOMAIN is not set', () => {
    expect(DEFAULT_DOMAIN).to.equal('land');
    if (process.env.LRFE_DOMAIN === undefined) {
      expect(domain.name).to.equal('land');
    }
  });

  it('loads the empty shipping pack', async () => {
    const shipping = await loadDomainPack('shipping');
    expect(shipping.name).to.equal('shipping');
    expect(shipping.recordKind).to.equal(null);
  });

  it('fails early on a pack that does not exist or a name that is not one', async () => {
    for (const [name, error] of [
      ['harbour', /No domain pack "harbour"/],
      ['../land', /must be a pack name/],
    ]) {
      let thrown;
      try {
        await loadDomainPack(name);
      } catch (err) {
        thrown = err;
      }
      expect(thrown?.message, name).to.match(error);
    }
  });
});
