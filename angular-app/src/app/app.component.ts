import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';
import { ViewerComponent } from './shared/viewer.component';
import { OverlaysComponent } from './shared/overlays.component';
import { InboxComponent } from './shared/inbox.component';
import { IconComponent } from './shared/icon.component';
import { AuthService } from './state/auth.service';
import { RbacService } from './state/rbac.service';
import { ThemeService } from './state/theme.service';
import { RegistryStore } from './state/registry.store';
import { IntakeApi } from './api/intake.api';

@Component({
    selector: 'app-root',
    imports: [RouterOutlet, RouterLink, RouterLinkActive, ViewerComponent, OverlaysComponent, IconComponent, InboxComponent],
    template: `
    @if (isLogin()) {
      <router-outlet />
    } @else {
      <div class="app" [class.drawer]="drawer()">
        <aside class="sidebar" aria-label="Main navigation">
          <div class="flag" aria-hidden="true"></div>
          <a routerLink="/" class="brand" (click)="drawer.set(false)">
            <span class="arms" title="Coat of arms placeholder">Coat of<br>arms</span>
            <span class="stack" style="gap:0">
              <b>Deeds Registry</b>
              <span>Republic of Namibia</span>
            </span>
          </a>

          <nav class="nav">
            <span class="sec">Workspace</span>
            @for (n of nav(); track n.path) {
              <a [routerLink]="n.path" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: n.path === '/' }" class="item" (click)="drawer.set(false)">
                <app-icon [name]="n.icon" [size]="18" />
                <span class="lbl">{{ n.label }}</span>
                @if (n.badge) { <span class="badge" [class.mine]="n.mine">{{ n.badge }}</span> }
              </a>
            }
            @if (adminNav().length) {
              <span class="sec">Administration</span>
              @for (n of adminNav(); track n.path) {
                <a [routerLink]="n.path" routerLinkActive="on" class="item" (click)="drawer.set(false)"><app-icon [name]="n.icon" [size]="18" /><span class="lbl">{{ n.label }}</span>@if (n.badge) { <span class="badge warn" title="Users with a duty conflict">{{ n.badge }}</span> }</a>
              }
            }
            @if (rbac.can('dashboard.view')) {
              <span class="sec">Programme</span>
              <a routerLink="/flow" routerLinkActive="on" class="item" (click)="drawer.set(false)"><app-icon name="flow" [size]="18" /><span class="lbl">Process &amp; schema</span></a>
            }
          </nav>

          <div class="foot">
            <div class="role"><span>Signed in as</span><b class="rl">{{ auth.role()?.label }}</b></div>
            <div class="me">
              <span class="av">{{ auth.role()?.initials }}</span>
              <span class="stack" style="gap:0;min-width:0"><b>{{ auth.role()?.name }}</b><span class="ell">{{ auth.role()?.office }}</span></span>
              <button class="ib" (click)="auth.logout()" title="Sign out" aria-label="Sign out"><app-icon name="logout" [size]="17" /></button>
            </div>
          </div>
        </aside>
        <div class="scrim" (click)="drawer.set(false)"></div>

        <div class="main">
          <header class="topbar">
            <button class="btn btn-ghost btn-icon burger" (click)="drawer.set(true)" aria-label="Open navigation"><app-icon name="menu" [size]="20" /></button>
            <div class="stack" style="gap:0;min-width:0">
              <span class="crumb">{{ crumb() }}</span>
              <h1 class="ttl">{{ title() }}</h1>
            </div>
            <span class="spacer"></span>
            <div class="search"><app-icon name="search" [size]="16" /><input class="input" placeholder="Search erf, deed no., owner ID…" aria-label="Search records"></div>
            <button class="btn btn-ghost btn-icon" (click)="theme.toggle()" [title]="theme.theme() === 'dark' ? 'Light mode' : 'Dark mode'" aria-label="Toggle dark mode"><app-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="19" /></button>
            <app-inbox />
            <span class="av sm" [title]="$safeNavigationMigration(auth.role()?.name)">{{ auth.role()?.initials }}</span>
          </header>
          <main class="content"><router-outlet /></main>
          <footer class="small muted foot-note">Sign-in, administration, tasks, capture, verify and Documents use the live services. Dashboard, land records and audit still show demo data (fictitious names and deed references) until the land-records and audit services are connected.</footer>
        </div>
      </div>
    }
    <app-viewer />
    <app-overlays />
  `,
    changeDetection: ChangeDetectionStrategy.Eager,
    styles: [`
    .app { display: grid; grid-template-columns: 264px minmax(0, 1fr); min-height: 100vh; }
    .sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: linear-gradient(180deg, var(--sidebar-bg), var(--sidebar-bg-2)); color: var(--sidebar-fg); z-index: 40; }
    .flag { height: 6px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); }
    .brand { display: flex; align-items: center; gap: 12px; padding: 18px 18px 16px; text-decoration: none; color: var(--sidebar-fg-strong); border-bottom: 1px solid rgba(255,255,255,.08); }
    .brand b { font-size: 16px; letter-spacing: -.01em; }
    .brand span span { font-size: 12px; color: var(--sidebar-fg); }
    .arms { width: 44px; height: 44px; flex: none; border-radius: 10px; border: 1px dashed rgba(255,255,255,.35); display: grid; place-items: center; text-align: center; font-size: 8.5px; line-height: 1.1; color: var(--sidebar-fg); background: rgba(255,206,0,.08); box-shadow: inset 0 0 0 3px rgba(255,206,0,.12); }
    .nav { display: flex; flex-direction: column; gap: 2px; padding: 14px 12px; overflow-y: auto; flex: 1; }
    .sec { font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: rgba(198,212,231,.6); padding: 12px 10px 6px; }
    .item { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 8px; color: var(--sidebar-fg); text-decoration: none; font-weight: 500; font-size: 14px; position: relative; transition: background .15s, color .15s; }
    .item:hover { background: var(--sidebar-active); color: #fff; }
    .item.on { background: rgba(255,255,255,.12); color: #fff; font-weight: 600; }
    .item.on::before { content: ""; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--nam-gold); }
    .lbl { flex: 1; }
    .badge { font-size: 11px; font-weight: 700; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 99px; display: grid; place-items: center; background: rgba(255,255,255,.12); color: #fff; }
    .badge.mine { background: var(--nam-gold); color: #1c1400; }
    .badge.warn { background: var(--nam-red); color: #fff; }
    .foot { padding: 14px 14px 16px; border-top: 1px solid rgba(255,255,255,.08); display: flex; flex-direction: column; gap: 12px; }
    .role { display: flex; flex-direction: column; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgba(198,212,231,.6); }
    .role .rl { font-size: 13.5px; font-weight: 600; letter-spacing: 0; text-transform: none; color: #fff; }
    .role select { appearance: none; font: inherit; font-size: 13.5px; font-weight: 600; letter-spacing: 0; text-transform: none; color: #fff; background: rgba(255,255,255,.08) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23c6d4e7' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 9px 30px 9px 10px; cursor: pointer; }
    .role select option { color: #0e1a2b; }
    .me { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 10px; align-items: center; font-size: 12px; }
    .me b { color: #fff; font-size: 13.5px; }
    .ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .av { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; background: var(--color-accent-500); color: #fff; flex: none; }
    .av.sm { width: 34px; height: 34px; font-size: 12px; }
    .ib { border: 0; background: transparent; color: var(--sidebar-fg); padding: 8px; border-radius: 8px; cursor: pointer; }
    .ib:hover { background: var(--sidebar-active); color: #fff; }
    .scrim { display: none; }
    .main { min-width: 0; display: flex; flex-direction: column; }
    .topbar { position: sticky; top: 0; z-index: 30; height: var(--topbar-h); display: flex; align-items: center; gap: 10px; padding: 0 24px; background: color-mix(in srgb, var(--color-surface) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--color-divider); }
    .crumb { font-size: 12px; color: var(--color-neutral-600); font-weight: 500; }
    .ttl { font-size: 18px; margin: 0; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .search { position: relative; width: min(340px, 30vw); }
    .search app-icon { position: absolute; left: 11px; top: 12px; color: var(--color-neutral-500); }
    .search .input { padding-left: 34px; background: var(--color-surface-2); }
    .bell { position: relative; }
    .bell i { position: absolute; top: 8px; right: 9px; width: 8px; height: 8px; border-radius: 50%; background: var(--nam-red); box-shadow: 0 0 0 2px var(--color-surface); }
    .burger { display: none; }
    .content { flex: 1; }
    .foot-note { padding: 0 28px 20px; }
    @media (max-width: 960px) {
      .app { grid-template-columns: minmax(0, 1fr); }
      .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 280px; transform: translateX(-100%); transition: transform .22s ease; box-shadow: var(--shadow-lg); }
      .app.drawer .sidebar { transform: none; }
      .app.drawer .scrim { display: block; position: fixed; inset: 0; background: rgba(7,13,24,.5); z-index: 35; }
      .burger { display: inline-flex; }
      .search { display: none; }
      .topbar { padding: 0 12px; }
    }
  `]
})
export class AppComponent {
  auth = inject(AuthService);
  rbac = inject(RbacService);
  theme = inject(ThemeService);
  store = inject(RegistryStore);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private intake = inject(IntakeApi);
  /** Documents waiting for review (intake), refreshed on every navigation. */
  inReview = signal(0);
  drawer = signal(false);
  isLogin = signal(/^#\/(login|invite)/.test(location.hash));
  title = signal('Dashboard');
  crumb = signal('Deeds Registry');

  nav = computed(() => {
    const role = this.auth.roleId();
    const sugg = this.store.openSuggestions().length;
    return [
      { path: '/', label: 'Dashboard', icon: 'home', badge: 0, mine: false, perm: 'dashboard.view' },
      { path: '/capture', label: 'Capture', icon: 'scan', badge: 0, mine: role === 'scan', perm: 'capture.view' },
      { path: '/verify', label: 'Verify metadata', icon: 'inbox', badge: this.inReview(), mine: role === 'rev', perm: 'verify.view' },
      { path: '/documents', label: 'Documents (EDRMS)', icon: 'file', badge: 0, mine: false, perm: ['capture.view', 'verify.view', 'record.view', 'audit.view'] },
      { path: '/link', label: 'Land record (create/finalize)', icon: 'layers', badge: sugg, mine: role === 'rec', perm: 'record.view' },
      { path: '/audit', label: 'Audit', icon: 'shield', badge: 0, mine: role === 'aud', perm: 'audit.view' }
    ].filter(n => this.rbac.canAny(Array.isArray(n.perm) ? n.perm : [n.perm]));
  });
  adminNav = computed(() => {
    const conflicts = this.rbac.users().filter(u => u.status !== 'Suspended' && this.rbac.userConflicts(u).length).length;
    return [
      { path: '/admin/users', label: 'Users', icon: 'users', perm: 'admin.users', badge: conflicts },
      { path: '/admin/offices', label: 'Offices', icon: 'building', perm: 'admin.offices', badge: 0 },
      { path: '/admin/roles', label: 'Roles & permissions', icon: 'lock', perm: 'admin.roles', badge: 0 },
      { path: '/admin/policies', label: 'Security policies', icon: 'shield', perm: 'admin.policies', badge: 0 },
      { path: '/admin/log', label: 'Access log', icon: 'clock', perm: 'admin.users', badge: 0 }
    ].filter(n => this.rbac.can(n.perm));
  });

  constructor() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe((e: any) => {
      this.isLogin.set(/^\/(login|invite)/.test(e.urlAfterRedirects));
      let r = this.route.firstChild;
      while (r?.firstChild) r = r.firstChild;
      const d = r?.snapshot.data || {};
      this.title.set(d['title'] || 'Dashboard');
      this.crumb.set(d['crumb'] || 'Deeds Registry · Windhoek');
      window.scrollTo(0, 0);
      this.countReview();
    });
  }

  private countReview() {
    if (!this.auth.signedIn() || !this.rbac.can('verify.view')) { this.inReview.set(0); return; }
    this.intake.documents({ status: ['ready'], limit: 1 }).then(r => this.inReview.set(r.total)).catch(() => {});
  }
}
