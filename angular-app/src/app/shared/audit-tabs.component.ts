import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { RbacService } from '../state/rbac.service';

/**
 * The "Land records | Trail | Anchorings" tabs of the Audit screens (API-698, API-673). Shown only
 * to whoever can open the Audit screen (`audit.view`); everyone else reaches Anchorings from the
 * side menu alone.
 */
@Component({
  selector: 'app-audit-tabs',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (rbac.can('audit.view')) {
      <nav class="tabs" aria-label="Audit views">
        <a routerLink="/audit" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">Land records</a>
        <a routerLink="/audit/trail" routerLinkActive="on" ariaCurrentWhenActive="page">Trail</a>
        <a routerLink="/anchorings" routerLinkActive="on" ariaCurrentWhenActive="page">Anchorings</a>
      </nav>
    }
  `,
  styles: [`
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-divider); }
    .tabs a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; color: var(--color-neutral-700); text-decoration: none; font-weight: 500; border-bottom: 3px solid transparent; }
    .tabs a.on { color: var(--color-accent-800); font-weight: 700; border-bottom-color: var(--color-accent); }
  `]
})
export class AuditTabsComponent {
  protected readonly rbac = inject(RbacService);
}
