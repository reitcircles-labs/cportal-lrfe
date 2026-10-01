import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive } from '@angular/router';
import { AppUser, PERMS, PERM_GROUPS, Policies, RbacService, SodRule, UserStatus, AccessKind } from '../../state/rbac.service';
import { ConfirmService } from '../../state/confirm.service';
import { ToastService } from '../../state/toast.service';
import { IconComponent } from '../../shared/icon.component';

type Tab = 'users' | 'roles' | 'policies' | 'log';
const KIND: Record<AccessKind, [string, string]> = {
  role: ['Role', 'tag-info'], user: ['User', 'tag-neutral'], policy: ['Policy', 'tag-outline'], denied: ['Denied', 'tag-danger'], session: ['Session', 'tag-neutral']
};
const OFFICES = ['Deeds Registry · Windhoek', 'Registry floor 2', 'Review desk', 'Records desk', 'Keetmanshoop sub-registry', 'Office of the Auditor-General', 'ICT · Deeds Registry'];

@Component({
    selector: 'app-admin',
    imports: [IconComponent, RouterLink, RouterLinkActive],
    template: `
    <div class="page stack" style="gap:20px">
      <nav class="tabs" aria-label="Administration">
        @for (t of visibleTabs(); track t.id) { <a [routerLink]="t.path" routerLinkActive="on">{{ t.label }}</a> }
      </nav>

      <!-- ================= USERS ================= -->
      @if (tab() === 'users') {
        <section class="stats">
          @for (s of stats(); track s.label) {
            <div class="panel stat"><span class="sl">{{ s.label }}</span><b class="num" [class.warn]="s.warn">{{ s.v }}</b><span class="small muted">{{ s.sub }}</span></div>
          }
        </section>
        <section class="panel">
          <div class="toolbar">
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Name, email or office" [value]="uq()" (input)="uq.set($any($event.target).value)" aria-label="Search users"></div>
            <select class="input" style="width:auto;min-width:200px" [value]="uRole()" (change)="uRole.set($any($event.target).value)" aria-label="Filter by role">
              <option value="all">All roles</option>
              @for (r of rbac.roles(); track r.id) { <option [value]="r.id">{{ r.label }}</option> }
            </select>
            <div class="seg">
              @for (s of statusOpts; track s) { <label class="seg-opt"><input type="radio" name="us" [checked]="uStatus() === s" (change)="uStatus.set(s)">{{ s === 'all' ? 'All' : s }}</label> }
            </div>
            <span class="spacer"></span>
            <button class="btn btn-primary" (click)="openInvite()"><span style="font-size:18px;line-height:0">+</span>Invite user</button>
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
                    <td class="small">{{ u.office }}</td>
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
      }

      <!-- ================= ROLES ================= -->
      @if (tab() === 'roles') {
        <section class="roles">
          @for (r of roleCards(); track r.id) {
            <button class="panel rcard" [class.on]="selRole() === r.id" (click)="selRole.set(selRole() === r.id ? null : r.id)">
              <span class="row" style="justify-content:space-between;gap:6px;flex-wrap:nowrap"><b>{{ r.label }}</b><span class="tag" [class.tag-neutral]="r.system" [class.tag-info]="!r.system">{{ r.system ? 'System' : 'Custom' }}</span></span>
              <span class="small muted rdesc">{{ r.desc }}</span>
              <span class="row small" style="gap:12px;margin-top:auto"><span><b class="num">{{ r.users }}</b> users</span><span><b class="num">{{ r.n }}</b> / {{ perms.length }} permissions</span>
                @if (r.conflict) { <span style="color:var(--danger)" title="This role breaks a segregation-of-duties rule"><app-icon name="alert" [size]="14" /></span> }</span>
            </button>
          }
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="stack" style="gap:2px"><h3>Permission matrix</h3><span class="small muted">Tick to grant. Changes apply to every user holding the role once saved. Highlighted cells break a segregation-of-duties rule.</span></div>
          </div>
          <div style="overflow-x:auto">
            <table class="matrix">
              <thead><tr><th class="pcol">Permission</th>
                @for (r of rbac.roles(); track r.id) { <th [class.hl]="selRole() === r.id" (click)="selRole.set(r.id)"><span>{{ r.label }}</span>@if (colConflict(r.id)) { <i class="cf" title="Conflict">!</i> }</th> }
              </tr></thead>
              <tbody>
                @for (g of groups; track g.name) {
                  <tr class="grp"><td [attr.colspan]="rbac.roles().length + 1">{{ g.name }}</td></tr>
                  @for (p of g.perms; track p.id) {
                    <tr>
                      <td class="pcol"><b>{{ p.label }}</b><span>{{ p.desc }}</span></td>
                      @for (r of rbac.roles(); track r.id) {
                        <td class="cell" [class.hl]="selRole() === r.id" [class.bad]="cellConflict(r.id, p.id)">
                          <input type="checkbox" class="cbx" [checked]="has(r.id, p.id)" [disabled]="locked(r.id, p.id)" (change)="toggle(r.id, p.id)" [attr.aria-label]="r.label + ': ' + p.label" [title]="locked(r.id, p.id) ? 'Locked to prevent administrator lock-out' : ''">
                        </td>
                      }
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </section>
        @if (changes()) {
          <div class="savebar"><app-icon name="info" [size]="18" /><span><b>{{ changes() }}</b> unsaved permission change{{ changes() === 1 ? '' : 's' }}</span><span class="spacer"></span>
            <button class="btn btn-secondary" (click)="draft.set(null)">Discard</button><button class="btn btn-primary" (click)="saveMatrix()">Save changes</button></div>
        }
      }

      <!-- ================= POLICIES ================= -->
      @if (tab() === 'policies') {
        <section class="pgrid">
          <div class="panel">
            <div class="panel-head"><h3>Authentication</h3></div>
            <div class="panel-body stack" style="gap:0">
              <label class="prow"><span><b>Require multi-factor authentication</b><span>All users must enrol an authenticator app or security key.</span></span><input type="checkbox" class="switch" [checked]="wp().mfa" (change)="setPol('mfa', $any($event.target).checked)"></label>
              <label class="prow"><span><b>Allow sign-in with national eID</b><span>Uses the national identity service as a second factor.</span></span><input type="checkbox" class="switch" [checked]="wp().eid" (change)="setPol('eid', $any($event.target).checked)"></label>
              <label class="prow"><span><b>Restrict to government network</b><span>Block sign-in from outside the GRN network and VPN.</span></span><input type="checkbox" class="switch" [checked]="wp().ipAllow" (change)="setPol('ipAllow', $any($event.target).checked)"></label>
              <div class="prow"><span><b>Idle session timeout</b><span>Users are signed out after this long without activity.</span></span>
                <div class="seg">@for (m of [15, 30, 60]; track m) { <label class="seg-opt"><input type="radio" name="to" [checked]="wp().timeout === m" (change)="setPol('timeout', m)">{{ m }} min</label> }</div></div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head"><h3>Record controls</h3></div>
            <div class="panel-body stack" style="gap:0">
              <label class="prow"><span><b>Four-eyes finalization</b><span>The officer who finalizes a land record must differ from the reviewer who filed its documents.</span></span><input type="checkbox" class="switch" [checked]="wp().fourEyes" (change)="setPol('fourEyes', $any($event.target).checked)"></label>
              <div class="prow"><span><b>Audit trail retention</b><span>Permanent, under the Archives Act. Cannot be changed.</span></span><span class="tag tag-neutral"><app-icon name="lock" [size]="12" />Permanent</span></div>
            </div>
          </div>
          <div class="panel wide">
            <div class="panel-head"><div class="stack" style="gap:2px"><h3>Segregation of duties</h3><span class="small muted">Pairs of permissions no single user may hold together. Enabled rules are flagged on users and roles.</span></div></div>
            <div class="panel-body stack" style="gap:0">
              @for (s of ws(); track s.id) {
                <label class="prow">
                  <span><b>{{ s.label }}</b><span class="row" style="gap:6px;margin-top:4px"><span class="tag tag-neutral">{{ rbac.permLabel(s.a) }}</span>×<span class="tag tag-neutral">{{ rbac.permLabel(s.b) }}</span>
                    @if (affected(s); as n) { <span class="tag" [class.tag-danger]="s.on" [class.tag-neutral]="!s.on">{{ n }} user{{ n === 1 ? '' : 's' }} affected</span> }</span></span>
                  <input type="checkbox" class="switch" [checked]="s.on" (change)="setSod(s.id, $any($event.target).checked)">
                </label>
              }
            </div>
          </div>
        </section>
        @if (polDirty()) {
          <div class="savebar"><app-icon name="info" [size]="18" /><span>Unsaved policy changes</span><span class="spacer"></span>
            <button class="btn btn-secondary" (click)="pol.set(null); sod.set(null)">Discard</button><button class="btn btn-primary" (click)="savePolicies()">Save policies</button></div>
        }
      }

      <!-- ================= ACCESS LOG ================= -->
      @if (tab() === 'log') {
        <section class="panel">
          <div class="toolbar">
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Actor, target or detail" [value]="lq()" (input)="lq.set($any($event.target).value)" aria-label="Search access log"></div>
            <div class="seg">@for (k of kinds; track k.id) { <label class="seg-opt"><input type="radio" name="lk" [checked]="lk() === k.id" (change)="lk.set(k.id)">{{ k.label }}</label> }</div>
            <span class="spacer"></span><span class="small muted">{{ logRows().length }} events</span>
          </div>
          <div style="overflow-x:auto">
            <table class="table" style="min-width:820px">
              <thead><tr><th>Time</th><th>Actor</th><th>Event</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                @for (e of logRows(); track $index) {
                  <tr><td class="num small" style="white-space:nowrap">{{ e.time }}</td><td>{{ e.actor }}</td><td><span class="tag" [class]="'tag ' + kindTag(e.kind)">{{ kindLabel(e.kind) }}</span></td><td style="font-weight:600">{{ e.action }}</td><td>{{ e.target }}</td><td class="small" style="color:var(--color-neutral-800)">{{ e.detail }}</td></tr>
                } @empty { <tr><td colspan="6" class="muted" style="text-align:center;padding:32px">No events match.</td></tr> }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>

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
          <div class="kv"><span>Status</span><span><span class="tag" [class]="'tag ' + statusTag(u.status)">{{ u.status }}</span></span><span>Office</span><span>{{ u.office }}</span><span>MFA</span><span>{{ u.mfa ? 'Enrolled' : 'Not enrolled' }}</span><span>Last active</span><span>{{ u.lastActive }}</span></div>

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
          <div class="dialog-body">You get an activation link to send them. They set a password and enrol MFA. Invitations expire after 3 days.</div>
          <div class="fg">
            <div class="field"><label>Full name</label><input class="input" [value]="inv().name" (input)="setInv('name', $any($event.target).value)" required></div>
            <div class="field"><label>Work email</label><input class="input" type="email" placeholder="name@deeds.gov.na" [value]="inv().email" (input)="setInv('email', $any($event.target).value)" required></div>
            <div class="field" style="grid-column:1/-1"><label>Office</label><select class="input" [value]="inv().office" (change)="setInv('office', $any($event.target).value)">@for (o of offices; track o) { <option>{{ o }}</option> }</select></div>
            <div class="field" style="grid-column:1/-1"><label>Role</label><select class="input" [value]="inv().role" (change)="setInv('role', $any($event.target).value)">@for (r of rbac.roles(); track r.id) { <option [value]="r.id">{{ r.label }}</option> }</select></div>
          </div>
          <div class="dialog-actions"><button type="button" class="btn btn-secondary" (click)="inviteOpen.set(false)">Cancel</button><button type="submit" class="btn btn-primary" [disabled]="inviting() || !inv().name.trim() || !inv().email.includes('@')">{{ inviting() ? 'Creating…' : 'Create invitation' }}</button></div>
        </form>
      </div>
    }

    <!-- Activation link (no email service yet: the administrator passes it on) -->
    @if (rbac.lastInviteLink(); as l) {
      <div class="dialog-backdrop" (click)="rbac.lastInviteLink.set(null)">
        <div class="dialog" style="width:min(560px,100%)" (click)="$event.stopPropagation()">
          <div class="dialog-title">Activation link for {{ l.name }}</div>
          <div class="dialog-body">Email is not connected yet. Send this link to <b>{{ l.email }}</b>. It works once and expires in 3 days; they choose a password and set up an authenticator app.</div>
          <input class="input mono" style="font-size:12.5px;margin:12px 0" readonly [value]="l.url" (focus)="$any($event.target).select()">
          <div class="dialog-actions"><button class="btn btn-secondary" (click)="copy(l.url)">Copy link</button><button class="btn btn-primary" (click)="rbac.lastInviteLink.set(null)">Done</button></div>
        </div>
      </div>
    }
  `,
    changeDetection: ChangeDetectionStrategy.Eager,
    styles: [`
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-divider); flex-wrap: wrap; }
    .tabs a { padding: 10px 14px; font-weight: 600; font-size: 14px; color: var(--color-neutral-700); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tabs a:hover { color: var(--color-text); }
    .tabs a.on { color: var(--color-accent-600); border-bottom-color: var(--color-accent); }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
    .stat { padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
    .stat .sl { font-size: 12.5px; color: var(--color-neutral-700); font-weight: 500; }
    .stat b { font-size: 26px; font-weight: 800; letter-spacing: -.02em; line-height: 1.2; }
    .stat b.warn { color: var(--danger); }
    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid var(--color-divider); }
    .search { position: relative; width: min(300px, 100%); }
    .search app-icon { position: absolute; left: 11px; top: 12px; color: var(--color-neutral-500); }
    .search .input { padding-left: 34px; }
    .foot { padding: 10px 16px; border-top: 1px solid var(--color-divider); }
    tr.click { cursor: pointer; }
    .who { display: flex; gap: 10px; align-items: center; }
    .av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--color-accent-500); color: #fff; }
    .av.lg { width: 44px; height: 44px; font-size: 15px; }
    .ok { color: var(--success); display: inline-flex; }
    .danger { color: var(--danger) !important; }
    .roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .rcard { text-align: left; padding: 14px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; min-height: 128px; border-top: 3px solid var(--color-divider) !important; transition: border-color .15s, box-shadow .15s; }
    .rcard:hover { box-shadow: var(--shadow-md); }
    .rcard.on { border-color: var(--color-accent-300) !important; border-top-color: var(--color-accent) !important; background: var(--color-accent-100); }
    .rcard.add { align-items: center; justify-content: center; text-align: center; border-style: dashed !important; color: var(--color-accent-600); box-shadow: none; }
    .rdesc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .matrix { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13.5px; min-width: 900px; }
    .matrix th { position: sticky; top: 0; background: var(--color-surface-2); padding: 10px 8px; font-size: 12px; font-weight: 700; color: var(--color-neutral-800); border-bottom: 1px solid var(--color-divider); text-align: center; vertical-align: bottom; cursor: pointer; min-width: 104px; }
    .matrix th span { display: block; line-height: 1.3; }
    .matrix th.pcol, .matrix td.pcol { text-align: left; min-width: 280px; cursor: default; padding-left: 18px; }
    .matrix td { padding: 9px 8px; border-bottom: 1px solid var(--color-divider); }
    .matrix td.pcol b { display: block; font-weight: 600; }
    .matrix td.pcol span { font-size: 12px; color: var(--color-neutral-600); }
    .matrix .cell { text-align: center; }
    .matrix .hl { background: var(--color-accent-100); }
    .matrix .bad { background: var(--danger-bg); }
    .matrix .grp td { background: var(--color-surface-2); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-neutral-700); padding: 8px 18px; }
    .matrix tbody tr:not(.grp):hover td { background: var(--color-neutral-100); }
    .cf { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--danger); color: #fff; font-style: normal; font-size: 10px; margin-top: 4px; }
    .savebar { position: sticky; bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: var(--radius-lg); background: var(--sidebar-bg); color: #fff; box-shadow: var(--shadow-lg); flex-wrap: wrap; }
    .savebar .btn-secondary { background: transparent; color: #fff; border-color: rgba(255,255,255,.3); }
    .pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 20px; align-items: start; }
    .pgrid .wide { grid-column: 1 / -1; }
    .prow { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 0; border-bottom: 1px solid var(--color-divider); cursor: pointer; }
    .prow:last-child { border-bottom: 0; }
    .prow > span:first-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .prow > span:first-child > span { font-size: 13px; color: var(--color-neutral-700); }
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
    .fg { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
    @media (max-width: 640px) { .fg { grid-template-columns: 1fr; } .toolbar .seg { overflow-x: auto; max-width: 100%; } }
  `]
})
export class AdminComponent {
  rbac = inject(RbacService);
  private confirm = inject(ConfirmService);
  private toast = inject(ToastService);
  tab = signal<Tab>('users');
  perms = PERMS;
  offices = OFFICES;
  groups = PERM_GROUPS.map(name => ({ name, perms: PERMS.filter(p => p.group === name) }));
  tabs = [
    { id: 'users', label: 'Users', path: '/admin/users', perm: 'admin.users' },
    { id: 'roles', label: 'Roles & permissions', path: '/admin/roles', perm: 'admin.roles' },
    { id: 'policies', label: 'Security policies', path: '/admin/policies', perm: 'admin.policies' },
    { id: 'log', label: 'Access log', path: '/admin/log', perm: 'admin.users' }
  ];
  visibleTabs = computed(() => this.tabs.filter(t => this.rbac.can(t.perm)));
  constructor() {
    inject(ActivatedRoute).data.subscribe(d => {
      this.tab.set(d['tab'] || 'users');
      this.rbac.loadAdmin();
    });
  }
  async copy(text: string) {
    try { await navigator.clipboard.writeText(text); this.toast.show('success', 'Link copied'); } catch { this.toast.show('warn', 'Copy failed', 'Select the link and copy it manually.'); }
  }

