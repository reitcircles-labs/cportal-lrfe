/**
 * Fixed catalogue: permissions, the six system roles, segregation-of-duties rules and default
 * security policies. Mirrors angular-app/src/app/state/rbac.service.ts. Roles cannot be created
 * or deleted; only their permission sets (the admin "Roles & permissions" matrix) are editable.
 */

export const PERM_GROUPS = ['General', 'Capture', 'Verification', 'Land records', 'Audit', 'Administration'];

export const PERMS = [
    { id: 'dashboard.view', group: 'General', label: 'View dashboard', desc: 'KPIs, land records register, recent activity' },
    { id: 'capture.view', group: 'Capture', label: 'View capture station', desc: 'Batches, incoming pages, scanner status' },
    { id: 'capture.scan', group: 'Capture', label: 'Run scans & imports', desc: 'Start the scanner or ingest the hot folder' },
    { id: 'capture.rescan', group: 'Capture', label: 'Flag pages for rescan', desc: 'Mark poor captures for the operator' },
    { id: 'verify.view', group: 'Verification', label: 'View review queue', desc: 'Open documents and extracted metadata' },
    { id: 'verify.edit', group: 'Verification', label: 'Accept & correct metadata', desc: 'Change extracted field values' },
    { id: 'verify.file', group: 'Verification', label: 'File documents to EDRMS', desc: 'Approve a document as a record' },
    { id: 'record.view', group: 'Land records', label: 'View land records', desc: 'ERP records, linked documents, owners' },
    { id: 'record.create', group: 'Land records', label: 'Create land records', desc: 'Open a new erf or farm record' },
    { id: 'record.link', group: 'Land records', label: 'Add documents to records', desc: 'Link EDRMS documents to a record' },
    { id: 'record.unlink', group: 'Land records', label: 'Remove documents from records', desc: 'Return a document to the unlinked pool' },
    { id: 'record.comment', group: 'Land records', label: 'Comment on records', desc: 'Post to the record discussion thread' },
    { id: 'record.finalize', group: 'Land records', label: 'Finalize records', desc: 'Commit a version for tokenization' },
    { id: 'audit.view', group: 'Audit', label: 'View audit trail & evidence', desc: 'Provenance, hashes, full trail' },
    { id: 'audit.signoff', group: 'Audit', label: 'Sign off & raise findings', desc: 'Record the auditor’s conclusion' },
    { id: 'audit.export', group: 'Audit', label: 'Export evidence packs', desc: 'Download images, metadata and trail' },
    { id: 'admin.users', group: 'Administration', label: 'Manage users', desc: 'Invite, assign roles, suspend' },
    { id: 'admin.roles', group: 'Administration', label: 'Manage roles & permissions', desc: 'Edit the permission matrix' },
    { id: 'admin.policies', group: 'Administration', label: 'Manage security policies', desc: 'MFA, sessions, segregation of duties' },
    { id: 'admin.offices', group: 'Administration', label: 'Manage offices', desc: 'Add, rename and suspend office locations', since: 2 }
];

/**
 * Catalogue version. A permission with `since: n` was added in version n: when an existing
 * database is on an older version, the seed grants it to the roles that hold it by default
 * (below), once, and never touches it again (an administrator may have removed it since).
 */
export const CATALOGUE_VERSION = 2;

export const PERM_IDS = PERMS.map(p => p.id);
export const isKnownPerm = (id) => PERM_IDS.includes(id);
export const permLabel = (id) => PERMS.find(p => p.id === id)?.label || id;
/** Order a permission list by catalogue order and drop unknown/duplicate ids. */
export const normalizePerms = (perms) => PERM_IDS.filter(p => perms.includes(p));

const role = (id, label, desc, home, perms) => ({ id, label, desc, home, system: true, perms });

export const ROLES = [
    role('sup', 'Registrar (supervisor)', 'Oversees the registry. Finalizes records and reviews audit evidence.', '/',
        ['dashboard.view', 'capture.view', 'verify.view', 'record.view', 'record.comment', 'record.finalize', 'audit.view', 'audit.export', 'admin.users']),
    role('scan', 'Scan operator', 'Captures deeds, grants and SG diagrams at the scan station.', '/capture',
        ['dashboard.view', 'capture.view', 'capture.scan', 'capture.rescan']),
    role('rev', 'Metadata reviewer', 'Verifies extracted metadata against the image and files to the EDRMS.', '/verify',
        ['dashboard.view', 'capture.view', 'capture.rescan', 'verify.view', 'verify.edit', 'verify.file', 'record.view', 'record.comment']),
    role('rec', 'Records officer', 'Creates land records, links documents and prepares them for finalization.', '/link',
        ['dashboard.view', 'verify.view', 'record.view', 'record.create', 'record.link', 'record.unlink', 'record.comment', 'record.finalize']),
    role('aud', 'Auditor · read-only', 'Office of the Auditor-General. Inspects evidence and signs off; cannot change records.', '/audit',
        ['dashboard.view', 'capture.view', 'verify.view', 'record.view', 'audit.view', 'audit.signoff', 'audit.export']),
    role('adm', 'System administrator', 'Manages users, roles and security policies. No rights over land-record data.', '/admin/users',
        ['dashboard.view', 'audit.view', 'admin.users', 'admin.roles', 'admin.policies', 'admin.offices'])
];

export const ROLE_IDS = ROLES.map(r => r.id);

export const SOD_RULES = [
    { id: 'sod1', a: 'verify.file', b: 'audit.signoff', label: 'Reviewers cannot audit documents they can file', on: true },
    { id: 'sod2', a: 'record.finalize', b: 'audit.signoff', label: 'Whoever finalizes records cannot sign off audits', on: true },
    { id: 'sod3', a: 'admin.roles', b: 'record.finalize', label: 'Administrators cannot finalize land records', on: true },
    { id: 'sod4', a: 'capture.scan', b: 'verify.file', label: 'Scan operators cannot file what they capture', on: false }
];

export const ACCESS_KINDS = ['role', 'user', 'policy', 'denied', 'session', 'office'];

/** Offices: locations users belong to. A code is fixed once created (it will appear in numbers). */
export const OFFICE_TYPES = ['registry', 'external'];
export const OFFICE_CODE_PATTERN = '^[A-Z]{2,5}$';
/** Roles whose holders may have no office ("national"); everyone else is invited into one. */
export const NATIONAL_ROLES = ['adm'];

export const DEFAULT_POLICIES ={ mfa: true, eid: true, ipAllow: false, timeout: 30, fourEyes: true };

/** Union of the permissions granted by `roleIds`, given the current role definitions. */
export function effectivePerms(roleIds, roles) {
    const granted = new Set();
    for (const id of roleIds) roles.find(r => r.id === id)?.perms.forEach(p => granted.add(p));
    return PERM_IDS.filter(p => granted.has(p));
}

/** Enabled SoD rules violated by holding all of `perms`. */
export function sodConflicts(perms, rules) {
    return rules.filter(r => r.on && perms.includes(r.a) && perms.includes(r.b));
}
