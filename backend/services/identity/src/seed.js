import { ROLES, SOD_RULES, DEFAULT_POLICIES, PERMS, CATALOGUE_VERSION, normalizePerms } from './catalogue.js';

const CATALOGUE_KEY = 'catalogue.version';
import { hashPassword } from './crypto.js';

/** The users shown in the frontend demo (angular-app/src/app/state/rbac.service.ts). Fictitious. */
export const DEMO_USERS = [
    ['Elina Shivute', 'e.shivute@deeds.gov.na', 'Deeds Registry · Windhoek', ['sup'], 'Active'],
    ['Kristofina Iipinge', 'k.iipinge@deeds.gov.na', 'Registry floor 2', ['scan'], 'Active'],
    ['Aina Mwandingi', 'a.mwandingi@deeds.gov.na', 'Review desk', ['rev'], 'Active'],
    ['Johannes !Gawaseb', 'j.gawaseb@deeds.gov.na', 'Records desk', ['rec'], 'Active'],
    ['Maria Nakale', 'm.nakale@oag.gov.na', 'Office of the Auditor-General', ['aud'], 'Active'],
    ['Paulus Hamutenya', 'p.hamutenya@deeds.gov.na', 'ICT · Deeds Registry', ['adm'], 'Active'],
    ['Selma Nangolo', 's.nangolo@deeds.gov.na', 'Registry floor 2', ['scan'], 'Active'],
    ['Tangeni Iita', 't.iita@deeds.gov.na', 'Review desk', ['rev'], 'Active'],
    ['Willem Beukes', 'w.beukes@deeds.gov.na', 'Review desk', ['rev', 'aud'], 'Active'],
    ['Hilma Haimbodi', 'h.haimbodi@deeds.gov.na', 'Records desk', ['rec'], 'Active'],
    ['David Garoeb', 'd.garoeb@deeds.gov.na', 'Keetmanshoop sub-registry', ['scan', 'rev'], 'Active'],
    ['Frieda Katjiuongua', 'f.katjiuongua@deeds.gov.na', 'Records desk', ['rec'], 'Suspended'],
    ['Simon Uirab', 's.uirab@oag.gov.na', 'Office of the Auditor-General', ['aud'], 'Invited'],
    ['Lucia Tjiueza', 'l.tjiueza@deeds.gov.na', 'Review desk', ['rev'], 'Invited']
].map(([name, email, office, roles, status]) => ({ name, email, office, roles, status }));

/**
 * Idempotent. Adds whatever of the fixed catalogue is missing, never overwrites edits
 * (a role's edited permissions, a rule switched off, changed policies).
 *
 *   admin:        { name, email, password } — created only if no user exists yet
 *   demoPassword: when set, creates the DEMO_USERS that don't exist yet, with this password
 *                 (invited demo users get no password and stay Invited)
 */
export async function seedIdentity(repo, { admin, demoPassword, log = () => {} } = {}) {
    const roles = await repo.listRoles();
    for (const role of ROLES) {
        if (!roles.some(r => r.id === role.id)) {
            await repo.upsertRole(role);
            log(`role ${role.id} created`);
        }
    }
    // Permissions added to the catalogue since this database was seeded: grant each, once, to the
    // roles that hold it by default. A database without a recorded version predates versioning (1);
    // one whose roles were all created just now is already current.
    const created = roles.length === 0;
    const version = (await repo.getSetting(CATALOGUE_KEY)) ?? (created ? CATALOGUE_VERSION : 1);
    const newer = PERMS.filter(p => (p.since ?? 1) > version);
    if (newer.length) {
        for (const role of await repo.listRoles()) {
            const def = ROLES.find(r => r.id === role.id);
            const add = newer.filter(p => def?.perms.includes(p.id) && !role.perms.includes(p.id)).map(p => p.id);
            if (add.length) {
                await repo.updateRolePerms(role.id, normalizePerms([...role.perms, ...add]));
                log(`role ${role.id}: granted new permission(s) ${add.join(', ')}`);
            }
        }
    }
    if (version !== CATALOGUE_VERSION) await repo.setSetting(CATALOGUE_KEY, CATALOGUE_VERSION);

    const sod = await repo.listSod();
    const missingSod = SOD_RULES.filter(r => !sod.some(x => x.id === r.id));
    if (missingSod.length) await repo.saveSod(missingSod);
    if (!(await repo.getPolicies())) await repo.savePolicies(DEFAULT_POLICIES);

    if (admin && (await repo.listUsers()).length === 0) {
        await repo.createUser({
            name: admin.name, email: admin.email.toLowerCase(), office: admin.office || 'ICT', roles: ['adm'],
            status: 'Active', passwordHash: await hashPassword(admin.password)
        });
        log(`bootstrap admin ${admin.email} created`);
    }

    if (demoPassword) {
        const passwordHash = await hashPassword(demoPassword);
        for (const u of DEMO_USERS) {
            if (await repo.getUserByEmail(u.email)) continue;
            await repo.createUser({ ...u, passwordHash: u.status === 'Invited' ? null : passwordHash });
            log(`demo user ${u.email} created`);
        }
    }
}
