// Unit tests for the rules of the onboarding screens (CB-43): `npm run test:shipping` (Node's
// test runner, which runs this TypeScript file directly).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  ONBOARDING_PERMS,
  apiKeyProblem,
  copyApiKey,
  cleanInvitation,
  cleanOrganisation,
  freeOfficeCode,
  homeRedirect,
  invitationInvalidField,
  mayOnboard,
  organisationInvalidField,
  invitationProblem,
  newOfficeFor,
  officeOf,
  organisationProblem,
  rolesText,
  selectedApiKeyPerms,
  sortOrganisations,
  staffOf,
  staffRoles,
  statusTagClass,
  type OfficeRef,
  type Organisation,
  type StaffMember,
} from './onboarding.ts';

/**
 * An organisation as identity lists it.
 * @param id its id
 * @param name its name
 * @param status its status
 * @return the organisation
 */
function org(
  id: string,
  name: string,
  status: Organisation['status'] = 'Active',
): Organisation {
  return {
    id,
    code: id.toUpperCase().slice(0, 5),
    name,
    status,
    createdAt: null,
    offices: 0,
    users: 0,
  };
}

/**
 * A user as identity lists it.
 * @param name the user's name
 * @param organisationId their organisation
 * @return the user
 */
function user(name: string, organisationId: string | null): StaffMember {
  return {
    id: `u-${name}`,
    name,
    email: `${name.toLowerCase()}@example.test`,
    roles: ['bld'],
    status: 'Invited',
    organisationId,
  };
}

const ROLES = [
  {id: 'bld', label: 'B/L documentation'},
  {id: 'adm', label: 'System administrator'},
  {id: 'viewer', label: 'Viewer'},
];

describe('cleanOrganisation and organisationProblem: the new organisation form', () => {
  it('trims the name and the code, and writes the code in capitals', () => {
    assert.deepEqual(
      cleanOrganisation({code: ' nml ', name: '  Nordmeer Line GmbH '}),
      {code: 'NML', name: 'Nordmeer Line GmbH'},
    );
  });

  it('a name and a 2 to 5 letter code are fine', () => {
    assert.equal(organisationProblem({code: 'nml', name: 'Nordmeer'}), null);
    assert.equal(organisationProblem({code: 'AB', name: 'A'}), null);
    assert.equal(organisationProblem({code: 'ABCDE', name: 'A'}), null);
  });

  it('refuses an empty or blank name', () => {
    assert.equal(
      organisationProblem({code: 'NML', name: ''}),
      "Enter the organisation's name.",
    );
    assert.equal(
      organisationProblem({code: 'NML', name: '   '}),
      "Enter the organisation's name.",
    );
  });

  it('refuses a code that is not 2 to 5 letters', () => {
    const message = 'The code must be 2 to 5 letters, e.g. ABC.';
    for (const code of ['', 'A', 'ABCDEF', 'AB1', 'A B', 'ÄBC', 'AB-C']) {
      assert.equal(organisationProblem({code, name: 'Name'}), message, code);
    }
  });
});

describe('sortOrganisations', () => {
  it('lists organisations by name, without changing the given list', () => {
    const given = [org('b', 'Volta Bank'), org('a', 'Akwaaba Bank')];
    assert.deepEqual(
      sortOrganisations(given).map(o => o.name),
      ['Akwaaba Bank', 'Volta Bank'],
    );
    assert.equal(given[0].name, 'Volta Bank');
  });
});

describe('staffOf: the staff of one organisation', () => {
  it('only the users of that organisation, by name', () => {
    const users = [
      user('Zoe', 'carrier'),
      user('Ana', 'shipper'),
      user('Ben', 'carrier'),
      user('Nobody', null),
    ];
    assert.deepEqual(
      staffOf(users, 'carrier').map(u => u.name),
      ['Ben', 'Zoe'],
    );
  });

  it('an organisation without users has no staff', () => {
    assert.deepEqual(staffOf([user('Ana', 'shipper')], 'bank'), []);
    assert.deepEqual(staffOf([], 'bank'), []);
  });
});

describe('staffRoles: the roles an organisation’s staff can be given', () => {
  it('every role of the install except the national ones (system administrator)', () => {
    assert.deepEqual(
      staffRoles(ROLES, ['adm']).map(r => r.id),
      ['bld', 'viewer'],
    );
  });

  it('nothing when the install has only national roles', () => {
    assert.deepEqual(staffRoles([ROLES[1]], ['adm']), []);
  });
});

describe('rolesText', () => {
  it('names roles by their labels, in the order given', () => {
    assert.equal(
      rolesText(['viewer', 'bld'], ROLES),
      'Viewer, B/L documentation',
    );
  });

  it('an unknown role by its id; none as a dash', () => {
    assert.equal(rolesText(['xyz'], ROLES), 'xyz');
    assert.equal(rolesText([], ROLES), '—');
  });
});

