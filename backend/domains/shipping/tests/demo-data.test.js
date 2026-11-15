import {checkDomainPack} from '@lrfe/domain-pack';
import {expect} from 'chai';

import {pack} from '../src/index.js';

/**
 * The shipping pack's demo data (CB-48): the five organisations of the R1 demo's journey and a
 * demo user per persona, as the storyline (demo/SHIPPING-STORYLINE.md) signs them in.
 */
describe("the shipping pack's demo data (CB-48)", () => {
  const {identity} = pack;

  it('passes the pack check with its demo organisations', () => {
    expect(() =>
      checkDomainPack(structuredClone(pack), 'shipping'),
    ).not.to.throw();
    expect(identity.demoOrganisations.map(o => o.name)).to.have.length(5);
  });

  it('names its default organisation for shipping, never the deeds registry', () => {
    expect(identity.defaultOrganisation.name).to.equal('Shipping Registry');
    expect(JSON.stringify(identity.defaultOrganisation)).not.to.match(
      /deeds|namibia/i,
    );
  });

  it('puts every demo user but the administrator into a demo organisation, its office named after it', () => {
    const byCode = new Map(identity.demoOrganisations.map(o => [o.code, o]));
    for (const user of identity.demoUsers) {
      if (user.roles.includes('adm')) {
        expect(user.organisation, user.email).to.equal(undefined);
        continue;
      }
      const organisation = byCode.get(user.organisation);
      expect(organisation, user.email).not.to.equal(undefined);
      expect(user.office, user.email).to.equal(organisation.name);
    }
  });

  it('gives each organisation of the journey its people: the carrier two (four eyes), the others one', () => {
    const counts = identity.demoOrganisations.map(
      o => identity.demoUsers.filter(u => u.organisation === o.code).length,
    );
    expect(counts).to.deep.equal([2, 1, 1, 1, 1]);
  });
});
