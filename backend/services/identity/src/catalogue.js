import {domain} from '@lrfe/common';

/**
 * Fixed catalogue: permissions, system roles, segregation-of-duties rules and default security
 * policies. The platform's own entries are here; the product's (its permission groups, roles,
 * rules, default offices and demo users) come from the domain pack's `identity` section (CB-3),
 * and the pack's `wording.identity` may give the platform entries its own descriptions. Mirrors
 * the web app's permission catalogue (angular-app/projects/land-registry/src/app/state/perm-catalogue.ts).
 * Roles cannot be created or deleted; only their permission sets (the admin "Roles & permissions"
 * matrix) are editable. Role and permission ids are stored in databases and tokens: they never
 * change.
 */

/** The platform's permission groups that come before the product's. */
const GROUPS_BEFORE = ['General', 'Capture', 'Verification'];
/** The platform's permission groups that come after the product's. */
const GROUPS_AFTER = ['Audit', 'Administration'];

/** The platform's permissions, by group. */
const PLATFORM_PERMS = [
  {
    id: 'dashboard.view',
    group: 'General',
    label: 'View dashboard',
    desc: 'KPIs, register, recent activity',
  },
  {
    id: 'capture.view',
    group: 'Capture',
    label: 'View capture station',
    desc: 'Batches, incoming pages, scanner status',
  },
  {
    id: 'capture.scan',
    group: 'Capture',
    label: 'Run scans & imports',
    desc: 'Start the scanner or ingest the hot folder',
  },
  {
    id: 'capture.rescan',
    group: 'Capture',
    label: 'Flag pages for rescan',
    desc: 'Mark poor captures for the operator',
  },
  {
    id: 'verify.view',
    group: 'Verification',
    label: 'View review queue',
    desc: 'Open documents and extracted metadata',
  },
  {
    id: 'verify.edit',
    group: 'Verification',
    label: 'Accept & correct metadata',
    desc: 'Change extracted field values',
  },
  {
    id: 'verify.file',
    group: 'Verification',
    label: 'File documents to EDRMS',
    desc: 'Approve a document as a record',
  },
  {
    id: 'audit.view',
    group: 'Audit',
    label: 'View audit trail & evidence',
    desc: 'Provenance, hashes, full trail',
  },
  {
    id: 'audit.signoff',
    group: 'Audit',
    label: 'Sign off & raise findings',
    desc: 'Record the auditor’s conclusion',
  },
  {
    id: 'audit.export',
    group: 'Audit',
    label: 'Export evidence packs',
    desc: 'Download images, metadata and trail',
  },
  {
    id: 'anchors.view',
    group: 'Audit',
    label: 'View anchorings',
    desc: 'Batches put on the blockchain, their status and explorer links',
    since: 3,
  },
  {
    id: 'admin.users',
    group: 'Administration',
    label: 'Manage users',
    desc: 'Invite, assign roles, suspend',
  },
  {
    id: 'admin.roles',
    group: 'Administration',
    label: 'Manage roles & permissions',
    desc: 'Edit the permission matrix',
  },
  {
    id: 'admin.policies',
    group: 'Administration',
    label: 'Manage security policies',
    desc: 'MFA, sessions, segregation of duties',
  },
  {
    id: 'admin.offices',
    group: 'Administration',
    label: 'Manage offices',
    desc: 'Add, rename and suspend office locations',
    since: 2,
  },
  {
    id: 'admin.organisations',
    group: 'Administration',
    label: 'Manage organisations',
    desc: 'Add, rename and suspend the organisations users and offices belong to',
    since: 5,
  },
];

/**
 * The platform's roles, after the product's: the system administrator (national: no office).
 * @type {!Array<{id: string, label: string, desc: string, home: string, perms: !Array<string>}>}
 */
const PLATFORM_ROLES = [
  {
    id: 'adm',
    label: 'System administrator',
    desc: "Manages users, roles and security policies. No rights over the product's records.",
    home: '/admin/users',
    perms: [
      'dashboard.view',
      'audit.view',
      'anchors.view',
      'admin.users',
      'admin.roles',
      'admin.policies',
      'admin.offices',
      'admin.organisations',
    ],
  },
];

/** The platform's separation-of-duty rules, between its own permissions. */
const PLATFORM_SOD_RULES = [
  {
    id: 'sod1',
    a: 'verify.file',
    b: 'audit.signoff',
    label: 'Reviewers cannot audit documents they can file',
    on: true,
  },
  {
    id: 'sod4',
    a: 'capture.scan',
    b: 'verify.file',
    label: 'Scan operators cannot file what they capture',
    on: false,
  },
];