describe('officeOf and newOfficeFor: the office a new staff member joins', () => {
  const offices: OfficeRef[] = [
    {
      id: 'o1',
      code: 'HQ',
      name: 'Head office',
      status: 'Active',
      organisationId: 'default',
    },
    {
      id: 'o2',
      code: 'NMX',
      name: 'Old',
      status: 'Suspended',
      organisationId: 'carrier',
    },
    {
      id: 'o3',
      code: 'NML',
      name: 'Nordmeer',
      status: 'Active',
      organisationId: 'carrier',
    },
  ];

  it("the organisation's first active office", () => {
    assert.equal(officeOf(offices, 'carrier')?.id, 'o3');
    assert.equal(officeOf(offices, 'default')?.id, 'o1');
  });

  it('none when the organisation has no active office', () => {
    assert.equal(officeOf(offices, 'bank'), null);
    assert.equal(officeOf([offices[1]], 'carrier'), null);
  });

  it('a new office takes the organisation’s code and name', () => {
    assert.deepEqual(newOfficeFor(org('nml', 'Nordmeer Line GmbH')), {
      code: 'NML',
      name: 'Nordmeer Line GmbH',
      type: 'external',
      organisationId: 'nml',
    });
  });
});

describe('cleanInvitation and invitationProblem: the invite form', () => {
  it('trims the name and the email, and writes the email in small letters', () => {
    assert.deepEqual(
      cleanInvitation({
        name: ' Grace Mensah ',
        email: ' Grace.Mensah@Volta.Example ',
        roles: ['bld'],
      }),
      {
        name: 'Grace Mensah',
        email: 'grace.mensah@volta.example',
        roles: ['bld'],
      },
    );
  });

  it('a name, an email and a role are fine', () => {
    assert.equal(
      invitationProblem({
        name: 'Grace',
        email: 'g@volta.example',
        roles: ['bld'],
      }),
      null,
    );
  });

  it('refuses a missing name', () => {
    assert.equal(
      invitationProblem({name: ' ', email: 'g@volta.example', roles: ['bld']}),
      "Enter the person's name.",
    );
  });

  it('refuses a missing or malformed email', () => {
    const message = 'Enter a valid email address.';
    for (const email of [
      '',
      'grace',
      'grace@',
      '@volta.example',
      'g race@volta.example',
      'g@volta',
    ]) {
      assert.equal(
        invitationProblem({name: 'Grace', email, roles: ['bld']}),
        message,
        email,
      );
    }
  });

  it('refuses an invitation without a role', () => {
    assert.equal(
      invitationProblem({name: 'Grace', email: 'g@volta.example', roles: []}),
      'Choose at least one role.',
    );
  });
});

describe('statusTagClass', () => {
  it('active accented, invited informative, suspended neutral', () => {
    assert.equal(statusTagClass('Active'), 'tag-accent');
    assert.equal(statusTagClass('Invited'), 'tag-info');
    assert.equal(statusTagClass('Suspended'), 'tag-neutral');
  });
});

describe('freeOfficeCode and newOfficeFor: an office code nobody has (review)', () => {
  it("the organisation's code when no office has it", () => {
    assert.equal(freeOfficeCode('NML', ['HQ', 'ABC']), 'NML');
  });

  it('else the code with a letter added, A first, then B', () => {
    assert.equal(freeOfficeCode('NML', ['NML']), 'NMLA');
    assert.equal(freeOfficeCode('NML', ['NML', 'NMLA']), 'NMLB');
  });

  it('a five-letter code changes its last letter, still 2 to 5 letters', () => {
    assert.equal(freeOfficeCode('ABCDE', ['ABCDE']), 'ABCDA');
    assert.equal(freeOfficeCode('ABCDA', ['ABCDA']), 'ABCDB');
  });

  it('with every one-letter change taken, two letters change', () => {
    const taken = ['ABCDE'];
    for (let c = 65; c <= 90; c++) {
      taken.push(`ABCD${String.fromCharCode(c)}`);
    }
    const code = freeOfficeCode('ABCDE', taken);
    assert.match(code, /^[A-Z]{2,5}$/);
    assert.equal(taken.includes(code), false);
    assert.equal(code, 'ABCAA');
  });

  it('the same answer for the same codes (deterministic)', () => {
    const taken = ['NML', 'NMLA'];
    assert.equal(freeOfficeCode('NML', taken), freeOfficeCode('NML', taken));
  });

  it('the new office takes a free code when the organisation’s is taken, by any office', () => {
    const offices: OfficeRef[] = [
      {
        id: 'o1',
        code: 'NML',
        name: 'Old',
        status: 'Suspended',
        organisationId: 'nml',
      },
    ];
    assert.deepEqual(newOfficeFor(org('nml', 'Nordmeer Line GmbH'), offices), {
      code: 'NMLA',
      name: 'Nordmeer Line GmbH',
      type: 'external',
      organisationId: 'nml',
    });
  });
});

