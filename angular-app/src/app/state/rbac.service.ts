import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

export interface Perm { id: string; group: string; label: string; desc: string; }
export interface RoleDef { id: string; label: string; desc: string; system: boolean; perms: string[]; }
export type UserStatus = 'Active' | 'Suspended' | 'Invited';
export interface AppUser { id: string; name: string; email: string; office: string; roles: string[]; status: UserStatus; mfa: boolean; lastActive: string; }
export interface SodRule { id: string; a: string; b: string; label: string; on: boolean; }
export interface Policies { mfa: boolean; eid: boolean; ipAllow: boolean; timeout: number; fourEyes: boolean; }
export type AccessKind = 'role' | 'user' | 'policy' | 'denied' | 'session';
export interface AccessEvent { time: string; actor: string; kind: AccessKind; action: string; target: string; detail: string; }

export const PERM_GROUPS = ['General', 'Capture', 'Verification', 'Land records', 'Audit', 'Administration'];
export const PERMS: Perm[] = [
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
  { id: 'admin.policies', group: 'Administration', label: 'Manage security policies', desc: 'MFA, sessions, segregation of duties' }
];

const R = (id: string, label: string, desc: string, perms: string[], system = true): RoleDef => ({ id, label, desc, system, perms });
const ROLE_DEFS: RoleDef[] = [
  R('sup', 'Registrar (supervisor)', 'Oversees the registry. Finalizes records and reviews audit evidence.', ['dashboard.view', 'capture.view', 'verify.view', 'record.view', 'record.comment', 'record.finalize', 'audit.view', 'audit.export', 'admin.users']),
  R('scan', 'Scan operator', 'Captures deeds, grants and SG diagrams at the scan station.', ['dashboard.view', 'capture.view', 'capture.scan', 'capture.rescan']),
  R('rev', 'Metadata reviewer', 'Verifies extracted metadata against the image and files to the EDRMS.', ['dashboard.view', 'capture.view', 'capture.rescan', 'verify.view', 'verify.edit', 'verify.file', 'record.view', 'record.comment']),
  R('rec', 'Records officer', 'Creates land records, links documents and prepares them for finalization.', ['dashboard.view', 'verify.view', 'record.view', 'record.create', 'record.link', 'record.unlink', 'record.comment', 'record.finalize']),
  R('aud', 'Auditor · read-only', 'Office of the Auditor-General. Inspects evidence and signs off; cannot change records.', ['dashboard.view', 'capture.view', 'verify.view', 'record.view', 'audit.view', 'audit.signoff', 'audit.export']),
  R('adm', 'System administrator', 'Manages users, roles and security policies. No rights over land-record data.', ['dashboard.view', 'audit.view', 'admin.users', 'admin.roles', 'admin.policies'])
];

const U = (id: string, name: string, email: string, office: string, roles: string[], status: UserStatus, mfa: boolean, lastActive: string): AppUser => ({ id, name, email, office, roles, status, mfa, lastActive });
const USERS: AppUser[] = [
  U('u1', 'Elina Shivute', 'e.shivute@deeds.gov.na', 'Deeds Registry · Windhoek', ['sup'], 'Active', true, 'Today 08:55'),
  U('u2', 'Kristofina Iipinge', 'k.iipinge@deeds.gov.na', 'Registry floor 2', ['scan'], 'Active', true, 'Today 08:40'),
  U('u3', 'Aina Mwandingi', 'a.mwandingi@deeds.gov.na', 'Review desk', ['rev'], 'Active', true, 'Today 09:14'),
  U('u4', 'Johannes !Gawaseb', 'j.gawaseb@deeds.gov.na', 'Records desk', ['rec'], 'Active', true, 'Today 09:02'),
  U('u5', 'Maria Nakale', 'm.nakale@oag.gov.na', 'Office of the Auditor-General', ['aud'], 'Active', true, 'Yesterday 16:20'),
  U('u6', 'Paulus Hamutenya', 'p.hamutenya@deeds.gov.na', 'ICT · Deeds Registry', ['adm'], 'Active', true, 'Today 07:48'),
  U('u7', 'Selma Nangolo', 's.nangolo@deeds.gov.na', 'Registry floor 2', ['scan'], 'Active', false, 'Today 08:31'),
  U('u8', 'Tangeni Iita', 't.iita@deeds.gov.na', 'Review desk', ['rev'], 'Active', true, 'Yesterday 17:05'),
  U('u9', 'Willem Beukes', 'w.beukes@deeds.gov.na', 'Review desk', ['rev', 'aud'], 'Active', true, '2 days ago'),
  U('u10', 'Hilma Haimbodi', 'h.haimbodi@deeds.gov.na', 'Records desk', ['rec'], 'Active', true, 'Today 08:10'),
  U('u11', 'David Garoeb', 'd.garoeb@deeds.gov.na', 'Keetmanshoop sub-registry', ['scan', 'rev'], 'Active', false, '3 days ago'),
  U('u12', 'Frieda Katjiuongua', 'f.katjiuongua@deeds.gov.na', 'Records desk', ['rec'], 'Suspended', true, '12 Sep 2026'),
  U('u13', 'Simon Uirab', 's.uirab@oag.gov.na', 'Office of the Auditor-General', ['aud'], 'Invited', false, '—'),
  U('u14', 'Lucia Tjiueza', 'l.tjiueza@deeds.gov.na', 'Review desk', ['rev'], 'Invited', false, '—')
];

