import {
  Component,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import {RouterLink} from '@angular/router';
import {DOCS, TOTAL} from '../../data/mock-data';
import {RegistryStore} from '../../state/registry.store';
import {IconComponent} from '../../shared/icon.component';

/** Dashboard: the capture pipeline of the sample batch, and how ready its land record is. */
@Component({
  selector: 'app-dashboard-pipeline',
  imports: [RouterLink, IconComponent],
  template: `
    <div class="panel">
      <div class="panel-head"><h3>Pipeline · batch WDH-B017</h3><a class="small" routerLink="/capture">Open batch</a></div>
      <div class="panel-body stack" style="gap:16px">
        <div class="pipe">
          @for (s of pipeline(); track s.label; let i = $index) {
            <div class="stage" [class.done]="s.pct === 100" [class.cur]="s.cur">
              <span class="dot">@if (s.pct === 100) { <app-icon name="check" [size]="14" /> } @else { {{ i + 1 }} }</span>
              <span class="sl">{{ s.label }}</span>
              <span class="sv num">{{ s.value }}</span>
              <span class="bar"><span [style.width.%]="s.pct"></span></span>
            </div>
          }
        </div>
        <div class="erf">
          <span class="kic info"><app-icon name="token" [size]="20" /></span>
          <div class="stack" style="gap:2px;min-width:0">
            <b>Erf 1873, Klein Windhoek</b>
            <span class="small muted">{{ readiness() }}</span>
          </div>
          <span class="tag" [class.tag-accent]="store.committed()" [class.tag-outline]="!store.committed()">{{ store.committed() ? 'Ready for tokenization' : 'In progress' }}</span>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .kic { grid-row: 1 / 4; width: 44px; height: 44px; border-radius: 10px; display: grid; place-items: center; background: var(--color-accent-100); color: var(--color-accent-600); }
    .kic.info { background: var(--color-accent-100); color: var(--color-accent-600); flex: none; }
    .pipe { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .stage { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 10px; background: var(--color-surface-2); border: 1px solid var(--color-divider); }
    .stage.cur { border-color: var(--color-accent-300); background: var(--color-accent-100); }
    .dot { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--color-neutral-200); color: var(--color-neutral-700); }
    .stage.done .dot { background: var(--success); color: #fff; }
    .stage.cur .dot { background: var(--color-accent); color: #fff; }
    .sl { font-size: 13px; font-weight: 600; }
    .sv { font-size: 13px; color: var(--color-neutral-700); }
    .stage.done .bar > span { background: var(--success); }
    .erf { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 14px; border-radius: 10px; border: 1px dashed var(--color-neutral-400); }
    @media (max-width: 720px) { .pipe { grid-template-columns: 1fr 1fr; } }
  `,
  ],
})
export class DashboardPipelineComponent {
  store = inject(RegistryStore);
  pipeline = computed(() => {
    const filed = DOCS.filter(d => this.store.filed()[d.id]).length;
    const linked = this.store.linkedCount();
    const steps = [
      {
        label: 'Captured',
        value: this.store.pages() + ' of ' + TOTAL + ' pages',
        pct: Math.round((this.store.pages() / TOTAL) * 100),
      },
      {
        label: 'Verified & filed',
        value: filed + ' of 3 documents',
        pct: Math.round((filed / 3) * 100),
      },
      {
        label: 'Linked to erf',
        value: linked + ' of 3 documents',
        pct: Math.round((linked / 3) * 100),
      },
      {
        label: 'Committed',
        value: this.store.committed() ? 'Record v3' : 'Pending',
        pct: this.store.committed() ? 100 : 0,
      },
    ];
    const cur = steps.findIndex(s => s.pct < 100);
    return steps.map((s, i) => ({...s, cur: i === cur}));
  });
  readiness = computed(() => {
    const c = this.store.checks();
    const ok = c.filter(x => x.state === 'ok').length;
    return (
      ok +
      ' of ' +
      c.length +
      ' record checks passing · ' +
      this.store.owners().length +
      ' registered owners'
    );
  });
}
