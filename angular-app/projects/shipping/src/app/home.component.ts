import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {AuthService, SiteConfigService} from '@lrfe/platform';

/** The empty home page of the shipping app: who is signed in, and signing out. */
@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="page" style="display:grid;place-items:center;min-height:80vh">
      <div class="panel" style="max-width:500px;padding:36px 32px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px">
        <h1 style="margin:0">{{ site.config().orgName }}</h1>
        <p class="muted" style="margin:0">Signed in as <b>{{ auth.me()?.user?.name }}</b>. The bill-of-lading screens come next.</p>
        <button class="btn btn-secondary" type="button" (click)="auth.logout()">Sign out</button>
      </div>
    </div>
  `,
})
export class HomeComponent {
  protected readonly auth = inject(AuthService);
  protected readonly site = inject(SiteConfigService);
}