const SOD: SodRule[] = [
  { id: 'sod1', a: 'verify.file', b: 'audit.signoff', label: 'Reviewers cannot audit documents they can file', on: true },
  { id: 'sod2', a: 'record.finalize', b: 'audit.signoff', label: 'Whoever finalizes records cannot sign off audits', on: true },
  { id: 'sod3', a: 'admin.roles', b: 'record.finalize', label: 'Administrators cannot finalize land records', on: true },
  { id: 'sod4', a: 'capture.scan', b: 'verify.file', label: 'Scan operators cannot file what they capture', on: false }
];

const SEED_LOG: AccessEvent[] = [
  { time: '28 Sep 2026 07:48', actor: 'P. Hamutenya', kind: 'session', action: 'Signed in', target: 'P. Hamutenya', detail: 'as System administrator · MFA' },
  { time: '27 Sep 2026 16:02', actor: 'P. Hamutenya', kind: 'user', action: 'Invited', target: 'Lucia Tjiueza', detail: 'Role: Metadata reviewer' },
  { time: '27 Sep 2026 15:40', actor: 'P. Hamutenya', kind: 'role', action: 'Permissions changed', target: 'Metadata reviewer', detail: '+ Flag pages for rescan' },
  { time: '26 Sep 2026 11:15', actor: 'System', kind: 'denied', action: 'Access denied', target: 'K. Iipinge', detail: 'View land records' },
  { time: '12 Sep 2026 09:30', actor: 'E. Shivute', kind: 'user', action: 'Suspended', target: 'Frieda Katjiuongua', detail: 'Extended leave' },
  { time: '05 Sep 2026 10:00', actor: 'P. Hamutenya', kind: 'policy', action: 'Policy updated', target: 'Session timeout', detail: '60 → 30 minutes' }
];

