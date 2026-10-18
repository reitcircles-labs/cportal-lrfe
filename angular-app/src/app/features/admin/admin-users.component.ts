import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {
  AppUser,
  PERMS,
  PERM_GROUPS,
  RbacService,
  UserStatus,
  NATIONAL_ROLES,
} from '../../state/rbac.service';
import {ConfirmService} from '../../state/confirm.service';
import {IconComponent} from '../../shared/icon.component';
import {ADMIN_SHARED_STYLES} from './admin-shared.styles';

/** Administration, Users tab: the user list, the manage-user drawer and the invite dialog. */
@Component({
  selector: 'app-admin-users',
  imports: [IconComponent, RouterLink],
  template: `
    <section class="stats">
      @for (s of stats(); track s.label) {
        <div class="panel stat"><span class="sl">{{ s.label }}</span><b class="num" [class.warn]="s.warn">{{ s.v }}</b><span class="small muted">{{ s.sub }}</span></div>
      }
    </section>
    <section class="panel">
      <div class="toolbar">
        <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Name, email or office" [value]="uq()" (input)="uq.set($any($event.target).value)" aria-label="Search users"></div>
        <select class="input" style="width:auto;min-width:200px" (change)="uRole.set($any($event.target).value)" aria-label="Filter by role">
          <option value="all" [selected]="uRole() === 'all'">All roles</option>
          @for (r of rbac.roles(); track r.id) { <option [value]="r.id" [selected]="r.id === uRole()">{{ r.label }}</option> }
        </select>
        <select class="input" style="width:auto;min-width:180px" (change)="uOffice.set($any($event.target).value)" aria-label="Filter by office">
          <option value="all" [selected]="uOffice() === 'all'">All offices</option>
          @for (o of rbac.offices(); track o.id) { <option [value]="o.id" [selected]="o.id === uOffice()">{{ o.code }} · {{ o.name }}</option> }
          <option value="none" [selected]="uOffice() === 'none'">No office / national</option>
        </select>
        <div class="seg">
          @for (s of statusOpts; track s) { <label class="seg-opt"><input type="radio" name="us" [checked]="uStatus() === s" (change)="uStatus.set(s)">{{ s === 'all' ? 'All' : s }}</label> }
        </div>
        <span class="spacer"></span>
        @if (!rbac.activeOffices().length) {
          <span class="small muted">Add an office first @if (rbac.can('admin.offices')) { · <a routerLink="/admin/offices">Offices</a> }</span>
        }
        <button class="btn btn-primary" [disabled]="!rbac.activeOffices().length" [title]="rbac.activeOffices().length ? '' : 'Users are invited into an office: add an office first'" (click)="openInvite()"><span style="font-size:18px;line-height:0">+</span>Invite user</button>
      </div>
      <div style="overflow-x:auto">
        <table class="table">
          <thead><tr><th>User</th><th>Roles</th><th>Office</th><th>Status</th><th>MFA</th><th>Last active</th><th></th></tr></thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr class="click" (click)="openUser(u.id)">
                <td><div class="who"><span class="av">{{ initials(u.name) }}</span><span class="stack" style="gap:0;min-width:0"><b>{{ u.name }}</b><span class="small muted">{{ u.email }}</span></span></div></td>
                <td><div class="row" style="gap:4px">@for (r of u.roles; track r) { <span class="tag tag-info">{{ rbac.roleLabel(r) }}</span> }
                  @if (u.conflicts) { <span class="tag tag-danger" title="Breaks a segregation-of-duties rule"><app-icon name="alert" [size]="12" />Conflict</span> }</div></td>
                <td class="small">@if (u.office) { <span class="num muted">{{ u.officeCode }}</span> {{ u.office }} } @else { <span class="muted">{{ isNational(u.roles) ? 'National' : 'No office' }}</span> }</td>
                <td><span class="tag" [class]="'tag ' + statusTag(u.status)">{{ u.status }}</span></td>
                <td>@if (u.mfa) { <span class="ok"><app-icon name="check" [size]="16" /></span> } @else { <span class="small" style="color:var(--warn-fg)">Not enrolled</span> }</td>
                <td class="small muted num" style="white-space:nowrap">{{ u.lastActive }}</td>
                <td style="text-align:right"><button class="btn btn-secondary" style="min-height:32px" (click)="$event.stopPropagation(); openUser(u.id)">Manage</button></td>
              </tr>
            } @empty { <tr><td colspan="7" class="muted" style="text-align:center;padding:32px">No users match.</td></tr> }
          </tbody>
        </table>
      </div>
      <div class="foot small muted">{{ users().length }} of {{ rbac.users().length }} users</div>
    </section>

    <!-- User drawer -->
    @if (editUser(); as u) {
      <div class="drawer-bg" (click)="editId.set(null)"></div>
      <aside class="drawer" role="dialog" aria-modal="true" [attr.aria-label]="'Manage ' + u.name">
        <header class="dh">
          <span class="av lg">{{ initials(u.name) }}</span>
          <div class="stack" style="gap:2px;min-width:0"><h3 style="margin:0">{{ u.name }}</h3><span class="small muted">{{ u.email }}</span></div>
          <button class="btn btn-ghost btn-icon" style="margin-left:auto" (click)="editId.set(null)" aria-label="Close"><app-icon name="x" [size]="18" /></button>
        </header>
        <div class="db">
          <div class="kv"><span>Status</span><span><span class="tag" [class]="'tag ' + statusTag(u.status)">{{ u.status }}</span></span><span>Office</span><span>{{ u.office || (isNational(u.roles) ? 'National (no office)' : 'No office') }}</span><span>MFA</span><span>{{ u.mfa ? 'Enrolled' : 'Not enrolled' }}</span><span>Last active</span><span>{{ u.lastActive }}</span></div>

          <div class="stack" style="gap:8px">
            <h4 style="margin:0">Office</h4>
            <div class="row" style="gap:8px;flex-wrap:nowrap">
              <select class="input" (change)="draftOffice.set($any($event.target).value)" aria-label="Office">
                @if (!u.officeId && !isNational(u.roles)) { <option value="" [selected]="!draftOffice()">No office: choose one</option> }
                @if (isNational(u.roles)) { <option value="" [selected]="!draftOffice()">National (no office)</option> }
                @for (o of officeChoices(u); track o.id) { <option [value]="o.id" [selected]="o.id === draftOffice()">{{ o.code }} · {{ o.name }}{{ o.status === 'Suspended' ? ' (suspended)' : '' }}</option> }
              </select>
              <button class="btn btn-secondary" [disabled]="draftOffice() === (u.officeId || '') || (!draftOffice() && !isNational(u.roles))" (click)="saveOffice(u)">Change office</button>
            </div>
          </div>

          <div class="stack" style="gap:8px">
            <h4 style="margin:0">Roles</h4>
            @for (r of rbac.roles(); track r.id) {
              <label class="rpick" [class.on]="draftRoles().includes(r.id)">
                <input type="checkbox" class="cbx" [checked]="draftRoles().includes(r.id)" (change)="toggleDraftRole(r.id)">
                <span class="stack" style="gap:1px;min-width:0"><b>{{ r.label }}</b><span class="small muted">{{ r.desc }}</span></span>
                <span class="small muted num">{{ r.perms.length }}</span>
              </label>
            }
          </div>

          @if (draftConflicts().length) {
            <div class="alert"><app-icon name="alert" [size]="18" /><div class="stack" style="gap:4px"><b>Segregation-of-duties conflict</b>
              @for (c of draftConflicts(); track c.id) { <span class="small">{{ c.label }} ({{ rbac.permLabel(c.a) }} × {{ rbac.permLabel(c.b) }})</span> }</div></div>
          }

          <div class="stack" style="gap:10px">
            <div class="row" style="justify-content:space-between"><h4 style="margin:0">Effective permissions</h4><span class="small muted">{{ draftPerms().length }} of {{ perms.length }}</span></div>
            @for (g of draftGroups(); track g.name) {
              <div class="eg">
                <span class="row small" style="justify-content:space-between"><b>{{ g.name }}</b><span class="muted num">{{ g.n }}/{{ g.perms.length }}</span></span>
                <div class="row" style="gap:4px">@for (p of g.perms; track p.id) { <span class="pchip" [class.on]="p.on">{{ p.label }}</span> }</div>
              </div>
            }
          </div>
        </div>
        <footer class="df">
          @if (u.status === 'Invited') { <button class="btn btn-secondary" (click)="rbac.resendInvite(u.id)">Resend invite</button> }
          @else {
            <button class="btn btn-secondary" [class.danger]="u.status === 'Active'" (click)="toggleSuspend(u)">{{ u.status === 'Suspended' ? 'Reactivate' : 'Suspend' }}</button>
            <button class="btn btn-ghost" [disabled]="!u.mfa" (click)="resetMfa(u)">Reset MFA</button>
          }
          <span class="spacer"></span>
          <button class="btn btn-secondary" (click)="editId.set(null)">Cancel</button>
          <button class="btn btn-primary" [disabled]="!userDirty() || !draftRoles().length" (click)="saveUser()">Save roles</button>
        </footer>
      </aside>
    }

    <!-- Invite -->
    @if (inviteOpen()) {
      <div class="dialog-backdrop" (click)="inviteOpen.set(false)">
        <form class="dialog" style="width:min(520px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); invite()">
          <div class="dialog-title">Invite a user</div>
          <div class="dialog-body">They get an email with an activation link, set a password and set up an authenticator app. The link expires after 3 days.</div>
          <div class="fg">
            <div class="field"><label>Full name</label><input class="input" [value]="inv().name" (input)="setInv('name', $any($event.target).value)" required></div>
            <div class="field"><label>Work email</label><input class="input" type="email" placeholder="name@example.org" [value]="inv().email" (input)="setInv('email', $any($event.target).value)" required></div>
            <div class="field" style="grid-column:1/-1"><label>Office</label><select class="input" (change)="setInv('officeId', $any($event.target).value)">
              @for (o of rbac.activeOffices(); track o.id) { <option [value]="o.id" [selected]="o.id === inv().officeId">{{ o.code }} · {{ o.name }}</option> }
              @if (isNational([inv().role])) { <option value="" [selected]="!inv().officeId">National (no office)</option> }
            </select></div>
            <div class="field" style="grid-column:1/-1"><label>Role</label><select class="input" (change)="setInv('role', $any($event.target).value)">@for (r of rbac.roles(); track r.id) { <option [value]="r.id" [selected]="r.id === inv().role">{{ r.label }}</option> }</select></div>
          </div>
          <div class="dialog-actions"><button type="button" class="btn btn-secondary" (click)="inviteOpen.set(false)">Cancel</button><button type="submit" class="btn btn-primary" [disabled]="inviting() || !inv().name.trim() || !inv().email.includes('@')">{{ inviting() ? 'Creating…' : 'Create invitation' }}</button></div>
        </form>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    ADMIN_SHARED_STYLES,
    `
    :host { display: contents; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
    .stat { padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
    .stat .sl { font-size: 12.5px; color: var(--color-neutral-700); font-weight: 500; }
    .stat b { font-size: 26px; font-weight: 800; letter-spacing: -.02em; line-height: 1.2; }
    .stat b.warn { color: var(--danger); }
    .who { display: flex; gap: 10px; align-items: center; }
    .av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--color-accent-500); color: #fff; }
    .av.lg { width: 44px; height: 44px; font-size: 15px; }
    .ok { color: var(--success); display: inline-flex; }
    .drawer-bg { position: fixed; inset: 0; background: rgba(7,13,24,.45); z-index: 55; animation: fade .15s; }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); z-index: 56; background: var(--color-surface); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: slide-in .2s ease-out; }
    .dh { display: flex; gap: 12px; align-items: center; padding: 18px 20px; border-bottom: 1px solid var(--color-divider); }
    .db { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 22px; }
    .df { display: flex; gap: 8px; align-items: center; padding: 14px 20px; border-top: 1px solid var(--color-divider); flex-wrap: wrap; }
    .rpick { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border: 1px solid var(--color-divider); border-radius: 10px; cursor: pointer; }
    .rpick:hover { border-color: var(--color-neutral-400); }
    .rpick.on { border-color: var(--color-accent-300); background: var(--color-accent-100); }
    .alert { display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); }
    .eg { display: flex; flex-direction: column; gap: 6px; }
    .pchip { font-size: 12px; padding: 2px 9px; border-radius: 99px; background: var(--color-neutral-200); color: var(--color-neutral-600); text-decoration: line-through; text-decoration-color: var(--color-neutral-400); }
    .pchip.on { background: var(--success-bg); color: var(--success-fg); text-decoration: none; }
  `,
  ],
})
export class AdminUsersComponent {
  rbac = inject(RbacService);
  private confirm = inject(ConfirmService);
  perms = PERMS;
  groups = PERM_GROUPS.map(name => ({
    name,
    perms: PERMS.filter(p => p.group === name),
  }));

  initials(n: string) {
    return n
      .replace(/[^A-Za-z ]/g, '')
      .split(' ')
      .filter(Boolean)
      .map(s => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
  statusTag(s: UserStatus) {
    return s === 'Active'
      ? 'tag-accent'
      : s === 'Suspended'
        ? 'tag-danger'
        : 'tag-outline';
  }

  // ---------- users ----------
  statusOpts: Array<'all' | UserStatus> = [
    'all',
    'Active',
    'Invited',
    'Suspended',
  ];
  uq = signal('');
  uRole = signal('all');
  uStatus = signal<'all' | UserStatus>('all');
  uOffice = signal('all');
  isNational(roles: string[]) {
    return roles.some(r => NATIONAL_ROLES.includes(r));
  }
  users = computed(() => {
    const q = this.uq().toLowerCase().trim();
    const r = this.uRole();
    const s = this.uStatus();
    const o = this.uOffice();
    return this.rbac
      .users()
      .filter(
        u => o === 'all' || (o === 'none' ? !u.officeId : u.officeId === o),
      )
      .filter(
        u =>
          (r === 'all' || u.roles.includes(r)) &&
          (s === 'all' || u.status === s) &&
          (!q ||
            (
              u.name +
              ' ' +
              u.email +
              ' ' +
              u.office +
              ' ' +
              (u.officeCode || '')
            )
              .toLowerCase()
              .includes(q)),
      )
      .map(u => ({...u, conflicts: this.rbac.userConflicts(u).length}));
  });
  stats = computed(() => {
    const us = this.rbac.users();
    const active = us.filter(u => u.status === 'Active');
    const noMfa = active.filter(u => !u.mfa).length;
    const conf = us.filter(
      u => u.status !== 'Suspended' && this.rbac.userConflicts(u).length,
    ).length;
    return [
      {
        label: 'Active users',
        v: String(active.length),
        sub: us.length + ' accounts in total',
        warn: false,
      },
      {
        label: 'Pending invitations',
        v: String(us.filter(u => u.status === 'Invited').length),
        sub: 'Expire after 3 days',
        warn: false,
      },
      {
        label: 'Suspended',
        v: String(us.filter(u => u.status === 'Suspended').length),
        sub: 'Sign-in blocked',
        warn: false,
      },
      {
        label: 'MFA enrolled',
        v:
          Math.round(
            ((active.length - noMfa) / Math.max(1, active.length)) * 100,
          ) + '%',
        sub: noMfa + ' active user' + (noMfa === 1 ? '' : 's') + ' without MFA',
        warn: this.rbac.policies().mfa && noMfa > 0,
      },
      {
        label: 'Duty conflicts',
        v: String(conf),
        sub: 'Users breaking a segregation rule',
        warn: conf > 0,
      },
    ];
  });
  editId = signal<string | null>(null);
  draftRoles = signal<string[]>([]);
  editUser = computed(
    () => this.rbac.users().find(u => u.id === this.editId()) || null,
  );
  draftPerms = computed(() => this.rbac.effective(this.draftRoles()));
  draftConflicts = computed(() => this.rbac.conflicts(this.draftPerms()));
  draftGroups = computed(() =>
    this.groups.map(g => {
      const ps = g.perms.map(p => ({
        ...p,
        on: this.draftPerms().includes(p.id),
      }));
      return {name: g.name, perms: ps, n: ps.filter(p => p.on).length};
    }),
  );
  userDirty = computed(() => {
    const u = this.editUser();
    return (
      !!u && [...u.roles].sort().join() !== [...this.draftRoles()].sort().join()
    );
  });
  openUser(id: string) {
    const u = this.rbac.users().find(x => x.id === id)!;
    this.draftRoles.set([...u.roles]);
    this.draftOffice.set(u.officeId || '');
    this.editId.set(id);
  }
  draftOffice = signal('');
  /** Active offices, plus the user's current one even if it is suspended (so it shows as selected). */
  officeChoices(u: AppUser) {
    return this.rbac
      .offices()
      .filter(o => o.status === 'Active' || o.id === u.officeId);
  }
  async saveOffice(u: AppUser) {
    await this.rbac.setUserOffice(u.id, this.draftOffice() || null);
  }
  toggleDraftRole(id: string) {
    this.draftRoles.update(r =>
      r.includes(id) ? r.filter(x => x !== id) : [...r, id],
    );
  }
  async saveUser() {
    const u = this.editUser()!;
    if (
      this.draftConflicts().length &&
      !(await this.confirm.ask({
        title: 'Save with a duty conflict?',
        body:
          u.name +
          ' would hold permissions that an enabled segregation-of-duties rule keeps apart. The exception is recorded in the access log.',
        confirmLabel: 'Save anyway',
        tone: 'danger',
      }))
    ) {
      return;
    }
    this.rbac.saveUserRoles(u.id, this.draftRoles());
    this.editId.set(null);
  }
  async toggleSuspend(u: AppUser) {
    const suspend = u.status !== 'Suspended';
    if (
      await this.confirm.ask({
        title: (suspend ? 'Suspend ' : 'Reactivate ') + u.name + '?',
        body: suspend
          ? 'Active sessions end immediately and sign-in is blocked. Their work and audit history are kept.'
          : 'The user can sign in again with their existing roles.',
        confirmLabel: suspend ? 'Suspend user' : 'Reactivate',
        tone: suspend ? 'danger' : 'primary',
      })
    ) {
      this.rbac.setStatus(u.id, suspend ? 'Suspended' : 'Active');
    }
  }
  async resetMfa(u: AppUser) {
    if (
      await this.confirm.ask({
        title: 'Reset MFA for ' + u.name + '?',
        body: 'Their current authenticator stops working. They must enrol a new one at next sign-in.',
        confirmLabel: 'Reset MFA',
        tone: 'danger',
      })
    ) {
      this.rbac.resetMfa(u.id);
    }
  }
  inviteOpen = signal(false);
  inv = signal({name: '', email: '', officeId: '', role: 'rev'});
  openInvite() {
    this.inv.set({
      name: '',
      email: '',
      officeId: this.rbac.activeOffices()[0]?.id ?? '',
      role: 'rev',
    });
    this.inviteOpen.set(true);
  }
  setInv(k: string, v: string) {
    this.inv.update(i => {
      const next = {...i, [k]: v};
      // only administrators may be invited without an office
      if (k === 'role' && !next.officeId && !this.isNational([v])) {
        next.officeId = this.rbac.activeOffices()[0]?.id ?? '';
      }
      return next;
    });
  }
  inviting = signal(false);
  async invite() {
    const i = this.inv();
    if (!i.name.trim() || !i.email.includes('@')) return;
    this.inviting.set(true);
    const ok = await this.rbac.invite({
      name: i.name.trim(),
      email: i.email.trim(),
      officeId: i.officeId || null,
      roles: [i.role],
    });
    this.inviting.set(false);
    if (ok) this.inviteOpen.set(false);
  }
}
