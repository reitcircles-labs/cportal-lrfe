import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {toSignal} from '@angular/core/rxjs-interop';
import {ActivatedRoute, Router} from '@angular/router';
import {map} from 'rxjs';

import {ApiError} from '../../api/api.service';
import {AuditApi} from '../../api/audit.api';
import {
  CheckAnswer,
  PublicCheckApi,
  SealCertificate,
} from '../../api/public-check.api';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {SiteConfigService} from '../../state/site-config.service';
import {VERIFIER_URL} from '../check-proof/check-proof.component';
import {
  FileVerdict,
  dateTime,
  fileVerdict,
  printedCode,
  typedCode,
} from './check-extract';

/** The (i) explanations, as in the design's wording sheet (API-690). */
const TIPS = {
  onChain:
    'The registry writes a fingerprint of every record version to a public blockchain, in batches. Once there, nobody, not even the registry, can change the version without it showing.',
  current:
    'A land record is never edited: a change becomes a new version, approved by a second person. The current version is the one in force now. An extract shows the version that was current on its issue date.',
  fingerprint:
    'A code computed from every detail of the record version. Change a single character and the code is completely different. The extract prints it in full; here are its last 8 characters.',
  batch:
    'Many fingerprints written to the blockchain together, in one transaction. The extract names its batch and the transaction, so anyone can find it.',
  file: "The PDF carries the registry's seal and the proof for its record version. Checking it confirms that nothing in the file was changed, not just the code. It is checked in your browser: the file is not uploaded.",
};

/** What the page shows: the answer, or why there is none. */
type Result =
  | {kind: 'loading'}
  | {kind: 'answer'; answer: CheckAnswer}
  | {kind: 'limited'}
  | {kind: 'failed'};

/** How the result looks: green, yellow or red. */
type Tone = 'ok' | 'warn' | 'bad' | 'plain';

/**
 * "Check an ownership extract" (`#/check/<code>`, API-693): a public page, no sign-in, opened by
 * the QR code on an extract (its token) or by typing the check code printed on it (`#/check`). It
 * says whether the extract matches the registry's record and is still current, shows what to
 * compare with the paper (nothing personal), checks the PDF file in the browser against the file
 * the registry issued, and gives what is needed to check it without this page.
 */
