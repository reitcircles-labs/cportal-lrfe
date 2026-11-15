/**
 * The demo users the readiness check looks for (check-readiness.mjs): those identity creates with
 * SEED_DEMO_PASSWORD (backend/services/identity/src/seed.js), from the install's domain pack. The
 * land registry's are listed here, with their roles as the storyline names them; a shipping
 * install's are read from the shipping pack (CB-48), with their role and organisation.
 */
import {identity as shipping} from '../backend/domains/shipping/src/identity.js';

/** The land registry's demo users (backend/domains/land/src/identity/demo-users.js). */
export const LAND_DEMO_USERS = [
  {email: 'e.shivute@deeds.gov.na', role: 'supervisor'},
  {email: 'k.iipinge@deeds.gov.na', role: 'scan operator'},
  {email: 'a.mwandingi@deeds.gov.na', role: 'reviewer'},
  {email: 'j.gawaseb@deeds.gov.na', role: 'records officer'},
  {email: 'm.nakale@oag.gov.na', role: 'auditor'},
  {email: 'p.hamutenya@deeds.gov.na', role: 'administrator'},
  {email: 's.nangolo@deeds.gov.na', role: 'scan operator'},
  {email: 't.iita@deeds.gov.na', role: 'reviewer'},
  {email: 'w.beukes@deeds.gov.na', role: 'reviewer, auditor'},
  {email: 'h.haimbodi@deeds.gov.na', role: 'records officer'},
  {email: 'd.garoeb@deeds.gov.na', role: 'scan operator, reviewer'},
  // not active in the demo data, on purpose (Administration shows them)
  {
    email: 'f.katjiuongua@deeds.gov.na',
    role: 'records officer',
    status: 'Suspended',
  },
  {email: 's.uirab@oag.gov.na', role: 'auditor', status: 'Invited'},
  {email: 'l.tjiueza@deeds.gov.na', role: 'reviewer', status: 'Invited'},
];

/** The platform's role of the demo data, as the check names it. */
const PLATFORM_ROLE_LABELS = new Map([['adm', 'administrator']]);

/**
 * The demo users of an install: the land registry's, or the shipping pack's.
 * @param {boolean} isShipping whether the install is of the shipping product
 * @return {!Array<{email: string, role: string, status: (string|undefined)}>} each with what the
 *     check reports: the role (and organisation), and the state when the demo data does not have
 *     the user active
 */
export function demoUsersFor(isShipping) {
  if (!isShipping) {
    return LAND_DEMO_USERS;
  }
  const roleLabels = new Map(shipping.roles.map(r => [r.id, r.label]));
  const organisations = new Map(
    shipping.demoOrganisations.map(o => [o.code, o.name]),
  );
  return shipping.demoUsers.map(user => {
    const roles = user.roles
      .map(id => roleLabels.get(id) ?? PLATFORM_ROLE_LABELS.get(id) ?? id)
      .join(', ');
    const organisation = organisations.get(user.organisation);
    const entry = {
      email: user.email,
      role: organisation ? `${roles}, ${organisation}` : roles,
    };
    if (user.status !== 'Active') {
      entry.status = user.status;
    }
    return entry;
  });
}
