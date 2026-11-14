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
import {formatDate} from '@angular/common';
import {ProofApi, toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {
  type KeyCheck,
  type StepResult,
  type TitleProof,
  checkSteps,
  checkSummary,
  keyCheck,
  keyNote,
  splitNote,
  proofFileName,
  proofStatus,
  signatureLabel,
  statusSentence,
  verifyCommand,
} from './bl-check';
import {chainRows} from './bl-format';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {LatestRequest} from './latest';
import {injectViewer} from './viewer';

/** Where the offline verifier is downloaded from (the audit service, no sign-in). */
const VERIFIER_URL = '/api/audit/verifier/lrfe-verify.mjs';

/**
 * The browser's cryptography, which checks the signatures; none where the page is not served
 * securely.
 * @return it, or null
 */
function browserCrypto(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

/**
 * "Check this B/L" on a B/L's page (CB-47, from the CB-15 and CB-16 designs, signed-in parties
 * only): on demand, it reads the B/L's proof file and checks each step of the chain of title in
 * the browser (bl-check.ts), says whether the latest step is on the blockchain, lets the user
 * download the proof file, named with the B/L's number, and says how to check it offline with the
 * platform's verifier, its blockchain address (anchoring wallet) and the fingerprint of its keys.
 * The proof's keys are compared with the keys the platform publishes, and the blockchain status
 * is given as the platform's report, which the offline check confirms independently (CB-47
 * review). It is read again when the B/L gains a step.
 *
 *   <app-bl-check [recordId]="id" [recordNo]="no" [latestSeq]="3" [names]="names" />
 */
@Component({
  selector: 'app-bl-check',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-labelledby="bl-check-title">
      <div class="panel-head"><h2 id="bl-check-title">Check this B/L</h2></div>
      <div class="panel-body stack" style="gap:12px">
        @if (proof() === null) {
          <p class="muted" style="margin:0">Checks each step of the chain of title above against the platform’s signature, shows whether the latest step is on the blockchain, and gives you the proof to check offline.</p>
        }
        @if (error(); as e) {
          <div class="note danger" role="alert">{{ e }}</div>
        }
        <div class="row" style="gap:8px">
          <button type="button" [class]="proof() === null ? 'btn btn-primary' : 'btn btn-secondary'" [disabled]="busy()" (click)="check()">{{ proof() === null ? 'Check this B/L' : 'Check again' }}</button>
          @if (proof() !== null) {
            <button type="button" class="btn btn-primary" (click)="download()">Download the proof</button>
          }
        </div>
        <!-- present from the start, filled once checked, so that it is read out -->
        <p [class]="summaryClass()" role="status" aria-live="polite" style="margin:0">{{ summary() }}</p>
        @if (proof() !== null) {
          <!-- the steps' results only: the chain itself is in the table above -->
          <ul class="checks" aria-label="Steps checked">
            @for (r of rows(); track r.seq) {
              <li>Step {{ r.seq }}, {{ r.step }}: <span [class]="'sig-' + r.check">{{ r.signature }}</span></li>
            }
          </ul>
          @if (splitText(); as note) {
            <p class="small" style="margin:0">{{ note }}</p>
          }
          <p [class]="keysClass()" style="margin:0">{{ keysText() }}</p>
          <p style="margin:0"><strong>Proof on the blockchain:</strong> {{ statusText() }}</p>
          <div class="offline stack" style="gap:8px">
            <h3>How to verify it offline</h3>
            <ol class="steps">
              <li>
                <strong>Download the verifier.</strong> One file; it needs Node.js 18 or later and nothing else.
                <a class="btn btn-secondary" [href]="verifierUrl" download="lrfe-verify.mjs">Download the verifier</a>
              </li>
              <li>
                <strong>Run it on the proof file,</strong> with the platform’s blockchain address and the fingerprint of its signing keys:
                <code class="cmd">{{ command() }}</code>
              </li>
              <li>
                <strong>Read the result.</strong> VALID: every step is linked to the one before and signed with those keys, and the latest step is recorded on the blockchain from the platform’s address. NOT VALID: the lines above it say which check failed.
              </li>
            </ol>
            <p class="small muted" style="margin:0">Anyone can write to a public blockchain, so the verifier checks that the record was written from the platform’s own blockchain address. The key fingerprint changes when the platform renews its keys: check an older proof against the fingerprint given for its time.</p>
          </div>
        }
      </div>
    </section>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .panel-head h2 { margin: 0; font-size: 18px; }
    .panel-body { padding: 16px; }
    h3 { margin: 6px 0 0; font-size: 16px; }
    .steps { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 10px; }
    .steps .btn { display: inline-flex; margin-left: 6px; }
    .cmd { display: block; margin-top: 6px; padding: 10px 12px; border-radius: 8px; background: var(--color-surface-2); border: 1px solid var(--color-divider); font-size: 13px; word-break: break-all; }
    .checks { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
    .sig-checked { color: var(--success-fg, inherit); }
    .sig-failed { color: var(--danger-fg); font-weight: 600; }
    .note.info { background: var(--color-neutral-100, #f4f6f8); border: 1px solid var(--color-divider); }
  `,
  ],
})
export class BlCheckComponent {
  /** The B/L's id. */
  readonly recordId = input.required<string>();
  /** The B/L's number, which names the proof file. */
  readonly recordNo = input.required<string>();
  /** The B/L's last step: a new step makes the check stale. */
  readonly latestSeq = input.required<number>();
  /** The names of the organisations the chain names, by id. */
  readonly names = input<Record<string, string>>({});

  private readonly bls = inject(BlApi);
  private readonly proofs = inject(ProofApi);
  private readonly viewer = injectViewer();
  private readonly latest = new LatestRequest();
  private readonly locale = inject(LOCALE_ID);

  protected readonly verifierUrl = VERIFIER_URL;
  protected readonly proof = signal<TitleProof | null>(null);
  protected readonly results = signal<StepResult[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** The platform's blockchain address (its anchoring wallet), null while not known. */
  private readonly address = signal<string | null>(null);
  /** How the proof's keys compare with the keys the platform publishes. */
  private readonly keys = signal<KeyCheck>({
    state: 'unknown',
    fingerprint: null,
  });

  /** The steps of the proof file with their check. */
  protected readonly rows = computed(() => {
    const proof = this.proof();
    if (proof === null) {
      return [];
    }
    const checks = new Map(this.results().map(r => [r.seq, r.check]));
    return chainRows(proof.entries, this.viewer(), this.names()).map(row => {
      const check = checks.get(row.seq) ?? 'unchecked';
      return {...row, check, signature: signatureLabel(check)};
    });
  });
  protected readonly summary = computed(() => {
    if (this.proof() === null) {
      return '';
    }
    return checkSummary(this.results(), {
      keysDiffer: this.keys().state === 'differ',
    });
  });
  protected readonly summaryClass = computed(() => {
    if (this.summary() === '') {
      return '';
    }
    const failed = this.results().some(r => r.check === 'failed');
    if (failed || this.keys().state === 'differ') {
      return 'note danger';
    }
    return 'note info';
  });
  protected readonly keysText = computed(() => keyNote(this.keys()));
  /** For a B/L made by a split: its parent's chain is checked only offline. */
  protected readonly splitText = computed(() =>
    splitNote(this.proof()?.parent),
  );
  protected readonly keysClass = computed(() => {
    if (this.keys().state === 'differ') {
      return 'note danger';
    }
    return 'small';
  });
  protected readonly status = computed(() => proofStatus(this.proof()?.anchor));
  /** The blockchain status as the platform reports it, with when it was confirmed. */
  protected readonly statusText = computed(() => {
    const status = this.status();
    let when: string | null = null;
    if (status.at !== null) {
      when = formatDate(status.at, 'd MMM y, HH:mm', this.locale);
    }
    return statusSentence(status, when);
  });
  protected readonly fileName = computed(() => proofFileName(this.recordNo()));
  protected readonly command = computed(() =>
    verifyCommand(this.fileName(), this.address(), this.keys().fingerprint),
  );

  constructor() {
    effect(() => {
      // another B/L, or a new step: the check shown is no longer the B/L's
      this.recordId();
      this.latestSeq();
      untracked(() => {
        this.reset();
      });
    });
  }

  /**
   * Reads the proof file and checks each step, of this B/L, with the keys of the proof; compares
   * those keys with the keys the platform publishes, and reads its blockchain address for the
   * offline check. Only the latest check is shown.
   * @return when it is shown
   */
  protected async check(): Promise<void> {
    const request = this.latest.begin();
    this.busy.set(true);
    this.error.set(null);
    try {
      const [proof, published, wallet] = await Promise.all([
        this.bls.proof(this.recordId()),
        this.bls.titleKeys().catch(() => null),
        this.proofs.wallet().catch(() => null),
      ]);
      const crypto = browserCrypto();
      const results = await checkSteps(proof.entries, proof.jwks, crypto, {
        recordId: this.recordId(),
        startPreviousHash: proof.parent?.entries.at(-1)?.entryHash ?? null,
      });
      const keys = await keyCheck(proof.jwks, published, crypto);
      if (!this.latest.isCurrent(request)) {
        return;
      }
      this.proof.set(proof);
      this.results.set(results);
      this.keys.set(keys);
      this.address.set(wallet?.address ?? null);
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

  /** Saves the proof file checked, named with the B/L's number. */
  protected download(): void {
    const proof = this.proof();
    if (proof === null) {
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(proof, null, 2)], {type: 'application/json'}),
    );
    link.download = this.fileName();
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
    }, 10_000);
  }

  /** Forgets the check shown; an answer still on its way is no longer shown. */
  private reset(): void {
    this.latest.begin();
    this.proof.set(null);
    this.results.set([]);
    this.keys.set({state: 'unknown', fingerprint: null});
    this.error.set(null);
    this.busy.set(false);
  }
}
