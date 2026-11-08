import {
  Component,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {RegistryStore} from '../../state/registry.store';

/** Dashboard: the latest entries of the audit trail. */
@Component({
  selector: 'app-dashboard-activity',
  imports: [RouterLink],
  template: `
    <div class="panel">
      <div class="panel-head"><h3>Recent activity</h3><a class="small" routerLink="/audit">Full audit trail</a></div>
      <ul class="feed">
        @for (a of recent(); track a.hash) {
          <li>
            <span class="fdot" [class.ok]="a.action === 'Filed' || a.action === 'Linked' || a.action === 'Committed' || a.action === 'Audited'"></span>
            <div class="stack" style="gap:1px;min-width:0">
              <span style="font-size:14px"><b>{{ a.who }}</b> · {{ a.action.toLowerCase() }} <span class="num">{{ a.obj }}</span></span>
              <span class="small muted">{{ a.time.slice(12) }} · {{ a.detail }}</span>
            </div>
          </li>
        }
      </ul>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .feed { list-style: none; margin: 0; padding: 8px 18px 14px; display: flex; flex-direction: column; }
    .feed li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--color-divider); }
    .feed li:last-child { border-bottom: 0; }
    .fdot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; background: var(--color-neutral-400); }
    .fdot.ok { background: var(--success); }
  `,
  ],
})
export class DashboardActivityComponent {
  store = inject(RegistryStore);
  recent = computed(() => [...this.store.trail()].reverse().slice(0, 6));
}
