import {
  Component,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {BATCHES, QUEUE} from '../../data/mock-data';
import {RegistryStore} from '../../state/registry.store';

/** Dashboard: the review queue by batch, with the share of documents filed. */
@Component({
  selector: 'app-dashboard-batches',
  imports: [RouterLink],
  template: `
    <div class="panel">
      <div class="panel-head"><h3>Review queue by batch</h3><a class="small" routerLink="/verify">Open queue</a></div>
      <div style="overflow-x:auto">
        <table class="table">
          <thead><tr><th>Batch</th><th>Source</th><th style="text-align:right">Documents</th><th style="width:34%">Filed</th></tr></thead>
          <tbody>
            @for (b of batches(); track b.id) {
              <tr>
                <td style="font-weight:600">{{ b.id }}</td>
                <td class="small muted">{{ b.src }}</td>
                <td class="num" style="text-align:right">{{ b.total }}</td>
                <td><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="bar" style="flex:1"><span [style.width.%]="b.pct" [style.background]="b.pct === 100 ? 'var(--success)' : ''"></span></span><span class="small num" style="width:36px;text-align:right">{{ b.pct }}%</span></div></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
  `,
  ],
})
export class DashboardBatchesComponent {
  store = inject(RegistryStore);
  batches = computed(() => {
    this.store.filed();
    return BATCHES.map(b => {
      const docs = QUEUE.filter(d => d.batch === b.id);
      const f = docs.filter(d => this.store.isFiled(d)).length;
      return {
        id: b.id,
        src: b.src,
        total: docs.length,
        pct: Math.round((f / docs.length) * 100),
      };
    });
  });
}