@Component({
  selector: 'app-check-extract',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InfoTipComponent],
  template: `
    @let a = answer();
    <header class="masthead">
      <div class="flag" aria-hidden="true"></div>
      <div class="masthead-in">
        <b>{{ site.fullName() }}</b>
        <span class="muted small">Extract check · no login needed</span>
      </div>
    </header>

    <main class="wrap">
      <div>
        <h1>Check an ownership extract</h1>
        @if (a?.extractNo) {
          <p class="sub muted">Extract <span class="mono">{{ a!.extractNo }}</span> · issued {{ date(a!.issuedAt) }}</p>
        } @else if (shownCode()) {
          <p class="sub muted">Check code <span class="mono">{{ shownCode() }}</span></p>
        }
      </div>

      @if (!code()) {
        <form class="card" (submit)="$event.preventDefault(); open()">
          <h2>Type the check code</h2>
          <p>Find it on the extract, under the QR code: 12 letters and digits. Spaces and dashes don't matter.</p>
          <div class="row">
            <label class="sr-only" for="code">Check code</label>
            <input id="code" class="input mono" [value]="typed()" (input)="typed.set(value($event))"
                   placeholder="K7QF 2M9D XH4T" autocomplete="off" spellcheck="false" aria-describedby="code-help" />
            <button type="submit" class="btn btn-primary" [disabled]="!typedOk()">Check</button>
          </div>
          <span id="code-help" class="small muted">
            @if (typed() && !typedOk()) {
              A check code has 12 letters and digits.
            } @else {
              Or scan the QR code on the extract with your phone's camera.
            }
          </span>
        </form>
      } @else {
        <section [class]="'result ' + tone()" aria-live="polite">
          @switch (result().kind) {
            @case ('loading') {
              <p class="muted">Checking…</p>
            }
            @default {
              <div class="result-in">
                <span class="icon" aria-hidden="true">{{ icon() }}</span>
                <div class="result-text">
                  <h2>{{ headline() }}</h2>
                  @switch (view()) {
                    @case ('current') {
                      <span>Land record {{ a!.recordNo }}, version {{ a!.versionNumber }}.</span>
                      <span class="inline">On the blockchain in batch {{ a!.batch }}.<app-info-tip label="On the blockchain" [text]="tips.onChain" /></span>
                      <span class="inline strong ok-fg">✓ Still the current version, checked just now ({{ date(a!.checkedAt) }}).<app-info-tip label="Current version" [text]="tips.current" /></span>
                    }
                    @case ('replaced') {
                      <span>Land record {{ a!.recordNo }}, version {{ a!.versionNumber }}.</span>
                      <span class="inline">On the blockchain in batch {{ a!.batch }}.<app-info-tip label="On the blockchain" [text]="tips.onChain" /></span>
                      <span class="strong warn-fg">Replaced on {{ date(a!.replacedAt) }} by version {{ a!.versionNumber! + 1 }}. This extract no longer shows the current record: ask the registry for a new extract.</span>
                    }
                    @case ('unavailable') {
                      @if (a?.extractNo) {
                        <span>The registry's record says this extract is valid and shows version {{ a!.versionNumber }}. The check against the blockchain couldn't run, so that isn't confirmed yet. Try again in a few minutes.</span>
                      } @else {
                        <span>Try again in a few minutes.</span>
                      }
                    }
                    @case ('mismatch') {
                      <span>The record version it shows no longer matches what is on the blockchain. Don't rely on it, and contact the registry.</span>
                    }
                    @case ('file') {
                      <span>The PDF you checked differs from what the registry sealed for this extract: it may have been altered. Don't rely on it, and contact the registry.</span>
                    }
                    @case ('revoked') {
                      <span>The registry withdrew this extract on {{ date(a!.revokedAt) }}. Don't rely on it. The owner can ask the registry for a new one.</span>
                    }
                    @case ('unknown') {
                      <span>Check the code against the one printed on the extract. If you scanned it from the QR code and it still fails, the extract may be forged: don't rely on it, and contact the registry.</span>
                      <a href="#/check">Type the code again</a>
                    }
                    @case ('limited') {
                      <span>To protect the registry, each connection may make only a few checks a minute. Wait a minute, then try again.</span>
                    }
                  }
                </div>
              </div>
            }
          }
        </section>

        @if (a && (a.state === 'current' || a.state === 'replaced' || (a.state === 'unavailable' && a.extractNo))) {
          <section class="card" aria-labelledby="cmp-h">
            <h2 id="cmp-h">Compare with your extract</h2>
            <span class="muted">Your paper or PDF must show the same. If anything differs, don't rely on it.</span>
            <dl class="facts">
              <dt>Extract</dt><dd class="mono">{{ a.extractNo }}</dd>
              <dt>Issued</dt><dd>{{ date(a.issuedAt) }}</dd>
              <dt>Land record</dt><dd>{{ a.recordNo }}, version {{ a.versionNumber }}</dd>
              @if (a.fingerprintEnd) {
                <dt class="inline">Fingerprint<app-info-tip label="Fingerprint" [text]="tips.fingerprint" /></dt><dd class="mono">…{{ a.fingerprintEnd }}</dd>
              }
              @if (a.batch) {
                <dt class="inline">Batch<app-info-tip label="Batch" [text]="tips.batch" /></dt><dd>{{ a.batch }}</dd>
              }
            </dl>
            <span class="small muted">This page shows no names, parcel or owner details: only the extract itself has them.</span>
          </section>
        }

        @if (a?.pdfSha256) {
          <section class="card" aria-labelledby="file-h">
            <h2 id="file-h" class="inline">Check the PDF file too (optional)<app-info-tip label="Check the file" [text]="tips.file" /></h2>
            <div class="drop" [class.over]="dragging()" (dragover)="$event.preventDefault(); dragging.set(true)"
                 (dragleave)="dragging.set(false)" (drop)="drop($event)">
              <span>Drop the extract's PDF here. It is checked in your browser and not uploaded.</span>
              <label class="btn btn-secondary">
                Choose the PDF
                <input type="file" class="sr-only" accept="application/pdf,.pdf" (change)="choose($event)" />
              </label>
            </div>
            <span aria-live="polite">
              @switch (file()) {
                @case ('match') {
                  <span class="strong ok-fg">✓ The file matches: it is exactly the PDF the registry sealed for this extract.</span>
                }
                @case ('nomatch') {
                  <span class="strong bad-fg">✗ The file doesn't match: its contents differ from what the registry sealed.</span>
                }
                @case ('notpdf') {
                  <span class="strong bad-fg">✗ This isn't a PDF file, so it isn't the registry's extract.</span>
                }
                @case ('cannot') {
                  <span class="warn-fg">This browser can't check files here: it needs a secure (https) connection. Use the offline checker below.</span>
                }
              }
            </span>
          </section>
        }
      }

      <details class="card own">
        <summary>Check it yourself, without this page</summary>
        <div class="own-in">
          @if (a?.explorerUrl) {
            <span>The transaction is on a public blockchain, readable by anyone: <a [href]="a!.explorerUrl" target="_blank" rel="noopener">view it on a public blockchain explorer ↗<span class="sr-only"> (opens in a new tab)</span></a>.</span>
          }
          @if (wallet(); as w) {
            <span>The registry publishes the address it writes from: <code class="mono">{{ w }}</code></span>
          }
          @if (seal(); as s) {
            <span>The registry's seal fingerprint (SHA-256): <code class="mono">{{ s.sha256 }}</code></span>
          }
          <span><a [href]="verifierUrl" download="lrfe-verify.mjs">Download the offline checker</a>: on your own computer, it checks the registry's seal and the proof attached to the PDF against the blockchain, with the two values above.</span>
          <h3 class="guide-h">Running the offline checker</h3>
          <ol class="steps">
            <li>Install Node.js 18 or later (nodejs.org) if the computer doesn't have it. Nothing else is needed.</li>
            <li>Put the checker and the extract's PDF in one folder, and run there:
              <div class="cmd">
                <code class="mono">{{ command() }}</code>
                <button type="button" class="btn btn-secondary btn-sm" aria-label="Copy the command" (click)="copyCommand()">{{ copied() ? 'Copied' : 'Copy' }}</button>
              </div>
              <span class="sr-only" aria-live="polite">{{ copied() ? 'Copied' : '' }}</span>
            </li>
            <li><b>VALID</b> means the PDF is as the registry sealed it, and its record version is on the blockchain. <b>NOT VALID</b> says which check failed: don't rely on the extract. If the blockchain can't be reached, it says so: try again later.</li>
          </ol>
          <span class="small muted">An offline check can't tell whether the record has a newer version or the extract was withdrawn: only this page can, so always scan the QR code too.</span>
        </div>
      </details>

      <footer class="small muted foot">
        <span>The registry issues extracts; the blockchain lets anyone check them. Legal title follows registration in the deeds registry.</span>
        <span>Questions about an extract: contact the {{ site.config().orgName }}.</span>
      </footer>
    </main>
  `,
  styles: [
    `
    :host { display: block; min-height: 100vh; background: var(--color-bg, #f3f5f8); }
    .masthead { background: var(--color-surface); border-bottom: 1px solid var(--color-divider); }
    .flag { height: 6px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); }
    .masthead-in { max-width: 760px; margin: 0 auto; padding: 14px 16px; display: flex; flex-direction: column; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 28px 16px 48px; display: flex; flex-direction: column; gap: 18px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.2; }
    .sub { margin: 4px 0 0; }
    .mono { font-family: ui-monospace, Menlo, monospace; }
    .card { background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: 12px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
    .card h2 { margin: 0; font-size: 17px; }
    .card p { margin: 0; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; }
    .row .input { flex: 1 1 220px; min-height: 44px; font-size: 18px; letter-spacing: .06em; }
    .row .btn { min-height: 44px; }
    .result { border-radius: 12px; padding: 20px 22px; border: 1px solid var(--color-divider); background: var(--color-surface); }
    .result.ok { background: var(--success-bg); border-color: var(--success-bd); }
    .result.warn { background: var(--warn-bg); border-color: var(--warn-bd); }
    .result.bad { background: var(--danger-bg); border-color: var(--danger-bd); }
    .result-in { display: flex; gap: 14px; align-items: flex-start; }
    .result-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .result h2 { margin: 0; font-size: 21px; line-height: 1.25; }
    .icon { flex: none; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 22px; font-weight: 700; color: #fff; }
    .ok .icon { background: var(--success); }
    .warn .icon { background: var(--warn); }
    .bad .icon { background: var(--danger); }
    .inline { display: inline-flex; align-items: center; flex-wrap: wrap; }
    .strong { font-weight: 600; }
    .ok-fg { color: var(--success-fg); }
    .warn-fg { color: var(--warn-fg); }
    .bad-fg { color: var(--danger-fg); }
    .facts { margin: 0; display: grid; grid-template-columns: minmax(110px, auto) minmax(0, 1fr); gap: 6px 16px; align-items: center; }
    .facts dt { color: var(--color-neutral-700); }
    .facts dd { margin: 0; overflow-wrap: anywhere; }
    .drop { border: 2px dashed var(--color-divider); border-radius: 10px; padding: 18px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; background: var(--color-surface-2); }
    .drop.over { border-color: var(--color-accent); }
    .drop .btn { min-height: 44px; cursor: pointer; }
    .drop label:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
    .own { padding: 0 20px; }
    .own summary { cursor: pointer; padding: 14px 0; font-weight: 600; }
    .own-in { display: flex; flex-direction: column; gap: 8px; padding-bottom: 16px; }
    .own code { overflow-wrap: anywhere; }
    .guide-h { margin: 8px 0 0; font-size: 15px; }
    .steps { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 8px; }
    .cmd { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
    .cmd code { flex: 1 1 280px; min-width: 0; padding: 8px 10px; border-radius: 8px; background: var(--color-surface-2); border: 1px solid var(--color-divider); font-size: 13px; }
    .btn-sm { min-height: 36px; padding: 0 12px; font-size: 13px; }
    .foot { display: flex; flex-direction: column; gap: 4px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
  ],
})
export class CheckExtractComponent {
  private readonly checks = inject(PublicCheckApi);
  private readonly audit = inject(AuditApi);
  private readonly router = inject(Router);
  protected readonly site = inject(SiteConfigService);

  protected readonly tips = TIPS;
  protected readonly verifierUrl = VERIFIER_URL;

  /** The token or check code from the address; empty on the page for typing one in. */
  protected readonly code = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map(p => p.get('code') ?? '')),
    {initialValue: ''},
  );
  protected readonly typed = signal('');
  protected readonly typedOk = computed(() => !!typedCode(this.typed()));
  protected readonly result = signal<Result>({kind: 'loading'});
  protected readonly file = signal<FileVerdict | 'cannot' | null>(null);
  protected readonly dragging = signal(false);
  protected readonly wallet = signal<string | null>(null);
  protected readonly seal = signal<SealCertificate | null>(null);
  protected readonly copied = signal(false);
  /** The offline checker's command, with the registry's address and seal fingerprint (API-694). */
  protected readonly command = computed(
    () =>
      `node lrfe-verify.mjs extract.pdf --address ${this.wallet() ?? '<the address above>'} --seal ${this.seal()?.sha256 ?? '<the seal fingerprint above>'}`,
  );

  protected readonly answer = computed(() => {
    const r = this.result();
    return r.kind === 'answer' ? r.answer : null;
  });
  /** A date of the answer, in the time zone the extract prints its dates in (API-786). */
  protected date(iso: string | null): string {
    return dateTime(iso, this.answer()?.timeZone);
  }
  /** The typed check code, as printed; a QR code's token is not shown. */
  protected readonly shownCode = computed(() => {
    const code = typedCode(this.code());
    return code ? printedCode(code) : '';
  });
  /** Which result to show: the answer's state, overruled by a file that doesn't match. */
  protected readonly view = computed(() => {
    const r = this.result();
    if (r.kind === 'limited') return 'limited';
    if (r.kind !== 'answer') return 'unavailable';
    // a changed PDF overrules the answer; another kind of file is only answered in its section
    if (this.file() === 'nomatch' && r.answer.state !== 'revoked') {
      return 'file';
    }
    return r.answer.state;
  });
  protected readonly tone = computed<Tone>(() => {
    if (this.result().kind === 'loading') return 'plain';
    const view = this.view();
    if (view === 'current') return 'ok';
    return ['replaced', 'unavailable', 'limited'].includes(view)
      ? 'warn'
      : 'bad';
  });
  protected readonly icon = computed(
    () => ({ok: '✓', warn: '!', bad: '✗', plain: ''})[this.tone()],
  );
  protected readonly headline = computed(() => {
    const view = this.view();
    const withExtract = !!this.answer()?.extractNo;
    return {
      current: "Matches the registry's record",
      replaced: "Matches the registry's record, but it was replaced",
      unavailable: withExtract
        ? "The blockchain can't be read right now"
        : "This extract can't be checked right now",
      mismatch: "This extract doesn't match the registry's record",
      file: "This file doesn't match the registry's record",
      revoked: 'This extract was withdrawn',
      unknown: 'No extract with this code',
      limited: 'Too many checks from this connection',
    }[view];
  });

  constructor() {
    effect(() => {
      const code = this.code();
      untracked(() => this.load(code));
    });
    this.audit.wallet().then(
      w => this.wallet.set(w.address),
      () => this.wallet.set(null),
    );
    this.checks.seal().then(
      s => this.seal.set(s),
      () => this.seal.set(null),
    );
  }

  /** The check of `code`, made again each time the page opens: the answer is never kept. */
  private async load(code: string) {
    this.file.set(null);
    if (!code) return;
    this.result.set({kind: 'loading'});
    let result: Result;
    try {
      result = {kind: 'answer', answer: await this.checks.check(code)};
    } catch (e) {
      const limited = e instanceof ApiError && e.status === 429;
      result = {kind: limited ? 'limited' : 'failed'};
    }
    // an answer for a code no longer shown, arriving late, is dropped
    if (code === this.code()) this.result.set(result);
  }

  protected open() {
    const code = typedCode(this.typed());
    if (code) this.router.navigate(['/check', code]);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async copyCommand() {
    try {
      await navigator.clipboard.writeText(this.command());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2_000);
    } catch {
      // the clipboard can be blocked; the command stays on screen to copy by hand
    }
  }

  protected choose(event: Event) {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0];
    if (chosen) this.compare(chosen);
    input.value = ''; // the same file again checks again
  }

  protected drop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    const dropped = event.dataTransfer?.files?.[0];
    if (dropped) this.compare(dropped);
  }

  /** The file against the PDF the registry issued, in the browser. */
  private async compare(chosen: File) {
    const issued = this.answer()?.pdfSha256;
    if (!issued) return;
    // the browser's hashing exists only on a secure (https) page
    if (!globalThis.crypto?.subtle) {
      this.file.set('cannot');
      return;
    }
    this.file.set(await fileVerdict(await chosen.arrayBuffer(), issued));
  }
}
