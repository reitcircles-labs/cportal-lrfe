import {expect} from 'chai';

import {
  DEFAULT_DOMAIN,
  domain,
  loadDomainPack,
  recordServiceOf,
} from '../src/index.js';

describe('the domain pack (CB-3)', () => {
  it('is the land pack when LRFE_DOMAIN is not set', () => {
    expect(DEFAULT_DOMAIN).to.equal('land');
    if (process.env.LRFE_DOMAIN === undefined) {
      expect(domain.name).to.equal('land');
    }
  });

  it('loads the shipping pack, whose record service is shipping-records (CB-28)', async () => {
    const shipping = await loadDomainPack('shipping');
    expect(shipping.name).to.equal('shipping');
    expect(recordServiceOf(shipping)).to.deep.equal({
      name: 'shipping-records',
      label: 'shipping records',
      url: process.env.SHIPPING_RECORDS_URL ?? 'http://localhost:3509',
    });
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
