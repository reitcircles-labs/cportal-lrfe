import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { ApiError, ApiService } from '../api/api.service';

export interface Perm { id: string; group: string; label: string; desc: string; }
export interface RoleDef { id: string; label: string; desc: string; system: boolean; perms: string[]; home?: string; }
export type UserStatus = 'Active' | 'Suspended' | 'Invited';
/** `office` is the office's name, '' when the user has none (national administrators, or not assigned yet). */
export interface AppUser { id: string; name: string; email: string; office: string; officeId: string | null; officeCode: string | null; roles: string[]; status: UserStatus; mfa: boolean; lastActive: string; }
export type OfficeType = 'registry' | 'external';
export interface Office { id: string; code: string; name: string; type: OfficeType; address: string; contact: string; status: 'Active' | 'Suspended'; users: number; }
export const OFFICE_TYPE_LABEL: Record<OfficeType, string> = { registry: 'Registry office', external: 'External body' };
/** Roles whose holders may have no office (mirrors NATIONAL_ROLES in the identity catalogue). */
export const NATIONAL_ROLES = ['adm'];
export interface SodRule { id: string; a: string; b: string; label: string; on: boolean; }
export interface Policies { mfa: boolean; eid: boolean; ipAllow: boolean; timeout: number; fourEyes: boolean; }
export type AccessKind = 'role' | 'user' | 'policy' | 'denied' | 'session' | 'office';
export interface AccessEvent { time: string; actor: string; kind: AccessKind; action: string; target: string; detail: string; }

/**
 * Permission catalogue. The identity service is the source of truth (GET /api/catalogue returns
 * the same list); it is mirrored here so the admin screens can group and label permissions.
 */
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
  { id: 'admin.policies', group: 'Administration', label: 'Manage security policies', desc: 'MFA, sessions, segregation of duties' },
  { id: 'admin.offices', group: 'Administration', label: 'Manage offices', desc: 'Add, rename and suspend office locations' }
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "28 Sep 2026 09:14" in local time. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Roles, permissions, users, policies and the access log — backed by the identity service.
 * `can()` reflects the signed-in user's permissions from the server; the server enforces them
 * again on every call, so this only decides what the UI offers.
 */
/** POST /users and POST /users/:id/invitation: whether the invitation was emailed. */
interface InviteResult { email?: { sent: boolean; to: string; reason?: string }; inviteUrl?: string; }

@Injectable({ providedIn: 'root' })
export class RbacService {
  private auth = inject(AuthService);
  private api = inject(ApiService);
  private toast = inject(ToastService);

  readonly roles = signal<RoleDef[]>([]);
  readonly users = signal<AppUser[]>([]);
  readonly sod = signal<SodRule[]>([]);
  readonly policies = signal<Policies>({ mfa: true, eid: true, ipAllow: false, timeout: 30, fourEyes: true });
  readonly log = signal<AccessEvent[]>([]);
  readonly offices = signal<Office[]>([]);
  readonly activeOffices = computed(() => this.offices().filter(o => o.status === 'Active'));
  /** Invitation link returned by the server in dev (no email service yet); shown to the admin. */
  /** Shown when the invitation email did not go out but the server exposes the link (dev). */
  readonly lastInviteLink = signal<{ name: string; email: string; url: string; reason: string } | null>(null);

  readonly currentPerms = computed(() => this.auth.perms());

  constructor() {
    // Role labels are needed everywhere (sidebar, admin): load them whenever a session starts.
    effect(() => {
      const userId = this.auth.me()?.user.id;
      untracked(() => {
        if (userId) this.loadRoles();
        else { this.roles.set([]); this.users.set([]); this.log.set([]); this.sod.set([]); }
      });
    });
  }

  can(perm: string) { return this.currentPerms().includes(perm); }
  canAny(perms: string[]) { return perms.some(p => this.can(p)); }
  perm(id: string) { return PERMS.find(p => p.id === id); }
  permLabel(id: string) { return this.perm(id)?.label || id; }
  roleLabel(id?: string | null) {
    if (id == null) return this.auth.role()?.label || 'Unknown role';
    return this.roles().find(r => r.id === id)?.label || id;
  }
  effective(roleIds: string[]) {
    const s = new Set<string>();
    roleIds.forEach(id => this.roles().find(r => r.id === id)?.perms.forEach(p => s.add(p)));
    return PERMS.map(p => p.id).filter(p => s.has(p));
  }
  conflicts(perms: string[], rules = this.sod()) { return rules.filter(r => r.on && perms.includes(r.a) && perms.includes(r.b)); }
  userConflicts(u: AppUser) { return this.conflicts(this.effective(u.roles)); }

