import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuditApi, AuditList, AuditListItem, ListFilter } from '../../api/audit.api';
import { InfoTipComponent } from '../../shared/info-tip.component';
import {
  ANCHORING, ANCHORING_ORDER, HOW_AUDIT_WORKS, TIPS, auditColumn, shortDate, toneClass
} from './audit-wording';

/** The filters, in the order the screen shows them. */
const FILTERS: { id: ListFilter; label: string }[] = [
  { id: 'changed', label: 'Changed since last audit' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'all', label: 'All' }
];

/** The page sizes offered. */
const PAGE_SIZES = [25, 50, 100];

/** How long typing must pause before the search runs, in milliseconds. */
const SEARCH_PAUSE_MS = 300;

/**
 * The land records list of the Audit screen (`#/audit`, API-661): pick the records to audit. It
 * shows the "How audit works" panel, search, the filters with their counts, and per record the
 * proof status, the open audit and its known blockchain check, and open findings.
 */
@Component({
  selector: 'app-audit-list',
  imports: [RouterLink, InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <header>
        <div class="card-kicker">Read-only</div>
        <h1 style="margin:4px 0 4px;font-size:36px">Audit</h1>
        <p class="muted" style="margin:0">Pick a land record to check its versions, documents, proofs and trail.</p>
      </header>

      <section class="how">
        <button type="button" class="how-head" [attr.aria-expanded]="howOpen()" (click)="howOpen.set(!howOpen())">
          <span class="chev" [class.open]="howOpen()" aria-hidden="true">▸</span>How audit works
          <span class="small muted">· 3 steps, 1 minute to read</span>
        </button>
        @if (howOpen()) {
          <ol class="how-steps">
            @for (s of how; track s.step; let first = $first) {
              <li class="how-step">
                <span class="step">{{ s.step }}</span>
                <strong>{{ s.title }}</strong>
                <span>{{ s.body }}</span>
                <span class="small muted">{{ s.note }}</span>
                @if (first) {
                  <ul class="tags">
                    @for (a of anchoringSteps; track a.label) {
                      <li><span [class]="a.tagClass">{{ a.label }}</span><span class="small">{{ a.hint }}</span></li>
                    }
                  </ul>
                }
              </li>
            }
          </ol>
        }
      </section>

      <section class="panel">
        <div class="panel-head row" style="gap:12px;align-items:flex-end">
          <label class="field" style="flex:1 1 360px">
            <span class="small muted">Search land records</span>
            <input class="input" type="search" placeholder="Erf number, township, owner or deed number" [value]="query()" (input)="typeQuery($event)" />
          </label>
        </div>
        <div class="row filters" role="group" aria-label="Filter land records">
          @for (f of filters; track f.id) {
            <button type="button" class="chip" [class.on]="filter() === f.id" [attr.aria-pressed]="filter() === f.id" (click)="pick(f.id)">
              {{ f.label }} <strong>{{ counts()[f.id] }}</strong>
            </button>
          }
          <app-info-tip label="filters" [text]="tips.listFilters" />
        </div>

        @if (error(); as e) {
          <div class="note danger" role="alert">{{ e }}</div>
        }
        <div style="overflow-x:auto">
          <table class="table" style="min-width:960px">
            <thead>
              <tr>
                <th>Land record</th>
                <th>Owner</th>
                <th>Current version</th>
                <th><span class="th">Proof<app-info-tip label="proof status" [text]="tips.proofStatus" /></span></th>
                <th><span class="th">Audit<app-info-tip label="audit" [text]="tips.audit" /></span></th>
                <th><span class="th">Findings<app-info-tip label="findings" align="right" [text]="tips.findings" /></span></th>
                <th><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.item.id) {
                <tr>
                  <td>
                    <a class="rec" [routerLink]="['/audit/records', r.item.id]">
                      <strong>{{ r.item.label }}</strong><span class="small muted">{{ r.item.recordNo }}</span>
                    </a>
                  </td>
                  <td>{{ r.owners }}</td>
                  <td><strong>v{{ r.item.currentVersion }}</strong><span class="muted"> · {{ r.changed }}</span></td>
                  <td><span [class]="r.proofClass">{{ r.proofLabel }}</span></td>
                  <td>
                    <div class="stack" style="gap:2px">
                      <span>{{ r.audit.title }}</span>
                      @if (r.audit.note) {
                        <span class="small" [class]="'small tone-' + r.audit.tone">{{ r.audit.note }}</span>
                      }
                      @if (r.signoffProof) {
                        <span [class]="r.signoffProof.tagClass" style="align-self:flex-start">{{ r.signoffProof.label }}</span>
                      }
                    </div>
                  </td>
                  <td>
                    @if (r.item.audit.openFindings) {
                      <span class="tag tag-outline">{{ r.item.audit.openFindings }} open</span>
                    } @else {
                      <span class="muted">None</span>
                    }
                  </td>
                  <td style="text-align:right">
                    <a class="btn btn-secondary" [routerLink]="['/audit/records', r.item.id]" [attr.aria-label]="'Open ' + r.item.label + ' for audit'">Open</a>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="muted" style="padding:22px 16px">{{ loading() ? 'Loading…' : 'No land records match. Check the spelling, or search by Erf number.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>

        <nav class="row pager" aria-label="Pages">
          <span class="muted">{{ rangeText() }}</span>
          <div class="row" style="gap:6px">
            <button type="button" class="btn btn-secondary" [disabled]="page() === 1" (click)="page.set(page() - 1)">Previous</button>
            @for (p of pageNumbers(); track $index) {
              @if (p === null) {
                <span class="muted">…</span>
              } @else {
                <button type="button" class="btn" [class.btn-primary]="p === page()" [class.btn-secondary]="p !== page()"
                        [attr.aria-current]="p === page() ? 'page' : null" (click)="page.set(p)">{{ p }}</button>
              }
            }
            <button type="button" class="btn btn-secondary" [disabled]="page() >= pageCount()" (click)="page.set(page() + 1)">Next</button>
          </div>
          <label class="row small" style="gap:6px">
            <span class="muted">Per page</span>
            <select class="input" style="width:auto" [value]="pageSize()" (change)="pickSize($event)">
              @for (n of pageSizes; track n) { <option [value]="n">{{ n }}</option> }
            </select>
          </label>
        </nav>
      </section>
    </div>
  `,
  styles: [`
    .how { background: var(--color-accent-100); border: 1px solid var(--color-accent-200, var(--color-divider)); border-radius: var(--radius-lg); }
    .how-head { width: 100%; min-height: 48px; padding: 0 18px; border: 0; background: transparent; display: flex; gap: 10px; align-items: center;
                cursor: pointer; text-align: left; font-weight: 600; font-size: 15px; color: inherit; }
    .chev { display: inline-block; transition: transform .15s; }
    .chev.open { transform: rotate(90deg); }
    .how-steps { margin: 0; padding: 0 18px 18px; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .how-step { background: var(--color-surface); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
    .step { font-size: 12px; font-weight: 700; color: var(--color-accent-800); text-transform: uppercase; }
    .tags { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .tags li { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
    .filters { padding: 10px 16px; gap: 8px; border-bottom: 1px solid var(--color-divider); }
    .chip { min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--color-neutral-400, var(--color-divider)); background: var(--color-surface); cursor: pointer; font: inherit; }
    .chip.on { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
    .th { display: inline-flex; align-items: center; }
    .rec { display: flex; flex-direction: column; min-height: 44px; justify-content: center; text-decoration: none; }
    .pager { padding: 12px 16px; border-top: 1px solid var(--color-divider); justify-content: space-between; gap: 10px; }
    .tone-success { color: var(--success-fg); } .tone-danger { color: var(--danger-fg); } .tone-neutral { color: var(--color-neutral-700); }
    .note.danger { margin: 10px 16px; padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `]
})
export class AuditListComponent {
  private readonly audit = inject(AuditApi);

  protected readonly tips = TIPS;
  protected readonly how = HOW_AUDIT_WORKS;
  protected readonly filters = FILTERS;
  protected readonly pageSizes = PAGE_SIZES;
  protected readonly anchoringSteps = ANCHORING_ORDER.map(s => ({ ...ANCHORING[s], tagClass: toneClass(ANCHORING[s].tone) }));

  protected readonly howOpen = signal(true);
  protected readonly query = signal('');
  protected readonly filter = signal<ListFilter>('changed');
  protected readonly page = signal(1);
  protected readonly pageSize = signal(PAGE_SIZES[0]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly result = signal<AuditList | null>(null);
  private readonly search = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts requests, so a slow answer to an earlier search never replaces a newer one. */
  private requestNo = 0;

  protected readonly counts = computed(() => this.result()?.counts ?? { changed: 0, attention: 0, all: 0 });
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil((this.result()?.total ?? 0) / this.pageSize())));

  protected readonly rows = computed(() => (this.result()?.items ?? []).map(item => this.row(item)));

  protected readonly rangeText = computed(() => {
    const total = this.result()?.total ?? 0;
    if (!total) {
      return 'No land records';
    }
    const first = (this.page() - 1) * this.pageSize() + 1;
    const last = Math.min(first + this.pageSize() - 1, total);
    return `${first}–${last} of ${total.toLocaleString('en')} land records`;
  });

  /** The page numbers to show: the first three, the current one and the last, with gaps. */
  protected readonly pageNumbers = computed(() => {
    const count = this.pageCount();
    const wanted = new Set([1, 2, 3, this.page(), count].filter(n => n >= 1 && n <= count));
    const sorted = [...wanted].sort((a, b) => a - b);
    const out: (number | null)[] = [];
    for (const n of sorted) {
      const previous = out[out.length - 1];
      if (typeof previous === 'number' && n - previous > 1) {
        out.push(null);
      }
      out.push(n);
    }
    return out;
  });

  constructor() {
    effect(() => {
      void this.load(this.search(), this.filter(), this.page(), this.pageSize());
    });
  }

  protected typeQuery(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.search.set(value.trim());
    }, SEARCH_PAUSE_MS);
  }

  protected pick(filter: ListFilter): void {
    this.filter.set(filter);
    this.page.set(1);
  }

  protected pickSize(event: Event): void {
    this.pageSize.set(Number((event.target as HTMLSelectElement).value));
    this.page.set(1);
  }

  private async load(q: string, filter: ListFilter, page: number, size: number): Promise<void> {
    const mine = ++this.requestNo;
    this.loading.set(true);
    try {
      const result = await this.audit.list({ q, filter, limit: size, offset: (page - 1) * size });
      if (mine === this.requestNo) {
        this.result.set(result);
        this.error.set(null);
      }
    } catch (e) {
      if (mine === this.requestNo) {
        this.error.set((e as Error).message);
      }
    } finally {
      if (mine === this.requestNo) {
        this.loading.set(false);
      }
    }
  }

  private row(item: AuditListItem) {
    const proof = ANCHORING[item.proof];
    const last = item.audit.lastSignoff;
    // a signed-off record: how far the sign-off's own trail entry has got on the blockchain
    let signoffProof: { label: string; tagClass: string } | null = null;
    if (!item.audit.range && last) {
      const status = ANCHORING[last.proof];
      signoffProof = { label: status.label, tagClass: toneClass(status.tone) };
    }
    return {
      item,
      owners: item.owners.join(', ') || '—',
      changed: shortDate(item.changedAt),
      proofLabel: proof.label,
      proofClass: toneClass(proof.tone),
      audit: auditColumn(item.audit),
      signoffProof
    };
  }
}
