import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AnchoringsApi, BatchFilter, BatchList, BatchRow } from '../../api/anchorings.api';
import { AuditTabsComponent } from '../../shared/audit-tabs.component';
import { InfoTipComponent } from '../../shared/info-tip.component';
import { AnchoringSearchComponent } from './anchoring-search.component';
import {
  BATCH_STATUS, FAIL_REASON, FILTERS, HOW_ANCHORING_WORKS, JOURNEY, MESSAGES, TIPS, aboutTime, count, coversText, depthText,
  gapNote, inSentence, plural, rangeText, shortHash, toneClass, when
} from './anchorings-wording';

/** The page sizes offered. */
const PAGE_SIZES = [25, 50, 100];

/** How many failed batches the note on gaps names. */
const GAPS_NAMED = 3;

/**
 * The Anchorings list (`#/anchorings`, API-698, design API-688 board 1), for every signed-in user:
 * the search "Is it on the blockchain?", how anchoring works, the last confirmed, in-progress and
 * next batch, and every batch with its status, transaction and block, newest first.
 */
@Component({
  selector: 'app-anchorings-list',
  imports: [RouterLink, InfoTipComponent, AnchoringSearchComponent, AuditTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <header>
        <div class="card-kicker">Read-only</div>
        <h1 style="margin:4px 0 4px;font-size:36px">Anchorings</h1>
        <p class="muted" style="margin:0">Every batch of fingerprints the portal has put on the blockchain, and how far each one has got.</p>
      </header>
      <app-audit-tabs />

      <app-anchoring-search />

      <h2 style="margin:8px 0 0;font-size:20px">All batches</h2>

      <section class="how">
        <button type="button" class="how-head" [attr.aria-expanded]="howOpen()" (click)="howOpen.set(!howOpen())">
          <span class="chev" [class.open]="howOpen()" aria-hidden="true">▸</span>How anchoring works
          <span class="small muted">· 1 minute to read</span>
        </button>
        @if (howOpen()) {
          <ol class="how-steps">
            @for (s of how; track s.step; let last = $last) {
              <li class="how-step">
                <span class="step">{{ s.step }}</span>
                <strong>{{ s.title }}</strong>
                @if (s.body) { <span>{{ s.body }}</span> }
                @if (last) {
                  <ul class="tags">
                    @for (j of journey; track j.label) {
                      <li><span [class]="j.tagClass">{{ j.label }}</span><span class="small">{{ j.text }}</span></li>
                    }
                  </ul>
                }
              </li>
            }
          </ol>
        }
      </section>

      <div class="cards">
        <div class="panel card">
          <span class="kicker th">Last confirmed<app-info-tip label="last confirmed" [text]="tips.lastConfirmed" /></span>
          @if (lastConfirmed(); as b) {
            <a class="big" [routerLink]="['/anchorings', b.batch]">Batch {{ b.label }}</a>
            <span>Created {{ b.when }} · {{ b.covers }}</span>
          } @else {
            <span class="big">—</span><span class="muted">None yet</span>
          }
        </div>
        <div class="panel card">
          <span class="kicker th">In progress<app-info-tip label="in progress" [text]="tips.inProgress" /></span>
          @if (inProgress(); as b) {
            <a class="big" [routerLink]="['/anchorings', b.batch]">Batch {{ b.label }}</a>
            <span class="row" style="gap:8px"><span [class]="b.tagClass">{{ b.status }}</span><span>{{ b.depth }}</span></span>
          } @else {
            <span class="big">—</span><span class="muted">None at the moment</span>
          }
        </div>
        @if (next(); as n) {
          <div class="panel card">
            <span class="kicker th">Next batch<app-info-tip label="next batch" align="right" [text]="tips.nextBatch" /></span>
            <span class="big">{{ n.due }}</span>
            <span>{{ n.waiting }}</span>
          </div>
        }
      </div>

      <section class="panel">
        <div class="row filters" role="group" aria-label="Filter anchorings">
          @for (f of filters; track f.id) {
            <button type="button" class="chip" [class.on]="filter() === f.id" [attr.aria-pressed]="filter() === f.id" (click)="pick(f.id)">
              {{ f.label }} <strong>{{ counts()[f.id] }}</strong>
            </button>
          }
          <app-info-tip label="filters" [text]="tips.filters" />
        </div>

        @if (error(); as e) {
          <div class="note danger" role="alert">{{ e }}</div>
        }
        <div style="overflow-x:auto">
          <table class="table" style="min-width:1040px">
            <thead>
              <tr>
                <th><span class="th">Batch<app-info-tip label="batch" [text]="tips.batch" /></span></th>
                <th><span class="th">Created<app-info-tip label="created" [text]="tips.created" /></span></th>
                <th><span class="th">Covers<app-info-tip label="covers" [text]="tips.covers" /></span></th>
                <th><span class="th">Status<app-info-tip label="status" [text]="tips.status" /></span></th>
                <th><span class="th">Blockchain transaction<app-info-tip label="blockchain transaction" [text]="tips.transaction" /></span></th>
                <th><span class="th">Block<app-info-tip label="block" align="right" [text]="tips.block" /></span></th>
                <th><span class="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.batch) {
                <tr [class.failed]="r.failed">
                  <td><a class="batch" [routerLink]="['/anchorings', r.batch]">{{ r.label }}</a></td>
                  <td>{{ r.created }}</td>
                  <td>{{ r.covers }}</td>
                  <td>
                    <div class="stack" style="gap:4px;align-items:flex-start">
                      <span [class]="r.tagClass">{{ r.status }}</span>
                      @if (r.reason) {
                        <span class="small tone-danger">{{ r.reason }}@if (r.replacedBy) { · <a class="tone-danger" [routerLink]="['/anchorings', r.replacedBy]">replaced by batch {{ r.replacedByLabel }}</a>}</span>
                      }
                      @if (r.replaces) {
                        <span class="small muted">Replaced batch {{ r.replacesLabel }}</span>
                      }
                    </div>
                  </td>
                  <td>
                    @if (r.explorerUrl) {
                      <a class="mono small" [href]="r.explorerUrl" target="_blank" rel="noopener"
                         [attr.aria-label]="'Open the transaction of batch ' + r.label + ' on a blockchain explorer (opens in a new tab)'">{{ r.tx }} ↗</a>
                    } @else if (r.failed) {
                      <span class="muted">Not on the blockchain</span>
                    } @else if (r.tx) {
                      <span class="mono small">{{ r.tx }}</span>
                    }
                  </td>
                  <td><div class="stack" style="gap:0"><span>{{ r.block }}</span><span class="small muted">{{ r.depth }}</span></div></td>
                  <td style="text-align:right">
                    <a class="btn btn-secondary" [routerLink]="['/anchorings', r.batch]" [attr.aria-label]="'Open batch ' + r.label">Open</a>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="muted" style="padding:22px 16px">{{ loading() ? 'Loading…' : error() ? '—' : emptyText() }}</td></tr>
              }
            </tbody>
          </table>
        </div>

        @if (gaps(); as g) {
          <div class="gaps row">
            <strong>Gaps in batch numbers on the blockchain:</strong>
            <span>{{ g }}</span>
            @if (filter() !== 'failed') {
              <button type="button" class="btn btn-secondary" (click)="pick('failed')">Show failed</button>
            }
          </div>
        }

        <nav class="row pager" aria-label="Pages">
          <span class="muted">{{ range() }}</span>
          <div class="row" style="gap:6px">
            <button type="button" class="btn btn-secondary" [disabled]="page() === 1" (click)="page.set(page() - 1)">Newer</button>
            <button type="button" class="btn btn-secondary" [disabled]="page() >= pageCount()" (click)="page.set(page() + 1)">Older</button>
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
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .card { padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
    .kicker { font-size: 12px; font-weight: 600; color: var(--color-neutral-700); text-transform: uppercase; letter-spacing: .04em; }
    .big { font-size: 20px; font-weight: 700; text-decoration: none; }
    .filters { padding: 10px 16px; gap: 8px; border-bottom: 1px solid var(--color-divider); }
    .chip { min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--color-neutral-400, var(--color-divider)); background: var(--color-surface); cursor: pointer; font: inherit; }
    .chip.on { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
    .th { display: inline-flex; align-items: center; }
    .batch { display: flex; align-items: center; min-height: 44px; font-weight: 600; text-decoration: none; }
    tr.failed { background: color-mix(in srgb, var(--danger-bg) 40%, transparent); }
    .tone-danger { color: var(--danger-fg); }
    .gaps { padding: 12px 16px; gap: 6px; border-top: 1px solid var(--color-divider); background: var(--warn-bg); color: var(--warn-fg); flex-wrap: wrap; }
    .pager { padding: 12px 16px; border-top: 1px solid var(--color-divider); justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .note.danger { margin: 10px 16px; padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `]
})
export class AnchoringsListComponent {
  private readonly api = inject(AnchoringsApi);

  protected readonly tips = TIPS;
  protected readonly how = HOW_ANCHORING_WORKS;
  protected readonly filters = FILTERS;
  protected readonly pageSizes = PAGE_SIZES;
  protected readonly journey = JOURNEY.map(j => ({ label: BATCH_STATUS[j.status].label, tagClass: toneClass(BATCH_STATUS[j.status].tone), text: j.text }));

  protected readonly howOpen = signal(false);
  protected readonly filter = signal<BatchFilter>('all');
  protected readonly page = signal(1);
  protected readonly pageSize = signal(PAGE_SIZES[0]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly result = signal<BatchList | null>(null);
  /** The newest batches, for the cards, whatever the filter. */
  private readonly newest = signal<BatchList | null>(null);
  /** The newest failed batches, for the note on gaps. */
  private readonly failed = signal<BatchList | null>(null);
  /** Counts requests, so a slow answer to an earlier page never replaces a newer one. */
  private requestNo = 0;

  protected readonly counts = computed(() => {
    const c = this.newest()?.counts ?? this.result()?.counts ?? { all: 0, progress: 0, failed: 0 };
    return { all: count(c.all), progress: count(c.progress), failed: count(c.failed) };
  });
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil((this.result()?.total ?? 0) / this.pageSize())));
  protected readonly range = computed(() => rangeText(this.filter(), this.page(), this.pageSize(), this.result()?.total ?? 0));
  protected readonly emptyText = computed(() => (this.filter() === 'all' ? MESSAGES.empty : 'No anchorings match.'));

  protected readonly rows = computed(() => {
    const needed = this.result()?.confirmationsNeeded ?? 10;
    return (this.result()?.items ?? []).map(b => this.row(b, needed));
  });

  protected readonly lastConfirmed = computed(() => {
    const b = this.newest()?.items.find(i => i.status === 'confirmed');
    return b ? { batch: b.batch, label: count(b.batch), when: inSentence(b.createdAt), covers: plural(b.covers ?? 0, 'new fingerprint') } : null;
  });

  protected readonly inProgress = computed(() => {
    const list = this.newest();
    const b = list?.items.find(i => i.status === 'sent' || i.status === 'onChain');
    if (!b || !list) {
      return null;
    }
    const s = BATCH_STATUS[b.status];
    return { batch: b.batch, label: count(b.batch), status: s.label, tagClass: toneClass(s.tone), depth: depthText(b.confirmations, list.confirmationsNeeded) };
  });

  protected readonly next = computed(() => {
    const n = this.newest()?.next;
    if (!n) {
      return null;
    }
    const due = aboutTime(n.dueAt);
    return { due: due.charAt(0).toUpperCase() + due.slice(1), waiting: n.waiting ? `${plural(n.waiting, 'new fingerprint')} waiting` : 'Nothing waiting' };
  });

  protected readonly gaps = computed(() => {
    const f = this.failed();
    return f && f.total ? gapNote(f.items.map(i => i.batch), f.total) : null;
  });

  constructor() {
    void this.loadSummary();
    effect(() => {
      void this.load(this.filter(), this.page(), this.pageSize());
    });
  }

  protected pick(filter: BatchFilter): void {
    this.filter.set(filter);
    this.page.set(1);
  }

  protected pickSize(event: Event): void {
    this.pageSize.set(Number((event.target as HTMLSelectElement).value));
    this.page.set(1);
  }

  /** The cards and the note on gaps. Left out when they can't be read: the table says so. */
  private async loadSummary(): Promise<void> {
    try {
      const [newest, failed] = await Promise.all([
        this.api.list({ status: 'all', limit: 10, offset: 0 }),
        this.api.list({ status: 'failed', limit: GAPS_NAMED, offset: 0 })
      ]);
      this.newest.set(newest);
      this.failed.set(failed);
    } catch {
      // the table shows the error
    }
  }

  private async load(filter: BatchFilter, page: number, size: number): Promise<void> {
    const mine = ++this.requestNo;
    this.loading.set(true);
    try {
      const result = await this.api.list({ status: filter, limit: size, offset: (page - 1) * size });
      if (mine === this.requestNo) {
        this.result.set(result);
        this.error.set(null);
      }
    } catch {
      if (mine === this.requestNo) {
        this.error.set(MESSAGES.unreadable);
      }
    } finally {
      if (mine === this.requestNo) {
        this.loading.set(false);
      }
    }
  }

  private row(b: BatchRow, needed: number) {
    const s = BATCH_STATUS[b.status];
    return {
      batch: b.batch,
      label: count(b.batch),
      created: when(b.createdAt),
      covers: coversText(b.covers),
      status: s.label,
      tagClass: toneClass(s.tone),
      failed: b.status === 'failed',
      reason: b.reason ? FAIL_REASON[b.reason].shown : '',
      replacedBy: b.replacedBy,
      replacedByLabel: b.replacedBy ? count(b.replacedBy) : '',
      replaces: b.replaces,
      replacesLabel: b.replaces ? count(b.replaces) : '',
      tx: b.txHash ? shortHash(b.txHash) : '',
      explorerUrl: b.explorerUrl,
      block: b.block ? count(b.block) : '—',
      depth: depthText(b.confirmations, needed)
    };
  }
}
