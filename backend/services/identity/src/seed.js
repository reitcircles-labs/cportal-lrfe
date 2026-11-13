import {orgFromEnv} from '@lrfe/common';
import {
  CATALOGUE,
  DEFAULT_POLICIES,
  normalizePerms,
  organisationCodeOf,
} from './catalogue.js';
import {hashPassword} from './crypto.js';

const CATALOGUE_KEY = 'catalogue.version';
/** The setting that holds the id of the default organisation (CB-19). */
export const DEFAULT_ORGANISATION_KEY = 'organisations.default';

/** The demo users of this install's domain pack (fictitious), created with a demo password. */
export const DEMO_USERS = CATALOGUE.demoUsers;

/**
 * Idempotent. Adds whatever of the fixed catalogue is missing, never overwrites edits
 * (a role's edited permissions, a rule switched off, changed policies).
 *
 *   admin:        { name, email, password } — created only if no user exists yet
 *   demoPassword: when set, creates the catalogue's demo users that don't exist yet, with this
 *                 password (invited demo users get no password and stay Invited)
 *   offices:      [{ code, name, type, address, contact }] created only if no office exists yet
 *                 (DEFAULT_OFFICES at start-up); once any office exists, never touched again
 *   catalogue:    the catalogue to seed (catalogueOf(pack)), this install's by default
 *   organisationName: the default organisation's name when it is created (CB-19): the site's
 *                 organisation name (LRFE_ORG_NAME) by default; never renamed afterwards
 *
 * Every office and user without an organisation is put into the default organisation, which is
 * created first when the database has none (an empty database, or one from before organisations).
 */
export async function seedIdentity(
  repo,
  {
    admin,
    demoPassword,
    offices,
    catalogue = CATALOGUE,
    organisationName = orgFromEnv().name,
    log = () => {},
  } = {},
) {
  const roles = await repo.listRoles();
  for (const role of catalogue.roles) {
    if (!roles.some(r => r.id === role.id)) {
      await repo.upsertRole(role);
      log(`role ${role.id} created`);
    }
  }
  // Permissions added to the catalogue since this database was seeded: grant each, once, to the
  // roles that hold it by default. A database without a recorded version predates versioning (1);
  // one whose roles were all created just now is already current.
  const created = roles.length === 0;
  const version =
    (await repo.getSetting(CATALOGUE_KEY)) ?? (created ? catalogue.version : 1);
  const newer = catalogue.perms.filter(p => (p.since ?? 1) > version);
  if (newer.length) {
    for (const role of await repo.listRoles()) {
      const def = catalogue.roles.find(r => r.id === role.id);
      const add = newer
        .filter(p => def?.perms.includes(p.id) && !role.perms.includes(p.id))
        .map(p => p.id);
      if (add.length) {
        await repo.updateRolePerms(
          role.id,
          normalizePerms([...role.perms, ...add], catalogue.permIds),
        );
        log(`role ${role.id}: granted new permission(s) ${add.join(', ')}`);
      }
    }
  }
  if (version !== catalogue.version) {
    await repo.setSetting(CATALOGUE_KEY, catalogue.version);
  }

  const sod = await repo.listSod();
  const missingSod = catalogue.sodRules.filter(
    r => !sod.some(x => x.id === r.id),
  );
  if (missingSod.length) await repo.saveSod(missingSod);
  if (!(await repo.getPolicies())) await repo.savePolicies(DEFAULT_POLICIES);

  const organisationId = await ensureDefaultOrganisation(
    repo,
    organisationName,
    log,
  );

  if (offices?.length && (await repo.listOffices()).length === 0) {
    for (const o of offices) await repo.createOffice({...o, status: 'Active'});
    log(`offices created: ${offices.map(o => o.code).join(', ')}`);
  }

  if (admin && (await repo.listUsers()).length === 0) {
    await repo.createUser({
      name: admin.name,
      email: admin.email.toLowerCase(),
      office: admin.office || 'ICT',
      roles: ['adm'],
      status: 'Active',
      passwordHash: await hashPassword(admin.password),
    });
    log(`bootstrap admin ${admin.email} created`);
  }

  if (demoPassword) {
    const passwordHash = await hashPassword(demoPassword);
    for (const u of catalogue.demoUsers) {
      if (await repo.getUserByEmail(u.email)) continue;
      await repo.createUser({
        ...u,
        passwordHash: u.status === 'Invited' ? null : passwordHash,
      });
      log(`demo user ${u.email} created`);
    }
  }

  const assigned = await repo.assignOrganisation(organisationId);
  if (assigned.offices || assigned.users) {
    log(
      `default organisation: ${assigned.offices} office(s) and ${assigned.users} user(s) added`,
    );
  }
}

/**
 * The id of the default organisation, created when the database has none. Idempotent.
 * @param {!Object} repo
 * @param {string} name the name to give it when it is created
 * @param {function(string)} log
 * @return {!Promise<string>}
 */
async function ensureDefaultOrganisation(repo, name, log) {
  const id = await repo.getSetting(DEFAULT_ORGANISATION_KEY);
  if (id && (await repo.getOrganisation(id))) {
    return id;
  }
  // Organisations without a recorded default only if the setting was lost: keep the first one.
  let [organisation] = await repo.listOrganisations();
  if (!organisation) {
    organisation = await repo.createOrganisation({
      code: organisationCodeOf(name),
      name,
      status: 'Active',
    });
    log(
      `default organisation ${organisation.code} · ${organisation.name} created`,
    );
  }
  await repo.setSetting(DEFAULT_ORGANISATION_KEY, organisation.id);
  return organisation.id;
}
