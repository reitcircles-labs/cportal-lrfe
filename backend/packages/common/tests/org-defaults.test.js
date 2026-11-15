import {expect} from 'chai';

import {
  DEFAULT_ORG,
  loadDomainPack,
  orgDefaultsOf,
  orgFromEnv,
} from '../src/index.js';

describe("the organisation's texts from the domain pack (CB-48)", () => {
  it("are the platform's first-site texts for the land pack, as before", async () => {
    expect(orgDefaultsOf(await loadDomainPack('land'))).to.deep.equal(
      DEFAULT_ORG,
    );
  });

  it("are the shipping pack's own, never the deeds registry's", async () => {
    const defaults = orgDefaultsOf(await loadDomainPack('shipping'));
    expect(defaults.name).to.equal('Shipping Registry');
    expect(defaults.name).not.to.match(/deeds/i);
    expect(defaults).to.deep.equal({
      name: 'Shipping Registry',
      subtitle: '',
      parent: '',
      place: '',
    });
  });

  it('orgFromEnv takes them for the settings that are not set', () => {
    const defaults = {
      name: 'Shipping Registry',
      subtitle: '',
      parent: '',
      place: '',
    };
    expect(orgFromEnv({}, defaults)).to.deep.equal({
      ...defaults,
      fullName: 'Shipping Registry',
    });
    // an empty name falls back to the pack's, not the land registry's
    expect(orgFromEnv({LRFE_ORG_NAME: ' '}, defaults).name).to.equal(
      'Shipping Registry',
    );
    // the site's settings still win
    expect(
      orgFromEnv(
        {LRFE_ORG_NAME: 'Harbour Platform', LRFE_ORG_SUBTITLE: 'Test'},
        defaults,
      ).fullName,
    ).to.equal('Harbour Platform · Test');
  });

  it('orgFromEnv without defaults is unchanged', () => {
    expect(orgFromEnv({}).fullName).to.equal(
      'Deeds Registry · Republic of Namibia',
    );
  });
});
