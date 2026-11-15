import {expect} from 'chai';

import {checkIdentity} from '../src/sections/identity.js';

/**
 * A section with demo organisations, a demo user in one of them, and the default organisation's
 * texts (CB-48).
 * @return {!Object}
 */
function section() {
  return {
    roles: [
      {id: 'agent', label: 'Agent', desc: 'Moves cargo', home: '/', perms: []},
    ],
    defaultOrganisation: {
      name: 'Cargo Platform',
      subtitle: '',
      parent: '',
      place: '',
    },
    demoOrganisations: [
      {code: 'ACME', name: 'Acme Lines'},
      {code: 'BNK', name: 'Example Bank'},
    ],
    demoUsers: [
      {
        name: 'A. Agent',
        email: 'a@acme.example',
        office: 'Acme Lines',
        organisation: 'ACME',
        roles: ['agent'],
        status: 'Active',
      },
      {
        name: 'B. Admin',
        email: 'b@platform.example',
        office: '',
        roles: ['adm'],
        status: 'Active',
      },
    ],
  };
}

describe('the identity section: demo organisations and the default organisation (CB-48)', () => {
  it('takes demo organisations, a demo user in one, and the default organisation', () => {
    expect(() => checkIdentity('demo', section())).not.to.throw();
  });

  it('takes a section without them, as the land pack has', () => {
    const s = section();
    delete s.demoOrganisations;
    delete s.defaultOrganisation;
    delete s.demoUsers[0].organisation;
    expect(() => checkIdentity('demo', s)).not.to.throw();
  });

  for (const [change, error] of [
    [s => (s.demoOrganisations = {}), /"demoOrganisations" is not a list/],
    [s => (s.demoOrganisations[0] = 'ACME'), /demoOrganisations\[0\] is not/],
    [s => delete s.demoOrganisations[0].name, /demoOrganisations\[0\].name/],
    [s => (s.demoOrganisations[0].name = ' '), /demoOrganisations\[0\].name/],
    [
      s => (s.demoOrganisations[1].code = 'bank'),
      /demoOrganisations\[1\].code "bank"/,
    ],
    [
      s => (s.demoOrganisations[1].code = 'TOOLONG'),
      /demoOrganisations\[1\].code "TOOLONG"/,
    ],
    [
      s => (s.demoOrganisations[1].code = 'ACME'),
      /demoOrganisations has "ACME" twice/,
    ],
    [
      s => (s.demoOrganisations[0].kind = 'carrier'),
      /demoOrganisations\[0\] has unknown field\(s\) kind/,
    ],
  ]) {
    it(`refuses wrong demo organisations: ${error}`, () => {
      const s = section();
      change(s);
      expect(() => checkIdentity('demo', s)).to.throw(error);
    });
  }

  for (const [change, error] of [
    [s => (s.demoUsers[0].organisation = ''), /demoUsers\[0\].organisation/],
    [s => (s.demoUsers[0].organisation = 7), /demoUsers\[0\].organisation/],
  ]) {
    it(`refuses a demo user's organisation that is not a text: ${error}`, () => {
      const s = section();
      change(s);
      expect(() => checkIdentity('demo', s)).to.throw(error);
    });
  }

  for (const [change, error] of [
    [s => (s.defaultOrganisation = 'Cargo'), /defaultOrganisation is not/],
    [s => (s.defaultOrganisation.name = ''), /defaultOrganisation.name/],
    [
      s => delete s.defaultOrganisation.subtitle,
      /defaultOrganisation.subtitle/,
    ],
    [s => (s.defaultOrganisation.place = 3), /defaultOrganisation.place/],
    [
      s => (s.defaultOrganisation.motto = 'x'),
      /defaultOrganisation has unknown field\(s\) motto/,
    ],
  ]) {
    it(`refuses a wrong default organisation: ${error}`, () => {
      const s = section();
      change(s);
      expect(() => checkIdentity('demo', s)).to.throw(error);
    });
  }
});
