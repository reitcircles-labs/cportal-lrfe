import {ChangeDetectionStrategy, Component} from '@angular/core';
import {RouterOutlet} from '@angular/router';
import {OverlaysComponent} from '@lrfe/platform';

/** The shipping app's shell: the current screen, with the platform's toasts and dialogs. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, OverlaysComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <router-outlet />
    <app-overlays />
  `,
})
export class AppComponent {}
