import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AnchoringsApi, BatchCoverage, BatchDetail, BatchDocument } from '../../api/anchorings.api';
import { InfoTipComponent } from '../../shared/info-tip.component';
import { RbacService } from '../../state/rbac.service';
import {
  BATCH_STATUS, FAIL_REASON, MESSAGES, TIPS, batchSteps, batchSummary, count, depthText, documentVersionText, madeOf,
  inSentence, plural, rangeLabel, toneClass, usedInText, when
} from './anchorings-wording';

/** How many land records and documents a page of the batch shows. */
const PAGE = 25;

/** One fact of "What is on the blockchain" or "What was prepared". */
interface Fact {
  label: string;
  value: string;
  mono: boolean;
  tip: string;
  note?: string;
  link?: { text: string; batch: number };
}

/**
 * One batch (`#/anchorings/:batch`, API-698, design API-688 boards 2 and 3), for every signed-in
 * user: its steps, what is on the blockchain with the explorer link, what it covers (land records and
 * documents) and how to check it yourself. A failed batch shows why, the batch that replaced it and
 * what was prepared. "Open audit" is shown to whoever can open the Audit screen (`audit.view`), and
 * the evidence pack step to whoever can export it (`audit.export`).
 */
@Component({
  selector: 'app-anchoring-batch',
  imports: [NgTemplateOutlet, RouterLink, InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <nav aria-label="Breadcrumb" class="small muted row" style="gap:6px">
        <a routerLink="/anchorings">Anchorings</a><span aria-hidden="true">›</span><span aria-current="page">Batch {{ label() }}</span>
      </nav>

      @if (error(); as e) {
        <div class="note danger" role="alert">{{ e }}</div>
      }

      @if (view(); as v) {
        <div class="row head">
          <div class="stack" style="gap:6px">
            <div class="row" style="gap:12px">
              <h1>Batch {{ v.label }}</h1>
              <span [class]="v.tagClass">{{ v.status }}</span>
            </div>
            <p class="muted" style="margin:0">{{ v.summary }}</p>
          </div>
          <div class="row" style="gap:8px">
            @if (v.previousBatch) { <a class="btn btn-secondary nav" [routerLink]="['/anchorings', v.previousBatch]">← Batch {{ v.previousLabel }}</a> }
            @if (v.nextBatch) { <a class="btn btn-secondary nav" [routerLink]="['/anchorings', v.nextBatch]">Batch {{ v.nextLabel }} →</a> }
          </div>
        </div>

        @if (v.failed) {
          <div class="failed-box" role="status">
            <strong style="font-size:16px">This batch never reached the blockchain</strong>
            <span><strong>Reason:</strong> {{ v.reason }}</span>
            @if (v.replacement?.landed) {
              <span><strong>Nothing was lost.</strong> Batch {{ v.replacement.label }} replaced it and covers every fingerprint this batch would have covered, plus those made since.</span>
            } @else {
              <span><strong>Nothing is lost.</strong> The next batch replaces it and covers every fingerprint this batch would have covered.</span>
            }
          </div>
        }

        <section class="panel steps" [attr.aria-label]="v.failed ? 'What happened' : 'Progress'">
          <ol>
            @for (s of v.steps; track s.title) {
              <li>
                <span class="dot" [class]="'dot ' + s.state" aria-hidden="true">{{ s.state === 'failed' ? '✕' : s.state === 'done' ? '✓' : '' }}</span>
                <span class="stack" style="gap:2px"><strong>{{ s.title }}</strong><span class="small">{{ s.when }}</span><span class="small muted">{{ s.note }}</span></span>
              </li>
            }
          </ol>
        </section>

        <div class="cols">
          <div class="main stack" style="gap:18px">
            @if (v.failed) {
              @if (v.replacement) {
                <section class="panel replaced">
                  <div class="stack" style="gap:4px">
                    <span class="kicker th">Replaced by<app-info-tip label="replaced by" [text]="tips.replacedBy" /></span>
                    <span class="row" style="gap:10px"><span class="big">Batch {{ v.replacement.label }}</span><span [class]="v.replacement.tagClass">{{ v.replacement.status }}</span></span>
                    <span>Created {{ v.replacement.when }}</span>
                  </div>
                  <a class="btn btn-primary nav" [routerLink]="['/anchorings', v.replacement.batch]">Open batch {{ v.replacement.label }}</a>
                </section>
              }
              <section class="panel">
                <div class="panel-head stack" style="align-items:flex-start;gap:4px">
                  <h2 class="th">What was prepared<app-info-tip label="what was prepared" [text]="tips.prepared" /></h2>
                  <span class="muted">Never on the blockchain</span>
                </div>
                <ng-container *ngTemplateOutlet="facts; context: { $implicit: v.facts }" />
              </section>
            } @else {
              <section class="panel">
                <div class="panel-head">
                  <h2 class="th">What is on the blockchain<app-info-tip label="what is on the blockchain" [text]="tips.onChain" /></h2>
                  @if (v.explorerUrl) {
                    <a class="btn btn-primary" [href]="v.explorerUrl" target="_blank" rel="noopener">{{ messages.explorer }}<span class="sr-only"> (opens in a new tab)</span></a>
                  }
                </div>
                <ng-container *ngTemplateOutlet="facts; context: { $implicit: v.facts }" />
              </section>

              <section class="panel" aria-labelledby="covers-title">
                <div class="panel-head stack" style="align-items:flex-start;gap:4px">
                  <h2 id="covers-title" class="th">What it covers<app-info-tip label="what it covers" [text]="tips.covered" /></h2>
                  <span>{{ coversLine() }}</span>
                </div>
                @if (coverage(); as c) {
                  <div class="kinds">
                    <div><span class="n">{{ fmt(c.kinds.recordVersions) }}</span><span>land record versions</span></div>
                    <div><span class="n">{{ fmt(c.kinds.documentVersions) }}</span><span>documents</span></div>
                    <div><span class="n">{{ fmt(c.kinds.signoffs) }}</span><span>audit sign-offs</span></div>
                    @if (c.trailUpTo) {
                      <div><span class="n">{{ fmt(c.trailUpTo) }}</span><span>last audit trail entry covered</span></div>
                    }
                  </div>
                  <div style="overflow-x:auto">
                    <table class="table" style="min-width:640px">
                      <thead>
                        <tr>
                          <th>Land record</th>
                          <th>Version</th>
                          <th><span class="th">Made of<app-info-tip label="made of" [text]="tips.madeOf" /></span></th>
                          <th>Audit sign-off</th>
                          @if (canAudit()) { <th><span class="sr-only">Open audit</span></th> }
                        </tr>
                      </thead>
                      <tbody>
                        @for (r of records(); track r.recordId) {
                          <tr>
                            <td><div class="stack" style="gap:0"><strong>{{ r.label }}</strong><span class="small muted">{{ r.recordNo }}</span></div></td>
                            <td><strong>{{ r.versions }}</strong></td>
                            <td>
                              @for (m of r.madeOf; track $index) {
                                <div class="stack" style="gap:0"><span>@if (m.version) {<strong>{{ m.version }}</strong>}{{ m.text }}</span><span class="small muted">{{ m.note }}</span></div>
                              } @empty { — }
                            </td>
                            <td>{{ r.signoffs }}</td>
                            @if (canAudit()) {
                              <td style="text-align:right">
                                <a class="btn btn-secondary" [routerLink]="['/audit/records', r.recordId]" [attr.aria-label]="'Open the audit of ' + r.label">Open audit</a>
                              </td>
                            }
                          </tr>
                        } @empty {
                          <tr><td [attr.colspan]="canAudit() ? 5 : 4" class="muted" style="padding:18px 16px">No land record versions or audit sign-offs in this batch.</td></tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  @if (c.total > records().length) {
                    <div class="more">Showing {{ records().length }} of {{ plural(c.total, 'land record') }} ·
                      <button type="button" class="link" [disabled]="loadingMore()" (click)="moreRecords()">Show more</button></div>
                  }
                }
              </section>

              <section class="panel" aria-labelledby="docs-title">
                <div class="panel-head stack" style="align-items:flex-start;gap:4px">
                  <h2 id="docs-title" class="th">Documents in this batch<app-info-tip label="documents in this batch" [text]="tips.documents" /></h2>
                  <span>{{ documentsLine() }}</span>
                </div>
                <div style="overflow-x:auto">
                  <table class="table" style="min-width:640px">
                    <thead><tr><th>Document</th><th>Type</th><th>Version</th><th>In a land record version in this batch</th></tr></thead>
                    <tbody>
                      @for (d of documentRows(); track d.key) {
                        <tr>
                          <td><div class="stack" style="gap:0"><strong class="mono small">{{ d.no }}</strong><span class="small muted">{{ d.ref }}</span></div></td>
                          <td>{{ d.type }}</td>
                          <td>{{ d.version }}</td>
                          <td [class.muted]="!d.used">{{ d.usedIn }}</td>
                        </tr>
                      } @empty {
                        <tr><td colspan="4" class="muted" style="padding:18px 16px">No new documents in this batch.</td></tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (documentsTotal() > documents().length) {
                  <div class="more">Showing {{ documents().length }} of {{ plural(documentsTotal(), 'document') }} ·
                    <button type="button" class="link" [disabled]="loadingMore()" (click)="moreDocuments()">Show more</button></div>
                }
              </section>
            }
          </div>

          <aside class="side stack" style="gap:18px">
            @if (v.failed) {
              <section class="panel why">
                <h2>Why batch {{ v.label }} is missing on the blockchain</h2>
                @if (v.prevLabel && v.replacement?.landed) {
                  <span>On the blockchain you will see batch {{ v.prevLabel }} followed directly by batch {{ v.replacement.label }}.</span>
                  <span>The chain is still unbroken: batch {{ v.replacement.label }}’s “prev” is the combined fingerprint of batch {{ v.prevLabel }}, the last batch that got there.</span>
                } @else {
                  <span>Its number never appears on the blockchain. The batch that replaces it points back to the last batch that did get there, so the chain has no break.</span>
                }
                <span>Batch {{ v.label }} is listed here so that the gap is explained and nothing is hidden.</span>
              </section>
              <section class="panel side-card">
                <h2>Does this affect an audit?</h2>
                <span class="muted">No. Land records and documents that were waiting for batch {{ v.label }} went out with {{ v.replacement?.landed ? 'batch ' + v.replacement.label : 'the next batch that got there' }}, a little later than usual. Their proof status shows Waiting for next batch until then.</span>
              </section>
            } @else {
              <section class="panel side-card">
                <h2>Check it yourself</h2>
                <p>You don’t have to trust the portal for this. Anyone can check it on the blockchain.</p>
                <ol>
                  <li>Open the transaction on a @if (v.explorerUrl) { <a [href]="v.explorerUrl" target="_blank" rel="noopener">blockchain explorer ↗</a> } @else { blockchain explorer }.</li>
                  <li>Look at its metadata under label <strong>8890</strong>. Compare batch, root, size and prev with the values on this page.</li>
                  @if (v.prevLabel) {
                    <li>Check that <strong>prev</strong> is the root of batch {{ v.prevLabel }}. That proves no batch is missing in between.</li>
                  } @else {
                    <li>This is the first batch, so it has no <strong>prev</strong>.</li>
                  }
                  @if (canExport()) {
                    <li>To prove that a particular land record version or document is inside this batch, export the land record’s evidence pack from its audit page and run the offline checker.</li>
                  }
                </ol>
              </section>
              <section class="trust">
                <strong>Why trust the explorer?</strong>
                <span>It is a public website run independently of the registry. It reads the blockchain directly, so what it shows can’t be changed by the portal.</span>
              </section>
            }
          </aside>
        </div>
      } @else if (!error()) {
        <p class="muted">Loading…</p>
      }
    </div>

    <ng-template #facts let-facts>
      <dl class="facts">
        @for (f of facts; track f.label) {
          <dt><span class="th">{{ f.label }}@if (f.tip) {<app-info-tip [label]="f.label" [text]="f.tip" />}</span></dt>
          <dd>
            <span [class.mono]="f.mono" [class.strong]="!f.mono">{{ f.value }}</span>
            @if (f.note) { <span class="small muted">{{ f.note }}</span> }
            @if (f.link) { <a class="small" [routerLink]="['/anchorings', f.link.batch]">{{ f.link.text }}</a> }
          </dd>
        }
      </dl>
    </ng-template>
  `,
  styles: [`
    .head { justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 36px; line-height: 1.1; }
    h2 { margin: 0; font-size: 18px; }
    .th { display: inline-flex; align-items: center; }
    .nav { min-height: 44px; display: inline-flex; align-items: center; }
    .note { padding: 14px 16px; border: 1px solid var(--color-divider); border-radius: 10px; background: var(--color-surface-2); }
    .note.danger { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger-bd); }
    .failed-box { background: var(--danger-bg); border: 1px solid var(--danger-bd); border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; color: var(--danger-fg); }
    .steps { padding: 18px 20px; }
    .steps ol { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .steps li { display: flex; gap: 10px; align-items: flex-start; }
    .dot { flex: none; width: 28px; height: 28px; border-radius: 50%; display: inline-grid; place-items: center; font-weight: 700; font-size: 14px; }
    .dot.done { background: var(--color-accent); color: #fff; }
    .dot.failed { background: var(--danger); color: #fff; }
    .dot.todo { border: 2px dashed var(--color-neutral-400, var(--color-divider)); }
    .cols { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
    .main { flex: 999 1 640px; min-width: 0; }
    .side { flex: 1 1 340px; min-width: 0; }
    .facts { margin: 0; padding: 6px 18px 14px; display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); column-gap: 18px; }
    .facts dt { padding: 10px 0; border-top: 1px solid var(--color-divider); color: var(--color-neutral-700); }
    .facts dd { margin: 0; padding: 10px 0; border-top: 1px solid var(--color-divider); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .facts .mono { word-break: break-all; font-size: 13px; }
    .strong { font-weight: 600; }
    .kinds { padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; border-bottom: 1px solid var(--color-divider); }
    .kinds div { background: var(--color-surface-2); border: 1px solid var(--color-divider); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; }
    .kinds .n { font-size: 22px; font-weight: 700; }
    .more { padding: 12px 18px; border-top: 1px solid var(--color-divider); color: var(--color-neutral-700); }
    .link { border: 0; background: transparent; color: var(--color-accent-700); padding: 0; font: inherit; cursor: pointer; text-decoration: underline; min-height: 32px; }
    .replaced { padding: 16px 18px; border: 2px solid var(--color-accent); display: flex; flex-wrap: wrap; gap: 14px; align-items: center; justify-content: space-between; }
    .kicker { font-size: 12px; font-weight: 600; color: var(--color-neutral-700); text-transform: uppercase; letter-spacing: .04em; }
    .big { font-size: 20px; font-weight: 700; }
    .side-card { padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
    .side-card p { margin: 0; }
    .side-card ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
    .why { padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; background: var(--warn-bg); border-color: var(--warn-bd); color: var(--warn-fg); }
    .trust { background: var(--color-accent-100); border: 1px solid var(--color-accent-200, var(--color-divider)); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `]
})
export class AnchoringBatchComponent {
  private readonly api = inject(AnchoringsApi);
  private readonly rbac = inject(RbacService);

  protected readonly tips = TIPS;
  protected readonly messages = MESSAGES;
  protected readonly plural = plural;
  protected readonly fmt = count;
  protected readonly canAudit = computed(() => this.rbac.can('audit.view'));
  protected readonly canExport = computed(() => this.rbac.can('audit.export'));

  private readonly batch = signal(0);
  protected readonly label = computed(() => count(this.batch()));
  protected readonly error = signal<string | null>(null);
  private readonly detail = signal<BatchDetail | null>(null);
  protected readonly coverage = signal<BatchCoverage | null>(null);
  private readonly coveredRecords = signal<BatchCoverage['records']>([]);
  protected readonly documents = signal<BatchDocument[]>([]);
  protected readonly documentsTotal = signal(0);
  private readonly typeLabels = signal(new Map<string, string>());
  /** Counts the batches opened, so a slow answer for the previous batch never shows on this one. */
  private requestNo = 0;
  /** A further page of land records or documents is loading. */
  protected readonly loadingMore = signal(false);

  protected readonly view = computed(() => {
    const d = this.detail();
    if (!d) {
      return null;
    }
    const now = new Date();
    const s = BATCH_STATUS[d.status];
    const replacement = d.replacement
      ? { batch: d.replacement.batch, label: count(d.replacement.batch), status: BATCH_STATUS[d.replacement.status].label,
          tagClass: toneClass(BATCH_STATUS[d.replacement.status].tone), when: inSentence(d.replacement.createdAt, now),
          landed: d.replacement.status !== 'failed' }
      : null;
    const reason = d.reason ? FAIL_REASON[d.reason] : null;
    return {
      label: count(d.batch),
      status: s.label,
      tagClass: toneClass(s.tone),
      summary: batchSummary(d, now),
      failed: d.status === 'failed',
      reason: reason ? `${reason.shown}. ${reason.text}` : '',
      replacement,
      steps: batchSteps(d, now),
      explorerUrl: d.explorerUrl,
      previousBatch: d.previousBatch,
      previousLabel: d.previousBatch ? count(d.previousBatch) : '',
      nextBatch: d.nextBatch,
      nextLabel: d.nextBatch ? count(d.nextBatch) : '',
      prevLabel: d.prev?.batch ? count(d.prev.batch) : '',
      facts: d.status === 'failed' ? this.preparedFacts(d) : this.chainFacts(d)
    };
  });

  protected readonly coversLine = computed(() => {
    const d = this.detail();
    const c = this.coverage();
    if (!d || d.covers === null) {
      return '';
    }
    const since = d.prev?.batch ? ` since batch ${count(d.prev.batch)}` : '';
    const trail = c?.trailUpTo ? `, and the audit trail up to entry ${count(c.trailUpTo)}` : '';
    return `${plural(d.covers, 'new fingerprint')}${since}${trail}.`;
  });

  protected readonly documentsLine = computed(() => {
    const d = this.detail();
    const since = d?.prev?.batch ? ` since batch ${count(d.prev.batch)}` : '';
    return `${plural(this.documentsTotal(), 'document version')}, filed or corrected${since}.`;
  });

  protected readonly records = computed(() => this.coveredRecords().map(r => ({
    recordId: r.recordId,
    label: r.label ?? r.recordNo ?? 'A land record no longer listed',
    recordNo: r.label ? r.recordNo ?? '' : '',
    versions: r.versions.map(v => `v${v.versionNumber}`).join(', ') || '—',
    madeOf: r.versions.map(v => ({ version: r.versions.length > 1 ? `v${v.versionNumber}: ` : '', ...madeOf(v) })),
    signoffs: r.signoffs.map(s => rangeLabel(s.from, s.to)).join(', ') || '—'
  })));

  protected readonly documentRows = computed(() => {
    const labels = this.typeLabels();
    return this.documents().map(d => ({
      key: `${d.documentId}:${d.version}`,
      no: d.edrmsNo ?? 'Number not recorded',
      ref: d.ref ?? '',
      type: (d.docType && labels.get(d.docType)) || '—',
      version: documentVersionText(d.version),
      used: d.usedIn.length > 0,
      usedIn: usedInText(d.usedIn)
    }));
  });

  constructor() {
    this.api.documentTypes().then(t => this.typeLabels.set(t)).catch(() => {});
    inject(ActivatedRoute).paramMap.pipe(takeUntilDestroyed()).subscribe(p => void this.open(Number(p.get('batch'))));
  }

  protected async moreRecords(): Promise<void> {
    await this.loadMore(async () => {
      const page = await this.api.coverage(this.batch(), PAGE, this.coveredRecords().length);
      return () => this.coveredRecords.set([...this.coveredRecords(), ...page.records]);
    });
  }

  protected async moreDocuments(): Promise<void> {
    await this.loadMore(async () => {
      const page = await this.api.documents(this.batch(), PAGE, this.documents().length);
      return () => this.documents.set([...this.documents(), ...page.items]);
    });
  }

  /**
   * One more page of land records or documents: one at a time, and dropped when another batch was
   * opened meanwhile. `read` loads the page and returns how to add it.
   */
  private async loadMore(read: () => Promise<() => void>): Promise<void> {
    if (this.loadingMore()) {
      return;
    }
    const mine = this.requestNo;
    this.loadingMore.set(true);
    try {
      const add = await read();
      if (mine === this.requestNo) {
        add();
      }
    } catch {
      if (mine === this.requestNo) {
        this.error.set(MESSAGES.unreadable);
      }
    } finally {
      this.loadingMore.set(false);
    }
  }

  private async open(batch: number): Promise<void> {
    const mine = ++this.requestNo;
    this.batch.set(batch);
    this.detail.set(null);
    this.coverage.set(null);
    this.coveredRecords.set([]);
    this.documents.set([]);
    this.documentsTotal.set(0);
    this.error.set(null);
    try {
      const detail = await this.api.detail(batch);
      if (mine !== this.requestNo) {
        return;
      }
      this.detail.set(detail);
      if (detail.status === 'failed') {
        return;
      }
      const [coverage, documents] = await Promise.all([this.api.coverage(batch, PAGE, 0), this.api.documents(batch, PAGE, 0)]);
      if (mine === this.requestNo) {
        this.coverage.set(coverage);
        this.coveredRecords.set(coverage.records);
        this.documents.set(documents.items);
        this.documentsTotal.set(documents.total);
      }
    } catch (e) {
      if (mine === this.requestNo) {
        this.error.set((e as { status?: number }).status === 404 ? `There is no batch ${count(batch)}.` : MESSAGES.unreadable);
      }
    }
  }

  /** What the transaction holds and where it is. */
  private chainFacts(d: BatchDetail): Fact[] {
    const now = new Date();
    const newInBatch = d.covers === null ? '' : ` ${count(d.covers)} of them ${d.covers === 1 ? 'is' : 'are'} new in this batch.`;
    const facts: Fact[] = [
      { label: 'Batch', value: count(d.batch), mono: false, tip: TIPS.factBatch },
      { label: 'Combined fingerprint', value: d.root, mono: true, note: 'Written on the blockchain as "root"', tip: TIPS.root },
      { label: 'Fingerprints included', value: count(d.size), mono: false, note: 'Written on the blockchain as "size"', tip: TIPS.size + newInBatch },
      d.prev
        ? { label: 'Previous batch’s combined fingerprint', value: d.prev.root, mono: true, note: 'Written on the blockchain as "prev"', tip: TIPS.prev,
            link: d.prev.batch ? { text: `Batch ${count(d.prev.batch)}`, batch: d.prev.batch } : undefined }
        : { label: 'Previous batch’s combined fingerprint', value: 'None: this is the first batch', mono: false, tip: TIPS.prev },
      { label: 'Blockchain transaction', value: d.txHash ?? '—', mono: !!d.txHash, tip: TIPS.factTransaction }
    ];
    if (d.block) {
      facts.push({ label: 'Block', value: count(d.block), mono: false, note: when(d.steps.onChainAt, now), tip: TIPS.factBlock });
    }
    if (d.confirmations !== null) {
      facts.push({
        label: 'Confirmations', value: d.confirmations >= d.confirmationsNeeded ? `${d.confirmationsNeeded}+` : count(d.confirmations), mono: false,
        note: d.steps.confirmedAt ? `Confirmed ${inSentence(d.steps.confirmedAt, now)}` : depthText(d.confirmations, d.confirmationsNeeded), tip: TIPS.confirmations
      });
    }
    return facts;
  }

  /** The values a failed batch would have written. */
  private preparedFacts(d: BatchDetail): Fact[] {
    return [
      { label: 'Batch', value: count(d.batch), mono: false, tip: TIPS.factBatch },
      { label: 'Combined fingerprint (root)', value: d.root, mono: true, tip: TIPS.root },
      { label: 'Fingerprints included (size)', value: count(d.size), mono: false, tip: TIPS.size },
      { label: 'Previous combined fingerprint (prev)', value: d.prev?.batch ? `Batch ${count(d.prev.batch)}` : d.prev ? d.prev.root : 'None: it would have been the first batch', mono: !!d.prev && !d.prev.batch, tip: TIPS.prev },
      { label: 'Blockchain transaction', value: MESSAGES.notOnChain, mono: false, tip: TIPS.preparedTransaction }
    ];
  }
}