/**
 * Catalogue version. A permission with `since: n` (the platform's or the pack's) was added in
 * version n: when an existing database is on an older version, the seed grants it to the roles that
 * hold it by default, once, and never touches it again (an administrator may have removed it
 * since). The version is the highest of this one and every `since` of the pack.
 */
const PLATFORM_CATALOGUE_VERSION = 5;

export const ACCESS_KINDS = [
  'role',
  'user',
  'policy',
  'denied',
  'session',
  'office',
  'organisation',
];

/** Offices: locations users belong to. A code is fixed once created (it will appear in numbers). */
export const OFFICE_TYPES = ['registry', 'external'];
export const OFFICE_CODE_PATTERN = '^[A-Z]{2,5}$';
/**
 * Organisations: who users and offices belong to (CB-19). An install starts with one, the default
 * organisation; a product with outside parties (carriers, banks) adds more. Codes follow the
 * office pattern and are fixed once created.
 */
export const ORGANISATION_CODE_PATTERN = OFFICE_CODE_PATTERN;

/**
 * A code for the default organisation, from its name: the initials of its words (at most five),
 * e.g. "Deeds Registry" → "DR"; "ORG" when the name gives fewer than two letters.
 * @param {string} name
 * @return {string}
 */
export function organisationCodeOf(name) {
  const initials = String(name || '')
    .normalize('NFD')
    .replace(/[^A-Za-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase())
    .join('')
    .slice(0, 5);
  return initials.length >= 2 ? initials : 'ORG';
}

/** Roles whose holders may have no office ("national"); everyone else is invited into one. */
export const NATIONAL_ROLES = ['adm'];

/**
 * The whole catalogue of an install: the platform's entries and its domain pack's, in the order
 * the administration screens list them. Throws, naming the pack, when the pack's entries clash
 * with the platform's or name a permission or role that does not exist.
 * @param {import('@lrfe/domain-pack').DomainPack} pack
 * @return {{
 *   groups: !Array<string>,
 *   perms: !Array<{id: string, group: string, label: string, desc: string, since: (number|undefined)}>,
 *   permIds: !Array<string>,
 *   roles: !Array<{id: string, label: string, desc: string, home: string, system: boolean, perms: !Array<string>}>,
 *   roleIds: !Array<string>,
 *   sodRules: !Array<{id: string, a: string, b: string, label: string, on: boolean}>,
 *   version: number,
 *   offices: !Array<{code: string, name: string, type: string, address: string, contact: string}>,
 *   demoUsers: !Array<{name: string, email: string, office: string, roles: !Array<string>, status: string}>,
 * }}
 */
export function catalogueOf(pack) {
  const section = pack.identity;
  const wording = pack.wording.identity;
  const problem = what =>
    new Error(`Domain pack ${pack.name}: identity: ${what}`);

  const packGroups = section.permissionGroups ?? [];
  const groups = [...GROUPS_BEFORE, ...packGroups, ...GROUPS_AFTER];
  const clashingGroup = packGroups.find(
    g => GROUPS_BEFORE.includes(g) || GROUPS_AFTER.includes(g),
  );
  if (clashingGroup) {
    throw problem(`the group "${clashingGroup}" is the platform's`);
  }
  const packPerms = section.permissions ?? [];
  for (const perm of packPerms) {
    if (PLATFORM_PERMS.some(p => p.id === perm.id)) {
      throw problem(`the permission ${perm.id} is the platform's`);
    }
    if (!groups.includes(perm.group)) {
      throw problem(
        `the permission ${perm.id} is in the unknown group "${perm.group}"`,
      );
    }
  }
  const described = perm => {
    const desc = wording.permissionDescriptions?.[perm.id] ?? perm.desc;
    return {...perm, desc};
  };
  const perms = groups.flatMap(group =>
    [...PLATFORM_PERMS, ...packPerms]
      .filter(p => p.group === group)
      .map(described),
  );
  const permIds = perms.map(p => p.id);

  const packRoles = section.roles ?? [];
  const clashingRole = packRoles.find(r =>
    PLATFORM_ROLES.some(p => p.id === r.id),
  );
  if (clashingRole) {
    throw problem(`the role ${clashingRole.id} is the platform's`);
  }
  const roles = [...packRoles, ...PLATFORM_ROLES].map(r => ({
    id: r.id,
    label: r.label,
    desc: wording.roleDescriptions?.[r.id] ?? r.desc,
    home: r.home,
    system: true,
    perms: [...r.perms],
  }));
  for (const role of roles) {
    const unknown = role.perms.filter(p => !permIds.includes(p));
    if (unknown.length) {
      throw problem(
        `the role ${role.id} holds unknown permission(s) ${unknown.join(', ')}`,
      );
    }
  }
  const roleIds = roles.map(r => r.id);

  // in id order, as the database lists them
  const sodRules = [
    ...PLATFORM_SOD_RULES,
    ...(section.separationOfDuties ?? []),
  ]
    .map(r => ({...r}))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const [i, rule] of sodRules.entries()) {
    if (i > 0 && sodRules[i - 1].id === rule.id) {
      throw problem(`the rule ${rule.id} is the platform's`);
    }
    if (!permIds.includes(rule.a) || !permIds.includes(rule.b)) {
      throw problem(`the rule ${rule.id} names an unknown permission`);
    }
  }

  const offices = (section.offices ?? []).map(o => ({...o}));
  const badOffice = offices.find(o => !OFFICE_TYPES.includes(o.type));
  if (badOffice) {
    throw problem(
      `the office ${badOffice.code} has a type other than ${OFFICE_TYPES.join(', ')}`,
    );
  }
  const demoUsers = (section.demoUsers ?? []).map(u => ({
    ...u,
    roles: [...u.roles],
  }));
  const badUser = demoUsers.find(u => u.roles.some(r => !roleIds.includes(r)));
  if (badUser) {
    throw problem(`the demo user ${badUser.email} has an unknown role`);
  }

  const version = Math.max(
    PLATFORM_CATALOGUE_VERSION,
    ...perms.map(p => p.since ?? 1),
  );
  return {
    groups,
    perms,
    permIds,
    roles,
    roleIds,
    sodRules,
    version,
    offices,
    demoUsers,
  };
}