  initials(n: string) { return n.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase(); }
  statusTag(s: UserStatus) { return s === 'Active' ? 'tag-accent' : s === 'Suspended' ? 'tag-danger' : 'tag-outline'; }

  // ---------- users ----------
  statusOpts: ('all' | UserStatus)[] = ['all', 'Active', 'Invited', 'Suspended'];
  uq = signal(''); uRole = signal('all'); uStatus = signal<'all' | UserStatus>('all');
  users = computed(() => {
    const q = this.uq().toLowerCase().trim(), r = this.uRole(), s = this.uStatus();
    return this.rbac.users()
      .filter(u => (r === 'all' || u.roles.includes(r)) && (s === 'all' || u.status === s) && (!q || (u.name + ' ' + u.email + ' ' + u.office).toLowerCase().includes(q)))
      .map(u => ({ ...u, conflicts: this.rbac.userConflicts(u).length }));
  });
  stats = computed(() => {
    const us = this.rbac.users(), active = us.filter(u => u.status === 'Active'), noMfa = active.filter(u => !u.mfa).length;
    const conf = us.filter(u => u.status !== 'Suspended' && this.rbac.userConflicts(u).length).length;
    return [
      { label: 'Active users', v: String(active.length), sub: us.length + ' accounts in total', warn: false },
      { label: 'Pending invitations', v: String(us.filter(u => u.status === 'Invited').length), sub: 'Expire after 3 days', warn: false },
      { label: 'Suspended', v: String(us.filter(u => u.status === 'Suspended').length), sub: 'Sign-in blocked', warn: false },
      { label: 'MFA enrolled', v: Math.round((active.length - noMfa) / Math.max(1, active.length) * 100) + '%', sub: noMfa + ' active user' + (noMfa === 1 ? '' : 's') + ' without MFA', warn: this.rbac.policies().mfa && noMfa > 0 },
      { label: 'Duty conflicts', v: String(conf), sub: 'Users breaking a segregation rule', warn: conf > 0 }
    ];
  });
  editId = signal<string | null>(null);
  draftRoles = signal<string[]>([]);
  editUser = computed(() => this.rbac.users().find(u => u.id === this.editId()) || null);
  draftPerms = computed(() => this.rbac.effective(this.draftRoles()));
  draftConflicts = computed(() => this.rbac.conflicts(this.draftPerms()));
  draftGroups = computed(() => this.groups.map(g => { const ps = g.perms.map(p => ({ ...p, on: this.draftPerms().includes(p.id) })); return { name: g.name, perms: ps, n: ps.filter(p => p.on).length }; }));
  userDirty = computed(() => { const u = this.editUser(); return !!u && [...u.roles].sort().join() !== [...this.draftRoles()].sort().join(); });
  openUser(id: string) { const u = this.rbac.users().find(x => x.id === id)!; this.draftRoles.set([...u.roles]); this.editId.set(id); }
  toggleDraftRole(id: string) { this.draftRoles.update(r => r.includes(id) ? r.filter(x => x !== id) : [...r, id]); }
  async saveUser() {
    const u = this.editUser()!;
    if (this.draftConflicts().length && !(await this.confirm.ask({ title: 'Save with a duty conflict?', body: u.name + ' would hold permissions that an enabled segregation-of-duties rule keeps apart. The exception is recorded in the access log.', confirmLabel: 'Save anyway', tone: 'danger' }))) return;
    this.rbac.saveUserRoles(u.id, this.draftRoles());
    this.editId.set(null);
  }
  async toggleSuspend(u: AppUser) {
    const suspend = u.status !== 'Suspended';
    if (await this.confirm.ask({ title: (suspend ? 'Suspend ' : 'Reactivate ') + u.name + '?', body: suspend ? 'Active sessions end immediately and sign-in is blocked. Their work and audit history are kept.' : 'The user can sign in again with their existing roles.', confirmLabel: suspend ? 'Suspend user' : 'Reactivate', tone: suspend ? 'danger' : 'primary' }))
      this.rbac.setStatus(u.id, suspend ? 'Suspended' : 'Active');
  }
  async resetMfa(u: AppUser) {
    if (await this.confirm.ask({ title: 'Reset MFA for ' + u.name + '?', body: 'Their current authenticator stops working. They must enrol a new one at next sign-in.', confirmLabel: 'Reset MFA', tone: 'danger' })) this.rbac.resetMfa(u.id);
  }
  inviteOpen = signal(false);
  inv = signal({ name: '', email: '', office: 'Review desk', role: 'rev' });
  openInvite() { this.inv.set({ name: '', email: '', office: 'Review desk', role: 'rev' }); this.inviteOpen.set(true); }
  setInv(k: string, v: string) { this.inv.update(i => ({ ...i, [k]: v })); }
  inviting = signal(false);
  async invite() {
    const i = this.inv(); if (!i.name.trim() || !i.email.includes('@')) return;
    this.inviting.set(true);
    const ok = await this.rbac.invite({ name: i.name.trim(), email: i.email.trim(), office: i.office, roles: [i.role] });
    this.inviting.set(false);
    if (ok) this.inviteOpen.set(false);
  }

