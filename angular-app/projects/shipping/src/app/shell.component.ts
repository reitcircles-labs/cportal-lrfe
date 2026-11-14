import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {RouterLink, RouterOutlet} from '@angular/router';
import {AuthService, SiteConfigService} from '@lrfe/platform';

/**
 * The frame of the signed-in shipping app (CB-42): the site's name, who is signed in and for
 * which organisation, signing out, and the current screen below.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <header class="top">
      <a class="brand h-cond" routerLink="/">{{ site.config().orgName }}</a>
      <span class="spacer"></span>
      <span class="small muted who">
        Signed in as <b>{{ auth.me()?.user?.name }}</b>
        @if (auth.me()?.user?.organisation; as organisation) {
          · {{ organisation }}
        }
      </span>
      <button class="btn btn-secondary" type="button" (click)="auth.logout()">Sign out</button>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: [
    `
    .top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 28px; border-bottom: 1px solid var(--color-divider); background: var(--color-surface); }
    .brand { font-size: 18px; text-decoration: none; color: inherit; }
    .spacer { margin-left: auto; }
  `,
  ],
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
  protected readonly site = inject(SiteConfigService);
}
