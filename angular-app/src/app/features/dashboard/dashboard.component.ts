import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BATCHES, DOCS, QUEUE, TOTAL } from '../../data/mock-data';
import { ViewerService } from '../../state/viewer.service';
import { RbacService } from '../../state/rbac.service';
import { RegistryStore } from '../../state/registry.store';
import { AuthService } from '../../state/auth.service';
import { IconComponent } from '../../shared/icon.component';

const WEEK = [
  { d: 'Mon', pages: 1840, docs: 412 }, { d: 'Tue', pages: 2210, docs: 498 }, { d: 'Wed', pages: 1975, docs: 451 },
  { d: 'Thu', pages: 2460, docs: 540 }, { d: 'Fri', pages: 2105, docs: 472 }, { d: 'Sat', pages: 620, docs: 131 }, { d: 'Today', pages: 1380, docs: 309 }
];

@Component({
    selector: 'app-dashboard',
    imports: [RouterLink, IconComponent],
    template: `
    <div class="page stack" style="gap:24px">
      <section class="welcome">
        <div>
          <h2 style="margin:0 0 4px">Good morning, {{ firstName() }}</h2>
          <span class="muted">Windhoek Deeds Registry · Monday 28 September 2026 · back-scanning programme, week 38</span>
        </div>
        <div class="row">
          <a class="btn btn-secondary" routerLink="/flow"><app-icon name="flow" [size]="16" />How the process works</a>
          <a class="btn btn-primary" [routerLink]="auth.role()?.home || '/verify'">Open my queue<app-icon name="arrowRight" [size]="16" /></a>
        </div>
      </section>

      <section class="kpis">
        @for (k of kpis(); track k.label) {
          <a class="panel kpi" [routerLink]="k.link">
            <span class="kic" [class]="'kic ' + k.tone"><app-icon [name]="k.icon" [size]="20" /></span>
            <span class="kl">{{ k.label }}</span>
            <span class="kv num">{{ k.value }}</span>
            <span class="kd" [class.up]="k.up">{{ k.delta }}</span>
          </a>
        }
      </section>

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

      <section class="grid2">
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
      </section>

      <section class="grid2">
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
      </section>
    </div>
  `,
    changeDetection: ChangeDetectionStrategy.Eager,
    styles: [`
    .welcome { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .kpi { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto auto; gap: 2px 14px; padding: 18px; text-decoration: none; color: inherit; transition: box-shadow .15s, transform .15s, border-color .15s; }
    .kpi:hover { box-shadow: var(--shadow-md); border-color: var(--color-accent-300); transform: translateY(-1px); }
    .kic { grid-row: 1 / 4; width: 44px; height: 44px; border-radius: 10px; display: grid; place-items: center; background: var(--color-accent-100); color: var(--color-accent-600); }
    .kic.ok { background: var(--success-bg); color: var(--success); }
    .kic.warn { background: var(--warn-bg); color: var(--warn); }
    .kic.info { background: var(--color-accent-100); color: var(--color-accent-600); flex: none; }
    .kl { font-size: 13px; color: var(--color-neutral-700); font-weight: 500; }
    .kv { font-size: 28px; font-weight: 800; letter-spacing: -.02em; line-height: 1.15; }
    .kd { font-size: 12.5px; color: var(--color-neutral-600); }
    .kd.up { color: var(--success); }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 20px; align-items: start; }
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
    .chart { height: 200px; display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; align-items: end; }
    .col { height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; }
    .b { width: 100%; max-width: 44px; border-radius: 6px 6px 2px 2px; background: var(--color-accent-300); min-height: 4px; }
    .b.today { background: var(--color-accent); }
    .val { font-size: 11px; color: var(--color-neutral-600); }
    .lab { font-size: 12px; color: var(--color-neutral-700); font-weight: 500; }
    .feed { list-style: none; margin: 0; padding: 8px 18px 14px; display: flex; flex-direction: column; }
    .feed li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--color-divider); }
    .feed li:last-child { border-bottom: 0; }
    .fdot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; background: var(--color-neutral-400); }
    .fdot.ok { background: var(--success); }
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
    @media (max-width: 720px) { .pipe { grid-template-columns: 1fr 1fr; } .chart { gap: 6px; } .val { display: none; } }
  `]
})
export class DashboardComponent {
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
    return { all: r.length, scanned: r.filter(x => x.st === 'scanned').length, verified: r.filter(x => x.st === 'verified').length, finalized: r.filter(x => x.st === 'finalized').length };
  });
  statusFilters = computed(() => {
    const c = this.counts();
    return [
      { id: 'all' as const, label: 'All records', n: c.all, dot: '' },
      { id: 'scanned' as const, label: 'Scanned', n: c.scanned, dot: 'scanned' },
      { id: 'verified' as const, label: 'Verified · ready for review', n: c.verified, dot: 'verified' },
      { id: 'finalized' as const, label: 'Finalized', n: c.finalized, dot: 'finalized' }
    ];
  });
  filtered = computed(() => {
    const q = this.q().toLowerCase().trim(), s = this.status();
    return this.records().filter(r => (s === 'all' || r.st === s) && (!q || (r.erf + ' ' + r.township + ' ' + r.ownerList.join(' ') + ' ' + r.batch).toLowerCase().includes(q)));
  });
  pages = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.perPage)));
  pageRows = computed(() => this.filtered().slice(this.page() * this.perPage, (this.page() + 1) * this.perPage));
  rangeLabel = computed(() => { const n = this.filtered().length; if (!n) return '0'; const a = this.page() * this.perPage + 1; return a + '–' + Math.min(n, a + this.perPage - 1); });
  viewDocs(id: string) { const ids = this.store.recordDocIds(id); if (ids.length) this.viewer.open('record', ids[0], 0, id); }
  open(r: { id: string }) { this.router.navigate(['/link'], { queryParams: { record: r.id } }); }
  canOpen() { return this.rbac.can('record.view'); }


  auth = inject(AuthService);
  Math = Math;
  week = WEEK;
  maxPages = Math.max(...WEEK.map(w => w.pages));
  weekTotal = WEEK.reduce((a, w) => a + w.pages, 0);

  firstName = computed(() => (this.auth.role()?.name || '').replace(/^[A-Z]\.\s*/, '') || 'colleague');
  private openDocs = computed(() => { this.store.fs(); this.store.filed(); return QUEUE.filter(d => !this.store.isFiled(d)); });
  kpis = computed(() => {
    const th = this.store.threshold(), open = this.openDocs();
    const low = open.reduce((a, d) => a + d.fields.filter(f => (f.c ?? 1) < th).length, 0);
    return [
      { label: 'Pages captured · WDH-B017', value: this.store.pages() + ' / ' + TOTAL, delta: this.store.scanDone() ? 'Batch complete' : 'Scanner SC-02 ready', up: this.store.scanDone(), icon: 'scan', tone: 'info', link: '/capture' },
      { label: 'Documents awaiting review', value: String(open.length), delta: 'across ' + BATCHES.length + ' batches', up: false, icon: 'inbox', tone: 'info', link: '/verify' },
      { label: 'Low-confidence fields', value: String(low), delta: 'below ' + Math.round(th * 100) + '% threshold', up: false, icon: 'alert', tone: 'warn', link: '/verify' },
      { label: 'Records finalized', value: String(this.store.recordRows().filter(r => r.st === 'finalized').length), delta: 'of ' + this.store.recordRows().length + ' land records · tokenization-ready', up: true, icon: 'token', tone: 'ok', link: '/link' }
    ];
  });
  pipeline = computed(() => {
    const filed = DOCS.filter(d => this.store.filed()[d.id]).length, linked = this.store.linkedCount();
    const steps = [
      { label: 'Captured', value: this.store.pages() + ' of ' + TOTAL + ' pages', pct: Math.round(this.store.pages() / TOTAL * 100) },
      { label: 'Verified & filed', value: filed + ' of 3 documents', pct: Math.round(filed / 3 * 100) },
      { label: 'Linked to erf', value: linked + ' of 3 documents', pct: Math.round(linked / 3 * 100) },
      { label: 'Committed', value: this.store.committed() ? 'Record v3' : 'Pending', pct: this.store.committed() ? 100 : 0 }
    ];
    const cur = steps.findIndex(s => s.pct < 100);
    return steps.map((s, i) => ({ ...s, cur: i === cur }));
  });
  readiness = computed(() => {
    const c = this.store.checks(), ok = c.filter(x => x.state === 'ok').length;
    return ok + ' of ' + c.length + ' record checks passing · ' + this.store.owners().length + ' registered owners';
  });
  batches = computed(() => { this.store.filed(); return BATCHES.map(b => {
    const docs = QUEUE.filter(d => d.batch === b.id), f = docs.filter(d => this.store.isFiled(d)).length;
    return { id: b.id, src: b.src, total: docs.length, pct: Math.round(f / docs.length * 100) };
  }); });
  recent = computed(() => [...this.store.trail()].reverse().slice(0, 6));
}
