import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import {DecimalPipe, formatDate} from '@angular/common';
import {RouterLink} from '@angular/router';
import {ToastService, toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import type {BlTitleView} from './bl.model';
import {
  type StepResult,
  type TitleProof,
  anchorDetails,
  checkSteps,
  proofFileName,
  proofStatus,
  signatureLabel,
} from './bl-check';
import {chainRows} from './bl-format';
import {type HistoryRow, historyRows, historySummary} from './bl-history';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {LatestRequest} from './latest';
import {injectViewer} from './viewer';

/**
 * The browser's cryptography, which checks the signatures; none where the page is not served
 * securely.
 * @return it, or null
 */
function browserCrypto(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

/**
 * The full chain of title of a B/L, for auditors and disputes (CB-53, first version of the CB-16
 * design; for the B/L's parties, as "Check this B/L"): every step, the steps of the B/L it was
 * split from included, exceptions marked, each checked in the browser against the platform's
 * signature and placed on the blockchain through the latest step. Route `bls/:id/history`.
 */
@Component({
  selector: 'app-bl-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink],
  template: `
    <div class="page stack">
      <p style="margin:0"><a [routerLink]="['/bls', id()]">Back to the B/L</a></p>
      <h1>Chain of title{{ label() ? ': ' + label() : '' }}</h1>
      @if (error(); as e) {
        <div class="note danger" role="alert">{{ e }}</div>
      }
      @if (busy()) {
        <p class="muted" role="status">Checking every step…</p>
      }
      @if (proof() !== null) {
        <p [class]="summaryClass()" role="status" style="margin:0">{{ summary() }}</p>
        @if (anchor(); as a) {
          <section class="panel" aria-labelledby="history-anchor-title">
            <div class="panel-head"><h2 id="history-anchor-title">Blockchain anchoring</h2></div>
            <div style="padding:16px">
              <dl class="kv" style="margin:0">
                <dt>Status</dt>
                <dd>{{ anchorStatusLabel() }}</dd>
                @if (!a.pending) {
                  @if (a.batch !== null) {
                    <dt>Batch</dt>
                    <dd>{{ a.batch }}@if (a.size !== null) { ({{ a.size }} {{ a.size === 1 ? 'entry' : 'entries' }})}</dd>
                  }
                  @if (a.tx; as tx) {
                    <dt>Transaction ID</dt>
                    <dd class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
                      <span class="mono" [title]="tx">{{ a.txShort }}</span>
                      <button type="button" class="btn btn-secondary btn-xs" (click)="copyTx(tx)">Copy</button>
                      @if (a.explorerUrl; as url) {
                        <a class="btn btn-secondary btn-xs" [href]="url" target="_blank" rel="noopener noreferrer">View on explorer</a>
                      }
                    </dd>
                  }
                  @if (a.block !== null) {
                    <dt>Block</dt>
                    <dd>{{ a.block | number }}@if (a.confirmations !== null) { ({{ a.confirmations }} {{ a.confirmations === 1 ? 'confirmation' : 'confirmations' }})}</dd>
                  }
                  @if (a.confirmedAt; as confirmedAt) {
                    <dt>Confirmed at</dt>
                    <dd>{{ when(confirmedAt) }}</dd>
                  }
                  @if (a.network !== null) {
                    <dt>Network</dt>
                    <dd>{{ a.network }}@if (a.label !== null) { · metadata label {{ a.label }}}</dd>
                  }
                }
              </dl>
            </div>
          </section>
        }
        <section class="panel">
          <div class="panel-head row" style="justify-content:space-between;gap:8px">
            <h2>Every step</h2>
            <button type="button" class="btn btn-secondary" (click)="download()">Download the proof</button>
          </div>
          <div style="overflow-x:auto">
            <table class="table" aria-label="Full chain of title">
              <thead>
                <tr><th>B/L</th><th>Step</th><th>What</th><th>From</th><th>To</th><th>By</th><th>When</th><th>Signature</th><th>Blockchain</th></tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.key) {
                  <tr [class.exception]="r.exception">
                    <td>{{ r.part === 'parent' ? parentLabel() : 'This B/L' }}</td>
                    <td>{{ r.seq }}</td>
                    <td>{{ r.step }}@if (r.exception) { <span class="tag">Exception</span> }</td>
                    <td>{{ r.from }}</td>
                    <td>{{ r.to }}</td>
                    <td>{{ r.by }}</td>
                    <td>{{ when(r.at) }}</td>
                    <td [class]="'sig-' + r.check">{{ r.signature }}</td>
                    <td>{{ r.blockchain }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
        <p class="small muted" style="margin:0">Each step carries the platform's signature and the fingerprint of the step before it, so the latest step's record on the blockchain also vouches for every earlier step. The proof file can be checked offline, without the platform: see "Check this B/L" on the B/L's page.</p>
      }
    </div>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    h1 { margin: 0; font-size: 22px; }
    .panel-head h2 { margin: 0; font-size: 18px; }
    tr.exception td { background: var(--color-surface-2); }
    .tag { margin-left: 6px; font-size: 12px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--color-divider); }
    .sig-checked { color: var(--success-fg, inherit); }
    .sig-failed { color: var(--danger-fg); font-weight: 600; }
    .btn-xs { padding: 4px 10px; font-size: 13px; }
  `,
  ],
})
export class BlHistoryComponent {
  /** The B/L, from the route. */
  readonly id = input.required<string>();

  private readonly bls = inject(BlApi);
  private readonly toast = inject(ToastService);
  private readonly locale = inject(LOCALE_ID);
  private readonly viewer = injectViewer();
  private readonly latest = new LatestRequest();

  protected readonly view = signal<BlTitleView | null>(null);
  protected readonly proof = signal<TitleProof | null>(null);
  protected readonly parentChecks = signal<StepResult[]>([]);
  protected readonly ownChecks = signal<StepResult[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly label = computed(() => this.view()?.record.label ?? '');
  protected readonly parentLabel = computed(() => {
    const from = this.view()?.splitFrom;
    return from
      ? `B/L ${from.recordNo} (before the split)`
      : 'Before the split';
  });
  protected readonly status = computed(() => proofStatus(this.proof()?.anchor));
  protected readonly anchor = computed(() =>
    anchorDetails(this.proof()?.anchor),
  );
  protected readonly anchorStatusLabel = computed(() => {
    const state = this.status().state;
    if (state === 'confirmed') {
      return 'Confirmed on blockchain';
    }
    if (state === 'recorded') {
      return 'Written to blockchain, waiting for confirmation';
    }
    return 'Pending: waiting for the next anchoring batch';
  });
  protected readonly rows = computed<HistoryRow[]>(() => {
    const proof = this.proof();
    const view = this.view();
    if (proof === null) {
      return [];
    }
    const names = view?.organisationNames ?? {};
    const viewer = this.viewer();
    const parentEntries = proof.parent?.entries ?? [];
    return historyRows(
      [
        {
          part: 'parent',
          entries: parentEntries,
          words: chainRows(parentEntries, viewer, names),
          results: this.parentChecks(),
        },
        {
          part: 'this',
          entries: proof.entries,
          words: chainRows(proof.entries, viewer, names),
          results: this.ownChecks(),
        },
      ],
      this.status(),
      {
        names,
        date: at => this.when(at),
        signature: signatureLabel,
      },
    );
  });
  protected readonly summary = computed(() =>
    historySummary(this.rows(), this.status()),
  );
  protected readonly summaryClass = computed(() =>
    this.rows().some(row => row.check === 'failed')
      ? 'note danger'
      : 'note info',
  );

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        void this.load(id);
      });
    });
  }

  /**
   * A time for people.
   * @param at ISO 8601
   * @return e.g. "16 Nov 2026, 09:00"
   */
  protected when(at: string): string {
    return formatDate(at, 'd MMM y, HH:mm', this.locale);
  }

  /** Copies a blockchain transaction ID to the clipboard (CB-77). */
  protected async copyTx(tx: string): Promise<void> {
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }
      await clipboard.writeText(tx);
      this.toast.show(
        'success',
        'Copied transaction ID',
        tx.slice(0, 12) + '…',
      );
    } catch {
      this.toast.show('info', 'Copy transaction ID manually', tx);
    }
  }

  /** Saves the proof file, named with the B/L's number. */
  protected download(): void {
    const proof = this.proof();
    if (proof === null) {
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(proof, null, 2)], {type: 'application/json'}),
    );
    link.download = proofFileName(proof.recordNo);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
    }, 10_000);
  }

  /**
   * Reads the B/L and its proof file and checks every step in the browser, the parent's too.
   * @param id the B/L
   * @return when it is shown
   */
  private async load(id: string): Promise<void> {
    const request = this.latest.begin();
    this.busy.set(true);
    this.error.set(null);
    try {
      const [view, proof] = await Promise.all([
        this.bls.title(id),
        this.bls.proof(id),
      ]);
      const crypto = browserCrypto();
      const parentEntries = proof.parent?.entries ?? [];
      const parentChecks = await checkSteps(parentEntries, proof.jwks, crypto, {
        recordId: parentEntries[0]?.recordId ?? '',
        startPreviousHash: parentEntries[0]?.previousHash ?? null,
      });
      const ownChecks = await checkSteps(proof.entries, proof.jwks, crypto, {
        recordId: id,
        startPreviousHash: parentEntries.at(-1)?.entryHash ?? null,
      });
      if (!this.latest.isCurrent(request)) {
        return;
      }
      this.view.set(view);
      this.proof.set(proof);
      this.parentChecks.set(parentChecks);
      this.ownChecks.set(ownChecks);
    } catch (e) {
      if (this.latest.isCurrent(request)) {
        this.error.set(toApiError(e).message);
      }
    } finally {
      if (this.latest.isCurrent(request)) {
        this.busy.set(false);
      }
    }
  }
}
