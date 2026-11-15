import {ChangeDetectionStrategy, Component} from '@angular/core';
import {RouterLink} from '@angular/router';

/**
 * The page a user sees when they open a screen they are not allowed to see (`#/denied`, CB-43).
 */
@Component({
  selector: 'app-denied',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:12px">
      <h1 style="margin:4px 0 0;font-size:32px">You are not allowed to see this page</h1>
      <p class="muted" style="margin:0">Ask an administrator if you need it.</p>
      <a class="small" routerLink="/">← Home</a>
    </div>
  `,
})
export class DeniedComponent {}