  /** A control the user may not use was clicked. The server logs denials of real API calls. */
  deny(perm: string, notify = true) {
    if (notify) this.toast.show('warn', 'Not permitted', this.roleLabel() + ' cannot “' + this.permLabel(perm).toLowerCase() + '”. Ask a system administrator.');
  }

  private fail(title: string, e: unknown) {
    this.toast.show('danger', title, e instanceof ApiError ? e.message : String(e), 7000);
  }

  // ------------------------------------------------------------------ loading

  /** Role definitions (labels, permissions). Any signed-in user may read them. */
  async loadRoles() {
    try {
      const { roles } = await this.api.get<{ roles: RoleDef[] }>('/roles');
      this.roles.set(roles);
    } catch (e) { this.fail('Could not load roles', e); }
  }

  /** Everything the admin screens show, as far as the user's permissions allow. */
  async loadAdmin() {
    const jobs: Promise<unknown>[] = [this.loadRoles()];
    if (this.can('admin.users')) jobs.push(this.loadUsers(), this.loadLog());
    if (this.can('admin.users') || this.can('admin.offices')) jobs.push(this.loadOffices());
    if (this.can('admin.users') || this.can('admin.policies')) jobs.push(this.loadPolicies());
    await Promise.all(jobs);
  }

  async loadUsers() {
    try {
      const { users } = await this.api.get<{ users: any[] }>('/users');
      this.users.set(users.map(u => ({ ...u, lastActive: u.lastActive ? fmtTime(u.lastActive) : '—' })));
    } catch (e) { this.fail('Could not load users', e); }
  }

  async loadOffices() {
    try {
      this.offices.set((await this.api.get<{ offices: Office[] }>('/offices')).offices);
    } catch (e) { this.fail('Could not load offices', e); }
  }

  async loadPolicies() {
    try {
      const { policies, sod } = await this.api.get<{ policies: Policies; sod: SodRule[] }>('/policies');
      this.policies.set(policies);
      this.sod.set(sod);
    } catch (e) { this.fail('Could not load security policies', e); }
  }

  async loadLog() {
    try {
      const { items } = await this.api.get<{ items: any[] }>('/access-log', { limit: 200 });
      this.log.set(items.map(e => ({ time: fmtTime(e.time), actor: e.actor, kind: e.kind, action: e.action, target: e.target, detail: e.detail })));
    } catch (e) { this.fail('Could not load the access log', e); }
  }

  // ------------------------------------------------------------------ users

  async saveUserRoles(uid: string, roles: string[]) {
    const u = this.users().find(x => x.id === uid)!;
    try {
      await this.api.put(`/users/${uid}/roles`, { roles });
      this.toast.show('success', 'Roles updated for ' + u.name, roles.map(r => this.roleLabel(r)).join(' · '));
      await Promise.all([this.loadUsers(), this.loadLog()]);
    } catch (e) { this.fail('Roles not changed', e); }
  }

  async setStatus(uid: string, status: UserStatus, reason = '') {
    const u = this.users().find(x => x.id === uid)!;
    const suspend = status === 'Suspended';
    try {
      await this.api.post(`/users/${uid}/${suspend ? 'suspend' : 'reactivate'}`, reason ? { reason } : {});
      this.toast.show(suspend ? 'warn' : 'success', u.name + (suspend ? ' suspended' : ' reactivated'), suspend ? 'All sessions ended; sign-in blocked.' : 'The user can sign in again.');
      await Promise.all([this.loadUsers(), this.loadLog()]);
    } catch (e) { this.fail(suspend ? 'User not suspended' : 'User not reactivated', e); }
  }

  async resetMfa(uid: string) {
    const u = this.users().find(x => x.id === uid)!;
    try {
      await this.api.post(`/users/${uid}/mfa-reset`);
      this.toast.show('info', 'MFA reset for ' + u.name, 'They will enrol a new authenticator at next sign-in.');
      await Promise.all([this.loadUsers(), this.loadLog()]);
    } catch (e) { this.fail('MFA not reset', e); }
  }

  async resendInvite(uid: string) {
    const u = this.users().find(x => x.id === uid)!;
    try {
      const res = await this.api.post<InviteResult>(`/users/${uid}/invitation`);
      this.reportInvite(u.name, u.email, res, true);
      await this.loadLog();
    } catch (e) { this.fail('Invitation not resent', e); }
  }

  async invite(d: { name: string; email: string; officeId: string | null; roles: string[] }): Promise<boolean> {
    try {
      const res = await this.api.post<InviteResult & { user: AppUser }>('/users', d);
      this.reportInvite(d.name, d.email, res, false);
      await Promise.all([this.loadUsers(), this.loadLog(), this.loadOffices()]);
      return true;
    } catch (e) { this.fail('Invitation not sent', e); return false; }
  }

