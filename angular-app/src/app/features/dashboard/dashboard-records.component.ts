import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {Router} from '@angular/router';
import {ViewerService} from '../../state/viewer.service';
import {RbacService} from '../../state/rbac.service';
import {RegistryStore} from '../../state/registry.store';
import {IconComponent} from '../../shared/icon.component';

/** Dashboard: the digitized land records, with search, status filters and pages. */
@Component({
  selector: 'app-dashboard-records',
  imports: [IconComponent],
  template: `
  <section class="panel">
    <div class="panel-head reg-head">
      <div class="stack" style="gap:2px">
        <h3>Digitized land records</h3>
        <span class="small muted">{{ records().length }} ERP land records backed by scanned EDRMS documents · Khomas region, registration division K</span>
      </div>
      <div class="search"><app-icon name="search" [size]="16" /><input class="input" placeholder="Erf, township or owner" [value]="q()" (input)="q.set($any($event.target).value); page.set(0)" aria-label="Search land records"></div>
    </div>
    <div class="panel-body stack" style="gap:14px">
      <div class="dist" role="img" [attr.aria-label]="'Status distribution: ' + counts().scanned + ' scanned, ' + counts().verified + ' verified, ' + counts().finalized + ' finalized'">
        <span class="s-scanned" [style.flex]="counts().scanned"></span>
        <span class="s-verified" [style.flex]="counts().verified"></span>
        <span class="s-finalized" [style.flex]="counts().finalized"></span>
      </div>
      <div class="filters">
        @for (f of statusFilters(); track f.id) {
          <button class="chip" [class.on]="status() === f.id" (click)="status.set(f.id); page.set(0)">
            @if (f.dot) { <span class="d" [class]="'d ' + f.dot"></span> }
            {{ f.label }} <b class="num">{{ f.n }}</b>
          </button>
        }
      </div>
    </div>
    <div style="overflow-x:auto">
      <table class="table reg">
        <thead><tr><th>Land parcel</th><th>Registered owner(s)</th><th>Extent · tenure</th><th style="text-align:right">Documents</th><th>Status</th><th>Last activity</th><th></th></tr></thead>
        <tbody>
          @for (r of pageRows(); track r.id) {
            <tr (click)="canOpen() && open(r)" [class.click]="canOpen()">
              <td><div class="parcel"><span class="pi"><app-icon name="layers" [size]="16" /></span><span class="stack" style="gap:0"><b>{{ r.erf }}, {{ r.township }}</b><span class="small muted">Reg. div {{ r.regDiv }} · {{ r.region }} · {{ r.batch }}</span></span></div></td>
              <td><div class="stack" style="gap:0">@for (o of r.ownerList; track o) { <span>{{ o }}</span> } @empty { <span class="muted">—</span> }</div></td>
              <td><div class="stack" style="gap:0"><span class="num">{{ r.extent }}</span><span class="small muted">{{ r.tenure }}</span></div></td>
              <td class="num" style="text-align:right">{{ r.docs }}</td>
              <td><div class="stack" style="gap:3px"><span class="tag" [class]="'tag ' + r.tag"><span class="d" [class]="'d ' + r.st"></span>{{ r.label }}</span><span class="small muted">{{ r.detail }}</span></div></td>
              <td class="small muted num" style="white-space:nowrap">{{ r.lastActivity }}</td>
              <td style="text-align:right;white-space:nowrap" (click)="$event.stopPropagation()">
                @if (r.docs) { <button class="btn btn-ghost btn-icon" title="View documents" (click)="viewDocs(r.id)"><app-icon name="eye" [size]="17" /></button> }
                @if (canOpen()) { <button class="btn btn-secondary" (click)="open(r)">{{ r.action }}</button> }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="muted" style="text-align:center;padding:32px">No land records match.</td></tr>
          }
        </tbody>
      </table>
    </div>
    <div class="pager">
      <span class="small muted">Showing {{ rangeLabel() }} of {{ filtered().length }}</span>
      <div class="row" style="gap:6px">
        <button class="btn btn-secondary btn-icon" [disabled]="page() === 0" (click)="page.set(page() - 1)" aria-label="Previous page"><app-icon name="left" /></button>
        <span class="small num" style="min-width:64px;text-align:center">Page {{ page() + 1 }} / {{ pages() }}</span>
        <button class="btn btn-secondary btn-icon" [disabled]="page() >= pages() - 1" (click)="page.set(page() + 1)" aria-label="Next page"><app-icon name="right" /></button>
      </div>
    </div>
  </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .reg-head { flex-wrap: wrap; align-items: flex-start; }
    .reg-head .search { position: relative; width: min(320px, 100%); }
    .reg-head .search app-icon { position: absolute; left: 11px; top: 12px; color: var(--color-neutral-500); }
    .reg-head .search .input { padding-left: 34px; }
    .dist { display: flex; height: 10px; border-radius: 99px; overflow: hidden; gap: 2px; background: var(--color-neutral-200); }
    .dist span { min-width: 4px; }
    .s-scanned { background: var(--color-neutral-400); }
    .s-verified { background: var(--color-accent); }
    .s-finalized { background: var(--success); }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 99px; border: 1px solid var(--color-neutral-300); background: var(--color-surface); cursor: pointer; font-size: 13px; font-weight: 600; color: var(--color-neutral-800); }
    .chip b { font-weight: 700; color: var(--color-neutral-600); }
    .chip:hover { border-color: var(--color-neutral-400); }
    .chip.on { background: var(--color-accent-100); border-color: var(--color-accent-300); color: var(--color-accent-700); }
    .chip.on b { color: var(--color-accent-700); }
    .d { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
    .d.scanned { background: var(--color-neutral-500); }
    .d.verified { background: var(--color-accent); }
    .d.finalized { background: var(--success); }
    .reg td { padding-top: 12px; padding-bottom: 12px; }
    .reg tr.click { cursor: pointer; }
    .parcel { display: flex; gap: 12px; align-items: center; }
    .pi { width: 34px; height: 34px; border-radius: 8px; flex: none; display: grid; place-items: center; background: var(--color-accent-100); color: var(--color-accent-600); }
    .pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--color-divider); flex-wrap: wrap; }
  `,
  ],
})
export class DashboardRecordsComponent {
  store = inject(RegistryStore);
  rbac = inject(RbacService);
  viewer = inject(ViewerService);
  private router = inject(Router);
  q = signal('');
  status = signal<'all' | 'scanned' | 'verified' | 'finalized'>('all');
  page = signal(0);
  readonly perPage = 10;