const stamp = () => { const d = new Date(); return '28 Sep 2026 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

@Injectable({ providedIn: 'root' })
export class RbacService {
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  readonly roles = signal<RoleDef[]>(ROLE_DEFS);
  readonly users = signal<AppUser[]>(USERS);
  readonly sod = signal<SodRule[]>(SOD);
  readonly policies = signal<Policies>({ mfa: true, eid: true, ipAllow: false, timeout: 30, fourEyes: true });
  readonly log = signal<AccessEvent[]>(SEED_LOG);
  private seq = 0;

  readonly currentPerms = computed(() => this.roles().find(r => r.id === this.auth.roleId())?.perms || []);

  constructor() {
    effect(() => {
      const r = this.auth.role();
      if (r) untracked(() => this.record('session', 'Signed in', r.name, 'as ' + r.label));
    }, { allowSignalWrites: true });
  }

  can(perm: string) { return this.currentPerms().includes(perm); }
  perm(id: string) { return PERMS.find(p => p.id === id); }
  permLabel(id: string) { return this.perm(id)?.label || id; }
  roleLabel(id?: string | null) { return this.roles().find(r => r.id === (id ?? this.auth.roleId()))?.label || 'Unknown role'; }
  effective(roleIds: string[]) {
    const s = new Set<string>();
    roleIds.forEach(id => this.roles().find(r => r.id === id)?.perms.forEach(p => s.add(p)));
    return PERMS.map(p => p.id).filter(p => s.has(p));
  }
  conflicts(perms: string[], rules = this.sod()) { return rules.filter(r => r.on && perms.includes(r.a) && perms.includes(r.b)); }
  userConflicts(u: AppUser) { return this.conflicts(this.effective(u.roles)); }

  deny(perm: string, notify = true) {
    const who = this.auth.role();
    this.record('denied', 'Access denied', who?.name || '—', this.permLabel(perm), 'System');
    if (notify) this.toast.show('warn', 'Not permitted', this.roleLabel() + ' cannot “' + this.permLabel(perm).toLowerCase() + '”. Ask a system administrator.');
  }
  record(kind: AccessKind, action: string, target: string, detail: string, actor?: string) {
    this.log.update(l => [{ time: stamp(), actor: actor || this.auth.role()?.name || 'System', kind, action, target, detail }, ...l]);
  }

  // users
  saveUserRoles(uid: string, roles: string[]) {
    const u = this.users().find(x => x.id === uid)!;
    const added = roles.filter(r => !u.roles.includes(r)).map(r => '+ ' + this.roleLabel(r));
    const removed = u.roles.filter(r => !roles.includes(r)).map(r => '− ' + this.roleLabel(r));
    this.users.update(us => us.map(x => x.id === uid ? { ...x, roles: [...roles] } : x));
    this.record('user', 'Roles changed', u.name, [...added, ...removed].join(', '));
    this.toast.show('success', 'Roles updated for ' + u.name, [...added, ...removed].join(' · '));
  }
  setStatus(uid: string, status: UserStatus, reason = '') {
    const u = this.users().find(x => x.id === uid)!;
    this.users.update(us => us.map(x => x.id === uid ? { ...x, status } : x));
    this.record('user', status === 'Suspended' ? 'Suspended' : 'Reactivated', u.name, reason || (status === 'Suspended' ? 'Access revoked' : 'Access restored'));
    this.toast.show(status === 'Suspended' ? 'warn' : 'success', u.name + (status === 'Suspended' ? ' suspended' : ' reactivated'), status === 'Suspended' ? 'All sessions ended; sign-in blocked.' : 'The user can sign in again.');
  }
  resetMfa(uid: string) {
    const u = this.users().find(x => x.id === uid)!;
    this.users.update(us => us.map(x => x.id === uid ? { ...x, mfa: false } : x));
    this.record('user', 'MFA reset', u.name, 'Must re-enrol at next sign-in');
    this.toast.show('info', 'MFA reset for ' + u.name, 'They will enrol a new authenticator at next sign-in.');
  }
  resendInvite(uid: string) {
    const u = this.users().find(x => x.id === uid)!;
    this.record('user', 'Invitation resent', u.name, u.email);
    this.toast.show('info', 'Invitation resent', u.email);
  }
  invite(d: { name: string; email: string; office: string; roles: string[] }) {
    const id = 'n' + (++this.seq);
    this.users.update(us => [{ id, ...d, status: 'Invited', mfa: false, lastActive: '—' }, ...us]);
    this.record('user', 'Invited', d.name, 'Roles: ' + d.roles.map(r => this.roleLabel(r)).join(', '));
    this.toast.show('success', 'Invitation sent to ' + d.name, d.email);
    return id;
  }

  // roles
  saveMatrix(next: Record<string, string[]>) {
    let n = 0;
    this.roles().forEach(r => {
      const before = new Set(r.perms), after = new Set(next[r.id] || []);
      const add = PERMS.filter(p => after.has(p.id) && !before.has(p.id)).map(p => '+ ' + p.label);
      const rem = PERMS.filter(p => before.has(p.id) && !after.has(p.id)).map(p => '− ' + p.label);
      if (add.length + rem.length) { n += add.length + rem.length; this.record('role', 'Permissions changed', r.label, [...add, ...rem].join(', ')); }
    });
    this.roles.update(rs => rs.map(r => ({ ...r, perms: PERMS.map(p => p.id).filter(p => (next[r.id] || []).includes(p)) })));
    this.toast.show('success', 'Permission matrix saved', n + ' change' + (n === 1 ? '' : 's') + ' applied. They take effect immediately.');
  }
  createRole(label: string, desc: string, cloneFrom: string | null) {
    const id = 'c' + (++this.seq);
    const perms = cloneFrom ? [...(this.roles().find(r => r.id === cloneFrom)?.perms || [])] : ['dashboard.view'];
    this.roles.update(rs => [...rs, { id, label, desc, system: false, perms }]);
    this.record('role', 'Role created', label, cloneFrom ? 'Cloned from ' + this.roleLabel(cloneFrom) : 'Empty role');
    this.toast.show('success', 'Role “' + label + '” created', 'Adjust its permissions in the matrix.');
    return id;
  }
  deleteRole(id: string) {
    const r = this.roles().find(x => x.id === id)!;
    this.roles.update(rs => rs.filter(x => x.id !== id));
    this.record('role', 'Role deleted', r.label, '');
    this.toast.show('warn', 'Role “' + r.label + '” deleted');
  }

  // policies
  savePolicies(p: Policies, rules: SodRule[]) {
    const old = this.policies(), ch: string[] = [];
    if (old.mfa !== p.mfa) ch.push('MFA ' + (p.mfa ? 'required' : 'optional'));
    if (old.eid !== p.eid) ch.push('National eID ' + (p.eid ? 'on' : 'off'));
    if (old.ipAllow !== p.ipAllow) ch.push('Network restriction ' + (p.ipAllow ? 'on' : 'off'));
    if (old.timeout !== p.timeout) ch.push('Session timeout ' + old.timeout + ' → ' + p.timeout + ' min');
    if (old.fourEyes !== p.fourEyes) ch.push('Four-eyes finalization ' + (p.fourEyes ? 'on' : 'off'));
    rules.forEach(r => { const o = this.sod().find(x => x.id === r.id); if (o && o.on !== r.on) ch.push((r.on ? 'Enabled: ' : 'Disabled: ') + r.label); });
    this.policies.set(p); this.sod.set(rules);
    this.record('policy', 'Policy updated', 'Security policies', ch.join(' · ') || 'No changes');
    this.toast.show('success', 'Security policies saved', ch.length + ' change' + (ch.length === 1 ? '' : 's'));
  }
}

export const permGuard: CanActivateFn = (route) => {
  const perm = route.data?.['perm'];
  if (!perm) return true;
  const rbac = inject(RbacService);
  if (rbac.can(perm)) return true;
  rbac.deny(perm, false);
  return inject(Router).createUrlTree(['/denied'], { queryParams: { perm } });
};