  // ---------- roles ----------
  selRole = signal<string | null>(null);
  draft = signal<Record<string, string[]> | null>(null);
  working = computed<Record<string, string[]>>(() => this.draft() ?? Object.fromEntries(this.rbac.roles().map(r => [r.id, r.perms])));
  has(r: string, p: string) { return (this.working()[r] || []).includes(p); }
  locked(r: string, p: string) { return r === 'adm' && (p === 'admin.roles' || p === 'admin.users'); }
  toggle(r: string, p: string) {
    if (this.locked(r, p)) return;
    const w = { ...this.working() }, cur = w[r] || [];
    w[r] = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p];
    this.draft.set(w);
  }
  colConflict(r: string) { return this.rbac.conflicts(this.working()[r] || []).length > 0; }
  cellConflict(r: string, p: string) { return this.has(r, p) && this.rbac.conflicts(this.working()[r] || []).some(c => c.a === p || c.b === p); }
  changes = computed(() => {
    const d = this.draft(); if (!d) return 0;
    let n = 0;
    this.rbac.roles().forEach(r => PERMS.forEach(p => { if (r.perms.includes(p.id) !== (d[r.id] || []).includes(p.id)) n++; }));
    return n;
  });
  roleCards = computed(() => this.rbac.roles().map(r => ({ ...r, users: this.rbac.users().filter(u => u.roles.includes(r.id)).length, n: (this.working()[r.id] || []).length, conflict: this.colConflict(r.id) })));
  async saveMatrix() {
    const d = this.draft()!;
    const affected = this.rbac.users().filter(u => u.roles.some(r => this.rbac.roles().find(x => x.id === r)?.perms.join() !== (d[r] || []).join())).length;
    if (await this.confirm.ask({ title: 'Apply ' + this.changes() + ' permission change' + (this.changes() === 1 ? '' : 's') + '?', body: 'This affects ' + affected + ' user' + (affected === 1 ? '' : 's') + ', at their next token refresh (within 15 minutes). Each change is written to the access log.', confirmLabel: 'Save changes' })) {
      await this.rbac.saveMatrix(d); this.draft.set(null);
    }
  }

  // ---------- policies ----------
  pol = signal<Policies | null>(null);
  sod = signal<SodRule[] | null>(null);
  wp = computed(() => this.pol() ?? this.rbac.policies());
  ws = computed(() => this.sod() ?? this.rbac.sod());
  polDirty = computed(() => !!this.pol() || !!this.sod());
  setPol(k: keyof Policies, v: any) { this.pol.set({ ...this.wp(), [k]: v }); }
  setSod(id: string, on: boolean) { this.sod.set(this.ws().map(s => s.id === id ? { ...s, on } : s)); }
  affected(s: SodRule) { return this.rbac.users().filter(u => u.status !== 'Suspended' && this.rbac.conflicts(this.rbac.effective(u.roles), [{ ...s, on: true }]).length).length; }
  async savePolicies() {
    if (await this.confirm.ask({ title: 'Save security policies?', body: 'Authentication changes apply at each user’s next sign-in. Segregation rules apply immediately.', confirmLabel: 'Save policies' })) {
      this.rbac.savePolicies(this.wp(), this.ws()); this.pol.set(null); this.sod.set(null);
    }
  }

  // ---------- log ----------
  kinds: { id: 'all' | AccessKind; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'role', label: 'Roles' }, { id: 'user', label: 'Users' }, { id: 'policy', label: 'Policies' }, { id: 'denied', label: 'Denied' }, { id: 'session', label: 'Sign-ins' }];
  lq = signal(''); lk = signal<'all' | AccessKind>('all');
  logRows = computed(() => { const q = this.lq().toLowerCase().trim(), k = this.lk(); return this.rbac.log().filter(e => (k === 'all' || e.kind === k) && (!q || (e.actor + ' ' + e.target + ' ' + e.detail + ' ' + e.action).toLowerCase().includes(q))); });
  kindTag(k: AccessKind) { return KIND[k][1]; }
  kindLabel(k: AccessKind) { return KIND[k][0]; }
}
