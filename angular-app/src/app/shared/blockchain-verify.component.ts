import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import {AuditApi, ProofKind} from '../api/audit.api';
import {
  VERIFY_TIPS,
  VerifyResult,
  checkLines,
  verifySummary,
} from '../features/audit/verify-wording';
import {RbacService} from '../state/rbac.service';
import {InfoTipComponent} from './info-tip.component';

/** The mark shown for each outcome. */
const MARK = {passed: '✓', failed: '✕', unknown: '?'} as const;

/**
 * "Verify against the blockchain" for one version (API-675): runs POST /audit/verify and shows each
 * check (fingerprint recomputed, in the batch, batch in the transaction) with why when it did not
 * pass, and the transaction with a link to a public blockchain explorer. For `audit.view` only.
 *
 *   <app-blockchain-verify kind="document-version" [itemId]="documentId" [version]="1" />
 */
@Component({
  selector: 'app-blockchain-verify',
  imports: [InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (canView()) {
      <div class="bv">
        <span class="row" style="gap:0;align-items:center">
          <button type="button" class="btn btn-secondary btn-sm" [disabled]="busy()" (click)="run()">{{ busy() ? 'Checking…' : 'Verify against the blockchain' }}</button>
          <app-info-tip label="verify against the blockchain" align="right" [text]="tips.blockchain" />
        </span>
        @if (error(); as e) { <span class="small tone-danger" role="alert">{{ e }}</span> }
        @if (view(); as v) {
          <div class="result" role="status" [class]="'result tone-' + v.tone">
            <strong>{{ v.summary }}</strong>
            <ul>
              @for (l of v.lines; track l.label) {
                <li><span class="mark" [class]="'mark ' + l.outcome" aria-hidden="true">{{ mark[l.outcome] }}</span>
                  <span class="stack" style="gap:0"><span>{{ l.label }}</span>@if (l.outcome !== 'passed') { <span class="small">{{ l.text }}</span> }</span></li>
              }
            </ul>
            @if (v.tx) {
              <span class="small">Blockchain transaction
                @if (v.explorerUrl) {
                  <a class="mono" [href]="v.explorerUrl" target="_blank" rel="noopener">{{ v.txShort }} ↗<span class="sr-only"> (opens a public blockchain explorer in a new tab)</span></a>
                } @else { <span class="mono">{{ v.txShort }}</span> }
              </span>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
    .bv { display: flex; flex-direction: column; gap: 6px; }
    .btn-sm { min-height: 32px; padding: 0 10px; font-size: 13px; }
    .result { border: 1px solid var(--color-divider); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
    .result.tone-success { background: var(--success-bg); border-color: var(--success-bd); }
    .result.tone-danger { background: var(--danger-bg); border-color: var(--danger-bd); }
    .result.tone-warn { background: var(--warn-bg); border-color: var(--warn-bd); }
    .result ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .result li { display: flex; gap: 8px; align-items: flex-start; }
    .mark { width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; font-weight: 700; flex: none; }
    .mark.passed { background: var(--success); color: #fff; }
    .mark.failed { background: var(--danger); color: #fff; }
    .mark.unknown { background: var(--color-neutral-300, #ccd); }
    .tone-danger { color: var(--danger-fg); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
  ],
})
export class BlockchainVerifyComponent {
  private readonly audit = inject(AuditApi);
  private readonly rbac = inject(RbacService);

  /** What is checked. */
  readonly kind = input.required<ProofKind>();
  /** The land record's or document's id. */
  readonly itemId = input.required<string>();
  /** The version. */
  readonly version = input.required<number>();

  protected readonly tips = VERIFY_TIPS;
  protected readonly mark = MARK;
  protected readonly canView = computed(() => this.rbac.can('audit.view'));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly result = signal<VerifyResult | null>(null);

  protected readonly view = computed(() => {
    const r = this.result();
    if (!r) {
      return null;
    }
    const summary = verifySummary(r);
    const tx = r.proof.anchor?.tx ?? null;
    return {
      summary: summary.text,
      tone: summary.tone,
      lines: checkLines(r),
      tx,
      txShort: tx ? `${tx.slice(0, 8)}…${tx.slice(-8)}` : '',
      explorerUrl: r.explorerUrl,
    };
  });

  protected async run(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.result.set(
        await this.audit.verify(this.kind(), this.itemId(), this.version()),
      );
    } catch (e) {
      this.result.set(null);
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