/** The catalogue of this install, from its domain pack. */
export const CATALOGUE = catalogueOf(domain);

export const PERM_GROUPS = CATALOGUE.groups;
export const PERMS = CATALOGUE.perms;
export const CATALOGUE_VERSION = CATALOGUE.version;
export const PERM_IDS = CATALOGUE.permIds;
/** Whether `id` is a permission in the catalogue. */
export const isKnownPerm = id => PERM_IDS.includes(id);
/** The label of a permission, or its id when it is not in the catalogue. */
export const permLabel = id => PERMS.find(p => p.id === id)?.label || id;
/**
 * Order a permission list by catalogue order and drop unknown/duplicate ids.
 * @param {!Array<string>} perms
 * @param {!Array<string>=} permIds the catalogue's permission ids, this install's by default
 * @return {!Array<string>}
 */
export const normalizePerms = (perms, permIds = PERM_IDS) =>
  permIds.filter(p => perms.includes(p));

export const ROLES = CATALOGUE.roles;
export const ROLE_IDS = CATALOGUE.roleIds;
export const SOD_RULES = CATALOGUE.sodRules;

/** The offices created when a database has none and the site sets none: the domain pack's. */
export const DEFAULT_OFFICES = CATALOGUE.offices;

/**
 * The offices to create on an empty database, from the site's setting (API-712), e.g.
 * `HQ=Head office;NTH=North office`: code=name pairs separated by
 * semicolons, each a registry office. Empty: none (the administrator adds them). Addresses and
 * contacts are added in Administration. Throws on a malformed entry, naming the setting.
 * @param {string} text
 * @param {string} setting the setting's name, for the error message
 * @return {!Array<{code: string, name: string, type: string, address: string, contact: string}>}
 */
export function parseOffices(text, setting) {
  const offices = [];
  for (const entry of text
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf('=');
    const code = entry.slice(0, separator).trim();
    const name = entry.slice(separator + 1).trim();
    if (separator < 0 || !new RegExp(OFFICE_CODE_PATTERN).test(code) || !name) {
      throw new Error(
        `${setting}: "${entry}" is not CODE=Name (a code of 2 to 5 capital letters, then the office's name)`,
      );
    }
    if (offices.some(o => o.code === code)) {
      throw new Error(`${setting}: the code ${code} appears twice`);
    }
    offices.push({code, name, type: 'registry', address: '', contact: ''});
  }
  return offices;
}

export const DEFAULT_POLICIES = {
  mfa: true,
  eid: true,
  ipAllow: false,
  timeout: 30,
  fourEyes: true,
};

/**
 * Union of the permissions granted by `roleIds`, given the current role definitions, in catalogue
 * order.
 * @param {!Array<string>} roleIds
 * @param {!Array<{id: string, perms: !Array<string>}>} roles
 * @param {!Array<string>=} permIds the catalogue's permission ids, this install's by default
 * @return {!Array<string>}
 */
export function effectivePerms(roleIds, roles, permIds = PERM_IDS) {
  const granted = new Set();
  for (const id of roleIds) {
    roles.find(r => r.id === id)?.perms.forEach(p => granted.add(p));
  }
  return permIds.filter(p => granted.has(p));
}

/** Enabled SoD rules violated by holding all of `perms`. */
export function sodConflicts(perms, rules) {
  return rules.filter(r => r.on && perms.includes(r.a) && perms.includes(r.b));
}
