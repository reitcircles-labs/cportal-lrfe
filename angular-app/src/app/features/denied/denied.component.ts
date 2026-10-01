import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { RbacService } from '../../state/rbac.service';
import { AuthService } from '../../state/auth.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
    selector: 'app-denied',
    imports: [RouterLink, IconComponent],
    template: `
    <div class="page" style="display:grid;place-items:center;min-height:62vh">
      <div class="panel" style="max-width:500px;padding:36px 32px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <span style="width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:var(--warn-bg);color:var(--warn)"><app-icon name="lock" [size]="26" /></span>
        <h2 style="margin:0">You don't have access to this area</h2>
        <p class="muted" style="margin:0">Your role <b style="color:var(--color-text)">{{ rbac.roleLabel() }}</b> is missing the permission <b style="color:var(--color-text)">“{{ rbac.permLabel(perm()) }}”</b>. Ask a system administrator to grant it.</p>
        <a class="btn btn-primary" style="margin-top:8px" [routerLink]="auth.role()?.home || '/'">Go to my workspace</a>
      </div>
    </div>
  `
})
export class DeniedComponent {
  rbac = inject(RbacService);
  auth = inject(AuthService);
  perm = signal('');
  constructor() { inject(ActivatedRoute).queryParamMap.subscribe(q => this.perm.set(q.get('perm') || '')); }
}
