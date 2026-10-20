import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {ActivatedRoute, RouterLink, RouterLinkActive} from '@angular/router';
import {RbacService} from '../../state/rbac.service';
import {ToastService} from '../../state/toast.service';
import {AdminLogComponent} from './admin-log.component';
import {AdminOfficesComponent} from './admin-offices.component';
import {AdminPoliciesComponent} from './admin-policies.component';
import {AdminRolesComponent} from './admin-roles.component';
import {AdminUsersComponent} from './admin-users.component';

type Tab = 'users' | 'offices' | 'roles' | 'policies' | 'log';

/** Administration: users, offices, roles and permissions, security policies and the access log. */
@Component({
  selector: 'app-admin',
  imports: [
    RouterLink,
    RouterLinkActive,
    AdminUsersComponent,
    AdminOfficesComponent,
    AdminRolesComponent,
    AdminPoliciesComponent,
    AdminLogComponent,
  ],
  template: `
    <div class="page stack" style="gap:20px">
      <nav class="tabs" aria-label="Administration">
        @for (t of visibleTabs(); track t.id) { <a [routerLink]="t.path" routerLinkActive="on">{{ t.label }}</a> }
      </nav>

      @if (tab() === 'users') { <app-admin-users /> }
      @if (tab() === 'offices') { <app-admin-offices /> }
      @if (tab() === 'roles') { <app-admin-roles /> }
      @if (tab() === 'policies') { <app-admin-policies /> }
      @if (tab() === 'log') { <app-admin-log /> }
    </div>

    <!-- Activation link: the invitation email did not go out, and the server exposes links (dev) -->
    @if (rbac.lastInviteLink(); as l) {
      <div class="dialog-backdrop" (click)="rbac.lastInviteLink.set(null)">
        <div class="dialog" style="width:min(560px,100%)" (click)="$event.stopPropagation()">
          <div class="dialog-title">Activation link for {{ l.name }}</div>
          <div class="dialog-body">The invitation email was not sent: {{ l.reason }}. Send this link to <b>{{ l.email }}</b> yourself. It works once and expires in 3 days; they choose a password and set up an authenticator app.</div>
          <input class="input mono" style="font-size:12.5px;margin:12px 0" readonly [value]="l.url" (focus)="$any($event.target).select()">
          <div class="dialog-actions"><button class="btn btn-secondary" (click)="copy(l.url)">Copy link</button><button class="btn btn-primary" (click)="rbac.lastInviteLink.set(null)">Done</button></div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-divider); flex-wrap: wrap; }
    .tabs a { padding: 10px 14px; font-weight: 600; font-size: 14px; color: var(--color-neutral-700); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tabs a:hover { color: var(--color-text); }
    .tabs a.on { color: var(--color-accent-600); border-bottom-color: var(--color-accent); }
  `,
  ],
})
export class AdminComponent {
  rbac = inject(RbacService);
  private toast = inject(ToastService);
  tab = signal<Tab>('users');
  tabs = [
    {id: 'users', label: 'Users', path: '/admin/users', perm: 'admin.users'},
    {
      id: 'offices',
      label: 'Offices',
      path: '/admin/offices',
      perm: 'admin.offices',
    },
    {
      id: 'roles',
      label: 'Roles & permissions',
      path: '/admin/roles',
      perm: 'admin.roles',
    },
    {
      id: 'policies',
      label: 'Security policies',
      path: '/admin/policies',
      perm: 'admin.policies',
    },
    {id: 'log', label: 'Access log', path: '/admin/log', perm: 'admin.users'},
  ];
  visibleTabs = computed(() => this.tabs.filter(t => this.rbac.can(t.perm)));
  constructor() {
    inject(ActivatedRoute).data.subscribe(d => {
      this.tab.set(d['tab'] || 'users');
      this.rbac.loadAdmin();
    });
  }
  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show('success', 'Link copied');
    } catch {
      this.toast.show(
        'warn',
        'Copy failed',
        'Select the link and copy it manually.',
      );
    }
  }
}