  records = computed(() => this.store.recordRows());
  counts = computed(() => {
    const r = this.records();
    return {
      all: r.length,
      scanned: r.filter(x => x.st === 'scanned').length,
      verified: r.filter(x => x.st === 'verified').length,
      finalized: r.filter(x => x.st === 'finalized').length,
    };
  });
  statusFilters = computed(() => {
    const c = this.counts();
    return [
      {id: 'all' as const, label: 'All records', n: c.all, dot: ''},
      {id: 'scanned' as const, label: 'Scanned', n: c.scanned, dot: 'scanned'},
      {
        id: 'verified' as const,
        label: 'Verified · ready for review',
        n: c.verified,
        dot: 'verified',
      },
      {
        id: 'finalized' as const,
        label: 'Finalized',
        n: c.finalized,
        dot: 'finalized',
      },
    ];
  });
  filtered = computed(() => {
    const q = this.q().toLowerCase().trim();
    const s = this.status();
    return this.records().filter(
      r =>
        (s === 'all' || r.st === s) &&
        (!q ||
          (
            r.erf +
            ' ' +
            r.township +
            ' ' +
            r.ownerList.join(' ') +
            ' ' +
            r.batch
          )
            .toLowerCase()
            .includes(q)),
    );
  });
  pages = computed(() =>
    Math.max(1, Math.ceil(this.filtered().length / this.perPage)),
  );
  pageRows = computed(() =>
    this.filtered().slice(
      this.page() * this.perPage,
      (this.page() + 1) * this.perPage,
    ),
  );
  rangeLabel = computed(() => {
    const n = this.filtered().length;
    if (!n) return '0';
    const a = this.page() * this.perPage + 1;
    return a + '–' + Math.min(n, a + this.perPage - 1);
  });
  viewDocs(id: string) {
    const ids = this.store.recordDocIds(id);
    if (ids.length) this.viewer.open('record', ids[0], 0, id);
  }
  open(r: {id: string}) {
    this.router.navigate(['/link'], {queryParams: {record: r.id}});
  }
  canOpen() {
    return this.rbac.can('record.view');
  }
}
