/**
 * The demo users identity creates when the site sets a demo password (SEED_DEMO_PASSWORD), as
 * shown in the frontend demo (angular-app/projects/platform/src/lib/state/rbac.service.ts).
 * Fictitious. The e2e tests sign in as one active single-role user per role.
 */
export const DEMO_USERS = [
  [
    'Elina Shivute',
    'e.shivute@deeds.gov.na',
    'Deeds Registry · Windhoek',
    ['sup'],
    'Active',
  ],
  [
    'Kristofina Iipinge',
    'k.iipinge@deeds.gov.na',
    'Registry floor 2',
    ['scan'],
    'Active',
  ],
  [
    'Aina Mwandingi',
    'a.mwandingi@deeds.gov.na',
    'Review desk',
    ['rev'],
    'Active',
  ],
  [
    'Johannes !Gawaseb',
    'j.gawaseb@deeds.gov.na',
    'Records desk',
    ['rec'],
    'Active',
  ],
  [
    'Maria Nakale',
    'm.nakale@oag.gov.na',
    'Office of the Auditor-General',
    ['aud'],
    'Active',
  ],
  [
    'Paulus Hamutenya',
    'p.hamutenya@deeds.gov.na',
    'ICT · Deeds Registry',
    ['adm'],
    'Active',
  ],
  [
    'Selma Nangolo',
    's.nangolo@deeds.gov.na',
    'Registry floor 2',
    ['scan'],
    'Active',
  ],
  ['Tangeni Iita', 't.iita@deeds.gov.na', 'Review desk', ['rev'], 'Active'],
  [
    'Willem Beukes',
    'w.beukes@deeds.gov.na',
    'Review desk',
    ['rev', 'aud'],
    'Active',
  ],
  [
    'Hilma Haimbodi',
    'h.haimbodi@deeds.gov.na',
    'Records desk',
    ['rec'],
    'Active',
  ],
  [
    'David Garoeb',
    'd.garoeb@deeds.gov.na',
    'Keetmanshoop sub-registry',
    ['scan', 'rev'],
    'Active',
  ],
  [
    'Frieda Katjiuongua',
    'f.katjiuongua@deeds.gov.na',
    'Records desk',
    ['rec'],
    'Suspended',
  ],
  [
    'Simon Uirab',
    's.uirab@oag.gov.na',
    'Office of the Auditor-General',
    ['aud'],
    'Invited',
  ],
  [
    'Lucia Tjiueza',
    'l.tjiueza@deeds.gov.na',
    'Review desk',
    ['rev'],
    'Invited',
  ],
].map(([name, email, office, roles, status]) => ({
  name,
  email,
  office,
  roles,
  status,
}));
