import {expect} from 'chai';

import {checkIdentity} from '../src/sections/identity.js';

/** A small valid identity section, one entry of each kind. */
function section() {
  return {
    permissionGroups: ['Cargo'],
    permissions: [
      {id: 'cargo.view', group: 'Cargo', label: 'View cargo', desc: 'Lists'},
      {
        id: 'cargo.release',
        group: 'Cargo',
        label: 'Release cargo',
        desc: 'Release',
        since: 5,
      },
    ],
    roles: [
      {
        id: 'agent',
        label: 'Agent',
        desc: 'Handles cargo',
        home: '/',
        perms: ['cargo.view'],
      },
    ],
    separationOfDuties: [
      {
        id: 'sod9',
        a: 'cargo.release',
        b: 'audit.signoff',
        label: 'No',
        on: true,
      },
    ],
    offices: [
      {code: 'WVB', name: 'Port', type: 'registry', address: '', contact: ''},
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
        email: 'a@example.test',
        office: 'Port',
        organisation: 'ACME',
        roles: ['agent'],
        status: 'Active',
      },
    ],
  };
}

describe('the identity section check (CB-3)', () => {
  it('takes an empty section and a complete one', () => {
    expect(() => checkIdentity('demo', {})).not.to.throw();
    expect(() => checkIdentity('demo', section())).not.to.throw();
  });

  it('refuses a section that is not an object, or has an unknown field', () => {
    expect(() => checkIdentity('demo', [])).to.throw(/demo: "identity" is not/);
    expect(() => checkIdentity('demo', {role: []})).to.throw(
      /unknown field\(s\) role/,
    );
  });

  it('refuses a field that is not a list', () => {
    expect(() => checkIdentity('demo', {roles: {}})).to.throw(
      /"roles" is not a list/,
    );
  });

  it('names the entry that is wrong', () => {
    const cases = [
      [
        s => (s.permissions[0].id = 'Cargo View'),
        /permissions\[0\].id "Cargo View"/,
      ],
      [s => (s.permissions[1].since = 0), /permissions\[1\].since/],
      [
        s => delete s.permissions[0].desc,
        /permissions\[0\].desc is not a text/,
      ],
      [s => (s.permissions[0].colour = 'red'), /unknown field\(s\) colour/],
      [s => (s.roles[0].home = 'cargo'), /roles\[0\].home/],
      [
        s => (s.roles[0].perms = 'cargo.view'),
        /roles\[0\].perms is not a list/,
      ],
      [s => (s.separationOfDuties[0].on = 'yes'), /separationOfDuties\[0\].on/],
      [s => (s.offices[0].code = 'wvb'), /offices\[0\].code "wvb"/],
      [s => delete s.offices[0].contact, /offices\[0\].contact is not a text/],
      [s => (s.demoUsers[0].email = 'agent'), /demoUsers\[0\].email/],
      [s => (s.demoUsers[0].roles = []), /demoUsers\[0\] has no role/],
      [s => (s.demoUsers[0].status = 'Gone'), /demoUsers\[0\].status/],
      [s => (s.demoUsers[0].organisation = ''), /demoUsers\[0\].organisation/],
      [s => (s.demoUsers[0].organisation = 7), /demoUsers\[0\].organisation/],
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
    ];
    for (const [spoil, error] of cases) {
      const spoilt = section();
      spoil(spoilt);
      expect(() => checkIdentity('demo', spoilt), String(error)).to.throw(
        error,
      );
    }
  });

  it('refuses an id given twice', () => {
    const s = section();
    s.roles.push({...s.roles[0]});
    expect(() => checkIdentity('demo', s)).to.throw(/roles has "agent" twice/);
  });
});
