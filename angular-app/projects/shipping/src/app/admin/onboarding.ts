/**
 * The rules of the onboarding screens (CB-43): what the forms accept, whose staff an organisation
 * has, which roles they may be given, and which office a new staff member joins. Identity checks
 * everything again; these only decide what the screens offer and say.
 */

/** An organisation as identity lists it (GET /organisations). */
export interface Organisation {
  id: string;
  code: string;
  name: string;
  status: 'Active' | 'Suspended';
  createdAt: string | null;
  /** how many offices it has */
  offices: number;
  /** how many of its users are not suspended */
  users: number;
}

/** A user as identity lists it (GET /users), as far as the staff list reads it. */
export interface StaffMember {
  id: string;
  name: string;
  email: string;
  roles: string[];
  status: 'Active' | 'Suspended' | 'Invited';
  organisationId: string | null;
}

/** An office as identity lists it (GET /offices), as far as an invitation reads it. */
export interface OfficeRef {
  id: string;
  code: string;
  name: string;
  status: 'Active' | 'Suspended';
  organisationId: string | null;
}

/** A role, by its id and label. */
export interface RoleRef {
  id: string;
  label: string;
}

/** The new organisation form. */
export interface OrganisationForm {
  code: string;
  name: string;
}

/** The invite form. */
export interface InvitationForm {
  name: string;
  email: string;
  roles: string[];
}

/** The office identity is asked to create for an organisation that has none (POST /offices). */
export interface NewOffice {
  code: string;
  name: string;
  type: 'external';
  organisationId: string;
}

/** An organisation's code: 2 to 5 capital letters (identity's ORGANISATION_CODE_PATTERN). */
const CODE_PATTERN = /^[A-Z]{2,5}$/;

/** An email address, roughly: something, an at sign, a domain with a dot, no spaces. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The new organisation form as it is sent: trimmed, the code in capitals.
 * @param form what was typed
 * @return the organisation to create
 */
export function cleanOrganisation(form: OrganisationForm): OrganisationForm {
  return {code: form.code.trim().toUpperCase(), name: form.name.trim()};
}

/**
 * What is wrong with the new organisation form, if anything.
 * @param form what was typed
 * @return the message to show, or null when it can be sent
 */
export function organisationProblem(form: OrganisationForm): string | null {
  const clean = cleanOrganisation(form);
  if (!clean.name) {
    return "Enter the organisation's name.";
  }
  if (!CODE_PATTERN.test(clean.code)) {
    return 'The code must be 2 to 5 letters, e.g. ABC.';
  }
  return null;
}

/**
 * Organisations by name.
 * @param organisations as identity lists them
 * @return a new list, sorted
 */
