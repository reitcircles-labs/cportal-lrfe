import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AuditApi } from '../../api/audit.api';

/** Where the offline verifier is downloaded from (the audit service, no sign-in). */
const VERIFIER_URL = '/api/audit/verifier/lrfe-verify.mjs';

/** A blockchain transaction id: 64 hexadecimal characters. */
const TX_ID = /^[0-9a-f]{64}$/;

/** The published wallet, as the audit service gives it. */
interface Wallet {
  address: string | null;
  explorerUrl: string | null;
  transactionUrl: string | null;
}

/**
 * "Check a proof yourself" (`#/check-a-proof`, API-676): a public page, no sign-in, for someone
 * outside the registry (a bank, a court, a buyer's lawyer) who was given a proof file. It explains
 * what a proof shows, how to run the offline verifier, the installation's published anchoring wallet
 * and how to look up the transaction on a public blockchain explorer. The address and the explorer
 * come from the audit service, so the page always matches the installation. The network is not
 * named: only the explorer link's address shows it.
 */
@Component({
  selector: 'app-check-proof',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="wrap">
      <header>
        <div class="flag" aria-hidden="true"></div>
        <p class="kicker">Deeds Registry · Republic of Namibia</p>
        <h1>Check a proof yourself</h1>
        <p class="lead">Were you given a proof file by the Deeds Registry? You can check it yourself, without an account and without trusting the registry’s systems.</p>
      </header>

      <section class="card">
        <h2>What a proof shows</h2>
        <p>Every land record version and document the registry seals gets a fingerprint: a short code that changes completely if anything in it changes. Regularly, normally once an hour, the new fingerprints are combined into one value and written to a public blockchain, where nobody, not even the registry, can change them afterwards.</p>
        <p>A proof file shows that one item’s fingerprint is part of such a batch, and in which blockchain transaction the batch was written. If the proof checks out, the item is exactly as it was when it was sealed.</p>
      </section>

      <section class="card">
        <h2>How to check it</h2>
        <ol class="steps">
          <li>
            <strong>Download the verifier.</strong>
            <span>One file. It needs Node.js 18 or later, and nothing else to install.</span>
            <a class="btn btn-primary" [href]="verifierUrl" download="lrfe-verify.mjs">Download the verifier</a>
          </li>
          <li>
            <strong>Run it on the proof file,</strong> with the registry’s anchoring wallet below:
            <div class="cmd">
              <code>{{ command() }}</code>
              <button type="button" class="btn btn-secondary btn-sm" aria-label="Copy the command" (click)="copy(command(), 'command')">{{ copied() === 'command' ? 'Copied' : 'Copy' }}</button>
            </div>
          </li>
          <li>
            <strong>Read the result.</strong>
            <span><b>VALID</b>: the item’s fingerprint is in the batch, and the batch was written to the blockchain by the registry’s wallet. <b>NOT VALID</b>: one of the checks failed; the lines above it say which. If the blockchain can’t be reached, the verifier says so: try again later.</span>
          </li>
        </ol>
      </section>

      <section class="card" aria-labelledby="wallet-title">
        <h2 id="wallet-title">The registry’s anchoring wallet</h2>
        <p>Anyone can write a value to a public blockchain. Only the registry can pay from its own wallet, so the verifier checks that the batch was paid for by this address.</p>
        @if (error()) {
          <p class="note" role="alert">The wallet address can’t be shown right now. Try again in a minute.</p>
        } @else if (wallet(); as w) {
          @if (w.address) {
            <div class="cmd">
              <code class="addr">{{ w.address }}</code>
              <button type="button" class="btn btn-secondary btn-sm" (click)="copy(w.address, 'address')">{{ copied() === 'address' ? 'Copied' : 'Copy address' }}</button>
            </div>
            @if (w.explorerUrl) {
              <a [href]="w.explorerUrl" target="_blank" rel="noopener">See every batch this wallet wrote, on a public blockchain explorer ↗<span class="sr-only"> (opens in a new tab)</span></a>
            }
          } @else {
            <p class="note">This installation does not write to a blockchain yet.</p>
          }
        } @else {
          <p class="muted">Loading…</p>
        }
      </section>

      @if (wallet()?.transactionUrl) {
        <section class="card">
          <h2>Look up the transaction yourself</h2>
          <p>The proof file names its transaction (under <code>anchor</code>, <code>tx</code>). Paste it here to open it on a public blockchain explorer, a website run independently of the registry.</p>
          <label class="field">
            <span class="small muted">Transaction id</span>
            <input class="input" [value]="tx()" (input)="tx.set(value($event))" placeholder="64 characters, 0–9 and a–f" spellcheck="false" />
          </label>
          @if (txLink(); as link) {
            <a [href]="link" target="_blank" rel="noopener">Open the transaction on a public blockchain explorer ↗<span class="sr-only"> (opens in a new tab)</span></a>
          } @else if (tx()) {
            <span class="small muted">A transaction id is 64 characters, 0–9 and a–f.</span>
          }
        </section>
      }

      <span class="sr-only" aria-live="polite">{{ copied() ? 'Copied' : '' }}</span>
      <p class="small muted foot"><a href="#/login">Registry staff: sign in</a></p>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--color-bg, #f3f5f8); }
    .wrap { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; display: flex; flex-direction: column; gap: 18px; }
    .flag { height: 6px; border-radius: 3px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); margin-bottom: 18px; }
    .kicker { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--color-accent-600); }
    h1 { margin: 6px 0; font-size: 34px; line-height: 1.15; }
    .lead { margin: 0; font-size: 17px; color: var(--color-neutral-700); }
    .card { background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
    .card h2 { margin: 0; font-size: 20px; }
    .card p { margin: 0; }
    .steps { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 16px; }
    .steps li { padding-left: 4px; }
    .steps li > span, .steps li > .cmd { display: block; margin-top: 6px; }
    .steps li > .cmd { display: flex; }
    .steps li > a { display: inline-flex; margin-top: 8px; }
    .cmd { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%; }
    .cmd code { flex: 1 1 320px; min-width: 0; padding: 10px 12px; border-radius: 8px; background: var(--color-surface-2); border: 1px solid var(--color-divider); font-size: 13px; word-break: break-all; }
    .btn-sm { min-height: 36px; padding: 0 12px; font-size: 13px; }
    .note { padding: 10px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field .input { font-family: ui-monospace, Menlo, monospace; }
    .foot { text-align: center; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `]
})
export class CheckProofComponent {
  private readonly audit = inject(AuditApi);

  protected readonly verifierUrl = VERIFIER_URL;
  protected readonly wallet = signal<Wallet | null>(null);
  protected readonly error = signal(false);
  protected readonly tx = signal('');
  protected readonly copied = signal<'command' | 'address' | null>(null);

  protected readonly command = computed(() => `node lrfe-verify.mjs proof.json --address ${this.wallet()?.address ?? '<the wallet address below>'}`);

  protected readonly txLink = computed(() => {
    const id = this.tx().trim().toLowerCase();
    const base = this.wallet()?.transactionUrl;
    return base && TX_ID.test(id) ? base + id : null;
  });

  constructor() {
    this.audit.wallet().then(w => this.wallet.set(w), () => this.error.set(true));
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async copy(text: string, what: 'command' | 'address'): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 2_000);
    } catch {
      // the clipboard can be blocked; the text stays on screen to copy by hand
    }
  }
}