  /** Tell the admin whether the invitation email went out; if not, why, and the link when exposed. */
  private reportInvite(name: string, email: string, res: InviteResult, resend: boolean) {
    if (res.email?.sent) {
      this.toast.show('success', `Invitation ${resend ? 're' : ''}sent to ${name}`, `Emailed to ${email}. The link expires in 3 days.`, 6000);
      return;
    }
    const reason = res.email?.reason || 'Email is not configured on the server';
    if (res.inviteUrl) this.lastInviteLink.set({ name, email, url: res.inviteUrl, reason });
    else this.toast.show('warn', `${resend ? 'New invitation created' : name + ' was invited'}, but the email was not sent`, `${reason}. Fix the email settings, then use Resend invite.`, 10000);
  }

  // ------------------------------------------------------------------ offices

  async addOffice(d: { code: string; name: string; type: OfficeType; address: string; contact: string }): Promise<boolean> {
    try {
      const o = await this.api.post<Office>('/offices', d);
      this.toast.show('success', `Office ${o.code} added`, o.name);
      await Promise.all([this.loadOffices(), this.loadLog()]);
      return true;
    } catch (e) { this.fail('Office not added', e); return false; }
  }

  async updateOffice(id: string, d: { name: string; type: OfficeType; address: string; contact: string }): Promise<boolean> {
    try {
      const o = await this.api.put<Office>(`/offices/${id}`, d);
      this.toast.show('success', `Office ${o.code} saved`, o.name);
      await Promise.all([this.loadOffices(), this.loadUsers(), this.loadLog()]);
      return true;
    } catch (e) { this.fail('Office not saved', e); return false; }
  }

  async setOfficeStatus(o: Office, suspend: boolean) {
    try {
      await this.api.post(`/offices/${o.id}/${suspend ? 'suspend' : 'reactivate'}`);
      this.toast.show(suspend ? 'warn' : 'success', `${o.code} ${suspend ? 'suspended' : 'reactivated'}`, suspend ? 'No new invitations into this office. Its users carry on.' : 'Users can be invited into it again.');
      await Promise.all([this.loadOffices(), this.loadLog()]);
    } catch (e) { this.fail(suspend ? 'Office not suspended' : 'Office not reactivated', e); }
  }

  async setUserOffice(uid: string, officeId: string | null): Promise<boolean> {
    const u = this.users().find(x => x.id === uid);
    try {
      const res = await this.api.put<AppUser>(`/users/${uid}/office`, { officeId });
      this.toast.show('success', `Office changed for ${u?.name ?? 'the user'}`, res.office || 'National (no office)');
      await Promise.all([this.loadUsers(), this.loadOffices(), this.loadLog()]);
      return true;
    } catch (e) { this.fail('Office not changed', e); return false; }
  }

  // ------------------------------------------------------------------ roles (fixed set; permissions editable)

  async saveMatrix(next: Record<string, string[]>) {
    try {
      const res = await this.api.put<{ roles: RoleDef[]; changes: number }>('/roles/permissions', { matrix: next });
      this.roles.set(res.roles);
      this.toast.show('success', 'Permission matrix saved', res.changes + ' change' + (res.changes === 1 ? '' : 's') + ' applied. Users get them at their next token refresh (within 15 minutes).');
      await Promise.all([this.loadLog(), this.auth.reloadMe()]);
    } catch (e) { this.fail('Permission matrix not saved', e); }
  }

  // ------------------------------------------------------------------ policies

  async savePolicies(p: Policies, rules: SodRule[]) {
    try {
      const res = await this.api.put<{ policies: Policies; sod: SodRule[]; changes: number }>('/policies', { policies: p, sod: rules.map(r => ({ id: r.id, on: r.on })) });
      this.policies.set(res.policies);
      this.sod.set(res.sod);
      this.toast.show('success', 'Security policies saved', res.changes + ' change' + (res.changes === 1 ? '' : 's'));
      await this.loadLog();
    } catch (e) { this.fail('Security policies not saved', e); }
  }
}

/** Route guard: `data.perm` is one permission, or a list of which any one is enough. */
export const permGuard: CanActivateFn = (route) => {
  const perm = route.data?.['perm'] as string | string[] | undefined;
  if (!perm) return true;
  const rbac = inject(RbacService);
  const perms = Array.isArray(perm) ? perm : [perm];
  if (rbac.canAny(perms)) return true;
  return inject(Router).createUrlTree(['/denied'], { queryParams: { perm: perms[0] } });
};