export function sortOrganisations(
  organisations: readonly Organisation[],
): Organisation[] {
  return [...organisations].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The staff of one organisation, by name.
 * @param users every user of the install
 * @param organisationId the organisation
 * @return its users
 */
export function staffOf(
  users: readonly StaffMember[],
  organisationId: string,
): StaffMember[] {
  return users
    .filter(u => u.organisationId === organisationId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The roles an organisation's staff can be given: the install's roles except the national ones
 * (the platform's system administrator).
 * @param roles every role of the install
 * @param nationalRoles the ids of the national roles
 * @return the roles to offer
 */
export function staffRoles<T extends RoleRef>(
  roles: readonly T[],
  nationalRoles: readonly string[],
): T[] {
  return roles.filter(r => !nationalRoles.includes(r.id));
}

/**
 * Roles by their labels.
 * @param roleIds the role ids
 * @param roles every role of the install
 * @return the labels, comma separated; a dash for none
 */
export function rolesText(
  roleIds: readonly string[],
  roles: readonly RoleRef[],
): string {
  if (roleIds.length === 0) {
    return '—';
  }
  const labels = roleIds.map(id => {
    const role = roles.find(r => r.id === id);
    return role ? role.label : id;
  });
  return labels.join(', ');
}

/**
 * The office a new staff member of an organisation joins: its first active one.
 * @param offices every office of the install
 * @param organisationId the organisation
 * @return the office, or null when it has no active one
 */
export function officeOf(
  offices: readonly OfficeRef[],
  organisationId: string,
): OfficeRef | null {
  const office = offices.find(
    o => o.organisationId === organisationId && o.status === 'Active',
  );
  return office ?? null;
}

/** The letters a code may end in, in the order they are tried. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * An office code no office has yet, from an organisation's code (review of CB-43): the code itself,
 * else the code with one letter added (A first); a five-letter code changes its last letter, then
 * its last two. Always 2 to 5 capital letters, and the same answer for the same codes.
 * @param code the organisation's code
 * @param takenCodes the codes of every office of the install
 * @return the code
 */
export function freeOfficeCode(
  code: string,
  takenCodes: readonly string[],
): string {
  const taken = new Set(takenCodes);
  if (!taken.has(code)) {
    return code;
  }
  const length = Math.min(code.length + 1, 5);
  for (let kept = Math.min(code.length, 4); kept >= 2; kept--) {
    const free = firstFree(code.slice(0, kept), length - kept, taken);
    if (free) {
      return free;
    }
  }
  throw new Error(`No free office code is left for ${code}`);
}

/**
 * The first code, in alphabetical order, made of a stem and a number of letters, that is not
 * taken.
 * @param stem the letters kept
 * @param count how many letters are added
 * @param taken the codes taken
 * @return the code, or null when every one is taken
 */
function firstFree(
  stem: string,
  count: number,
  taken: ReadonlySet<string>,
): string | null {
  let codes = [stem];
  for (let added = 0; added < count; added++) {
    const longer: string[] = [];
    for (const start of codes) {
      for (const letter of LETTERS) {
        longer.push(start + letter);
      }
    }
    codes = longer;
  }
  return codes.find(c => !taken.has(c)) ?? null;
}

/**
 * The office made for an organisation that has no active one, so that its staff can be invited:
 * its name, and its code when no office has it (else a free one, freeOfficeCode).
 * @param organisation the organisation
 * @param offices every office of the install
 * @return the office to create
 */
export function newOfficeFor(
  organisation: Organisation,
  offices: readonly OfficeRef[] = [],
): NewOffice {
  return {
    code: freeOfficeCode(
      organisation.code,
      offices.map(o => o.code),
    ),
    name: organisation.name,
    type: 'external',
    organisationId: organisation.id,
  };
}

/**
 * The invite form as it is sent: trimmed, the email in small letters.
 * @param form what was typed and chosen
 * @return the invitation
 */
export function cleanInvitation(form: InvitationForm): InvitationForm {
  return {
    name: form.name.trim(),
    email: form.email.trim().toLowerCase(),
    roles: [...form.roles],
  };
}

/**
 * What is wrong with the invite form, if anything.
 * @param form what was typed and chosen
 * @return the message to show, or null when it can be sent
 */
export function invitationProblem(form: InvitationForm): string | null {
  const clean = cleanInvitation(form);
  if (!clean.name) {
    return "Enter the person's name.";
  }
  if (!EMAIL_PATTERN.test(clean.email)) {
    return 'Enter a valid email address.';
  }
  if (clean.roles.length === 0) {
    return 'Choose at least one role.';
  }
  return null;
}

/**
 * The platform's tag class for a status of an organisation or a person.
 * @param status the status
 * @return the tag class
 */
export function statusTagClass(status: StaffMember['status']): string {
  switch (status) {
    case 'Active':
      return 'tag-accent';
    case 'Invited':
      return 'tag-info';
    default:
      return 'tag-neutral';
  }
}

/**
 * The permissions the onboarding screens need, all of them: they list and add organisations,
 * list and invite users, and list and add offices.
 */
export const ONBOARDING_PERMS: readonly string[] = [
  'admin.organisations',
  'admin.users',
  'admin.offices',
];

/**
 * Whether a user may use the onboarding screens.
 * @param perms the user's permissions
 * @return true when they hold every one of ONBOARDING_PERMS
 */
export function mayOnboard(perms: readonly string[]): boolean {
  return ONBOARDING_PERMS.every(p => perms.includes(p));
}

/**
 * Where the home sends a user instead of the B/L list: an administrator who reads no B/Ls goes to
 * the organisations.
 * @param perms the user's permissions
 * @return the path, or null to stay on the B/L list
 */
export function homeRedirect(perms: readonly string[]): string | null {
  if (mayOnboard(perms) && !perms.includes('bl.read')) {
    return '/admin/organisations';
  }
  return null;
}

/**
 * The field of the new organisation form that organisationProblem is about.
 * @param form what was typed
 * @return the field, or null when there is no problem
 */
export function organisationInvalidField(
  form: OrganisationForm,
): 'name' | 'code' | null {
  const clean = cleanOrganisation(form);
  if (!clean.name) {
    return 'name';
  }
  if (!CODE_PATTERN.test(clean.code)) {
    return 'code';
  }
  return null;
}

/**
 * The field of the invite form that invitationProblem is about.
 * @param form what was typed and chosen
 * @return the field, or null when there is no problem
 */
export function invitationInvalidField(
  form: InvitationForm,
): 'name' | 'email' | 'roles' | null {
  const clean = cleanInvitation(form);
  if (!clean.name) {
    return 'name';
  }
  if (!EMAIL_PATTERN.test(clean.email)) {
    return 'email';
  }
  if (clean.roles.length === 0) {
    return 'roles';
  }
  return null;
}

/** An API key of an organisation (CB-56); `secret` is returned only when created. */
export interface OrganisationApiKey {
  id: string;
  organisationId: string;
  name: string;
  prefix: string;
  perms: string[];
  status: 'Active' | 'Revoked';
  createdAt: string;
  createdByName?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  secret?: string;
}

/**
 * What is wrong with a new API key's name, or null when it can be created (CB-56).
 * @param name key label
 * @return validation message or null
 */
export function apiKeyProblem(name: string): string | null {
  const clean = name.trim();
  if (!clean) {
    return 'Give the API key a name.';
  }
  if (clean.length > 100) {
    return 'The API key name is at most 100 characters.';
  }
  return null;
}

/**
 * Permissions granted to a carrier API key (CB-56): read & draft, optionally direct issue.
 * @param allowIssue whether the key may issue B/Ls directly without a screen approver
 * @return permissions list
 */
export function selectedApiKeyPerms(allowIssue: boolean): string[] {
  return allowIssue
    ? ['bl.read', 'bl.draft', 'bl.issue']
    : ['bl.read', 'bl.draft'];
}