describe('mayOnboard: who may use the onboarding screens (review)', () => {
  it('needs organisations, users and offices, all three', () => {
    assert.deepEqual(ONBOARDING_PERMS, [
      'admin.organisations',
      'admin.users',
      'admin.offices',
    ]);
    assert.equal(
      mayOnboard(['admin.organisations', 'admin.users', 'admin.offices']),
      true,
    );
  });

  it('refuses when any of them is missing, or with none', () => {
    assert.equal(mayOnboard(['admin.organisations', 'admin.users']), false);
    assert.equal(mayOnboard(['admin.organisations', 'admin.offices']), false);
    assert.equal(mayOnboard(['admin.users', 'admin.offices']), false);
    assert.equal(mayOnboard(['bl.read', 'bl.draft']), false);
    assert.equal(mayOnboard([]), false);
  });
});

describe('homeRedirect: where the home sends a user (review)', () => {
  const ADMIN = ['admin.organisations', 'admin.users', 'admin.offices'];

  it('an administrator without B/Ls goes to the organisations', () => {
    assert.equal(homeRedirect(ADMIN), '/admin/organisations');
  });

  it('a user who reads B/Ls stays on the B/L home, administrator or not', () => {
    assert.equal(homeRedirect(['bl.read', 'bl.draft']), null);
    assert.equal(homeRedirect([...ADMIN, 'bl.read']), null);
  });

  it('a user with neither stays on the home', () => {
    assert.equal(homeRedirect([]), null);
    assert.equal(homeRedirect(['admin.organisations']), null);
  });
});

describe('organisationInvalidField and invitationInvalidField: the field to mark (review)', () => {
  it('the field the problem is in, or none', () => {
    assert.equal(organisationInvalidField({code: 'NML', name: ' '}), 'name');
    assert.equal(organisationInvalidField({code: 'N1', name: 'A'}), 'code');
    assert.equal(organisationInvalidField({code: 'NML', name: 'A'}), null);
  });

  it('the invite form: name, then email, then roles', () => {
    const ok = {name: 'Grace', email: 'g@volta.example', roles: ['bld']};
    assert.equal(invitationInvalidField({...ok, name: ''}), 'name');
    assert.equal(invitationInvalidField({...ok, email: 'grace'}), 'email');
    assert.equal(invitationInvalidField({...ok, roles: []}), 'roles');
    assert.equal(invitationInvalidField(ok), null);
  });
});

describe('carrier API key helpers (CB-56)', () => {
  it('validates the API key name and builds scoped B/L permissions', () => {
    assert.equal(apiKeyProblem('  '), 'Give the API key a name.');
    assert.equal(
      apiKeyProblem('x'.repeat(101)),
      'The API key name is at most 100 characters.',
    );
    assert.equal(apiKeyProblem('Carrier TMS'), null);
    assert.deepEqual(selectedApiKeyPerms(false), ['bl.read', 'bl.draft']);
    assert.deepEqual(selectedApiKeyPerms(true), [
      'bl.read',
      'bl.draft',
      'bl.issue',
    ]);
  });
});

describe('copyApiKey: copy the new API key with one click (CB-121)', () => {
  it('writes the key to the clipboard and confirms without showing the key', async () => {
    const written: string[] = [];
    const clipboard = {
      writeText: async (text: string) => {
        written.push(text);
      },
    };
    const toast = await copyApiKey('lrfe_secret123', clipboard);
    assert.deepEqual(written, ['lrfe_secret123']);
    assert.equal(toast.kind, 'success');
    assert.equal(toast.title, 'API key copied');
    assert.ok(!`${toast.title} ${toast.detail}`.includes('lrfe_secret123'));
  });

  it('asks to copy by hand when the browser blocks the clipboard', async () => {
    const blocked = {
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    };
    const toast = await copyApiKey('lrfe_secret123', blocked);
    assert.equal(toast.kind, 'info');
    assert.equal(toast.title, 'Copy the API key by hand');
    assert.ok(!`${toast.title} ${toast.detail}`.includes('lrfe_secret123'));
  });

  it('asks to copy by hand when there is no clipboard', async () => {
    const toast = await copyApiKey('lrfe_secret123', undefined);
    assert.equal(toast.kind, 'info');
    assert.equal(toast.title, 'Copy the API key by hand');
    assert.ok(!`${toast.title} ${toast.detail}`.includes('lrfe_secret123'));
  });
});
