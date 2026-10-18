import {Component, ChangeDetectionStrategy} from '@angular/core';

const WEEK = [
  {d: 'Mon', pages: 1840, docs: 412},
  {d: 'Tue', pages: 2210, docs: 498},
  {d: 'Wed', pages: 1975, docs: 451},
  {d: 'Thu', pages: 2460, docs: 540},
  {d: 'Fri', pages: 2105, docs: 472},
  {d: 'Sat', pages: 620, docs: 131},
  {d: 'Today', pages: 1380, docs: 309},
];

/** Dashboard: pages scanned per day over the last week (sample figures). */
@Component({
  selector: 'app-dashboard-throughput',
  imports: [],
  template: `
    <div class="panel">
      <div class="panel-head"><h3>Throughput · last 7 days</h3><span class="small muted">Pages scanned, all stations</span></div>
      <div class="panel-body">
        <div class="chart" role="img" aria-label="Pages scanned per day">
          @for (w of week; track w.d) {
            <div class="col">
              <span class="val num">{{ w.pages.toLocaleString() }}</span>
              <span class="b" [style.height.%]="w.pages / maxPages * 100" [class.today]="w.d === 'Today'"></span>
              <span class="lab">{{ w.d }}</span>
            </div>
          }
        </div>
        <div class="row small muted" style="justify-content:space-between;margin-top:12px">
          <span>Weekly total <b class="num" style="color:var(--color-text)">{{ weekTotal.toLocaleString() }}</b> pages</span>
          <span>Target 15 000 · <b style="color:var(--success)">{{ Math.round(weekTotal / 150) }}%</b></span>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .chart { height: 200px; display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; align-items: end; }
    .col { height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; }
    .b { width: 100%; max-width: 44px; border-radius: 6px 6px 2px 2px; background: var(--color-accent-300); min-height: 4px; }
    .b.today { background: var(--color-accent); }
    .val { font-size: 11px; color: var(--color-neutral-600); }
    .lab { font-size: 12px; color: var(--color-neutral-700); font-weight: 500; }
    @media (max-width: 720px) { .chart { gap: 6px; } .val { display: none; } }
  `,
  ],
})
export class DashboardThroughputComponent {
  // The global Math, under its own name, for the template.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  Math = Math;
  week = WEEK;
  maxPages = Math.max(...WEEK.map(w => w.pages));
  weekTotal = WEEK.reduce((a, w) => a + w.pages, 0);
}
