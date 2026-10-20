import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {DomSanitizer, SafeResourceUrl} from '@angular/platform-browser';

import {CheckDocument, Finding} from '../../api/audit.api';
import {PinnedDocument, RecordsApi} from '../../api/records.api';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {
  CHANGED_SINCE_REVIEW,
  MATCH,
  TIPS,
  documentStatus,
  findingNumber,
} from './audit-wording';
import {FindingReply, FindingThreadComponent} from './finding-thread.component';

/** The blockchain check's result box. */
const BANNERS = {
  matches: {
    title: 'Match',
    body: 'This file is exactly the document that was sealed. Nothing has changed since.',
    tone: 'ok',
  },
  changed: {
    title: 'Changed since review',
    body: `This file is not the document that was sealed. ${CHANGED_SINCE_REVIEW}`,
    tone: 'bad',
  },
  notOnChain: {
    title: 'Not on the blockchain yet',
    body: 'You can read the document now. The check runs again once it is on the blockchain.',
    tone: 'wait',
  },
  unavailable: {
    title: 'Couldn’t check right now',
    body: 'Try again in a few minutes.',
    tone: 'warn',
  },
  earlier: {
    title: 'Checked at an earlier audit',
    body: 'This document version was covered by an earlier audit sign-off.',
    tone: 'wait',
  },
} as const;

/**
 * The review of one document, inside the land record's audit page (API-661), for the document that
 * was clicked: its status, the page images, the automatic blockchain check, the sealed metadata and
 * its findings. Documents need no sign-off; a problem is raised as a finding.
 */
@Component({
  selector: 'app-audit-review',
  imports: [InfoTipComponent, FindingThreadComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row head">
      <div>
        <button type="button" class="link" (click)="back.emit()">← {{ recordLabel() }} · audit {{ rangeText() }}</button>
        <h1>{{ pin().ref || pin().edrmsNo }} <span class="muted">· {{ kind() }}</span></h1>
        <div class="muted">{{ pin().edrmsNo }} · document version {{ pin().version }} · added in v{{ addedIn() }}</div>
        <div role="status" class="status" [class.open]="status().open">
          <strong>{{ status().open ? '!' : '✓' }} {{ status().title }}</strong> · {{ status().reason }}
        </div>
      </div>
      <nav class="row" style="gap:8px" aria-label="Documents in this audit">
        <span class="muted">Document {{ position() }} of {{ count() }}</span>
        <button type="button" class="btn btn-secondary" [disabled]="position() <= 1" (click)="previous.emit()">‹ Previous</button>
        <button type="button" class="btn btn-secondary" [disabled]="position() >= count()" (click)="next.emit()">Next ›</button>
      </nav>
    </div>

    <div class="row body">
      <section class="viewer panel">
        <div class="panel-head row" style="justify-content:space-between"><strong>Page images</strong>
          @if (url()) { <a class="btn btn-secondary" [href]="rawUrl()" target="_blank" rel="noopener">Open in a new tab</a> }
        </div>
        @if (url(); as u) {
          <iframe [src]="u" [title]="'Page images of ' + pin().edrmsNo"></iframe>
        } @else {
          <div class="muted" style="padding:24px">{{ fileError() ?? 'Loading the file…' }}</div>
        }
      </section>

      <aside class="side">
        <section class="panel card-pad">
          <h2 class="h"><span>1 · Blockchain check</span><app-info-tip label="blockchain check" align="right" [text]="tips.blockchainCheck" /></h2>
          <ul class="checks">
            <li><span class="dot ok">✓</span><span><strong>Fingerprint calculated</strong><span class="small muted mono">{{ pin().seal.slice(0, 16) }}…</span></span></li>
            <li><span class="dot" [class.ok]="match() === 'matches'" [class.bad]="match() === 'changed'">{{ dotSymbol() }}</span>
              <span><strong>{{ matchLabel() }}</strong></span></li>
          </ul>
          <div class="banner" [class]="'banner ' + banner().tone"><strong>{{ banner().title }}</strong><span>{{ banner().body }}</span></div>
        </section>

        <section class="panel card-pad">
          <h2 class="h"><span>2 · Metadata</span></h2>
          <p class="small muted" style="margin:0">The details sealed with the document. Use them to check that the document belongs to this land record.</p>
          <table class="table small"><tbody>
            @for (m of metadata(); track m.k) { <tr><th scope="row" class="muted">{{ m.k }}</th><td>{{ m.v }}</td></tr> }
          </tbody></table>
        </section>

        <section class="panel card-pad">
          <h2 class="h"><span>3 · Findings</span><app-info-tip label="findings" align="right" [text]="tips.findingThread" /></h2>
          @for (f of findings(); track f.id) {
            <app-finding-thread [finding]="f" [canAnswer]="canAnswer()" [busy]="busy()" (reply)="reply.emit($event)" />
          } @empty {
            <p class="small muted" style="margin:0">No findings. Documents need no sign-off. If this document doesn't belong to this land record, or something else is wrong, raise a finding.</p>
          }
          <div class="row" style="gap:10px">
            @if (canAnswer()) { <button type="button" class="btn btn-secondary" (click)="raise.emit()">Raise finding</button> }
            <button type="button" class="btn btn-primary" [disabled]="position() >= count()" (click)="next.emit()">Next document ›</button>
          </div>
          @if (findings().length) {
            <details class="record">
              <summary>How this is recorded in the audit trail</summary>
              <pre>{{ trailJson() }}</pre>
            </details>
          }
        </section>
      </aside>
    </div>
  `,
  styles: [
    `
    :host { display: flex; flex-direction: column; gap: 16px; }
    .head { justify-content: space-between; align-items: flex-end; gap: 12px; }
    h1 { margin: 2px 0 0; font-size: 28px; }
    .link { border: 0; background: transparent; color: var(--color-accent-800); padding: 0; min-height: 32px; cursor: pointer; font: inherit; }
    .status { display: inline-flex; gap: 6px; margin-top: 8px; padding: 6px 12px; border-radius: 999px; background: var(--color-accent-100); border: 1px solid var(--color-divider); }
    .status.open { background: var(--warn-bg); border-color: var(--warn-bd); }
    .body { align-items: flex-start; gap: 16px; }
    .viewer { flex: 999 1 600px; min-width: 0; }
    .viewer iframe { width: 100%; height: 760px; border: 0; background: var(--color-neutral-200); }
    .side { flex: 1 1 380px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
    .card-pad { padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
    .h { margin: 0; font-size: 16px; display: flex; align-items: center; justify-content: space-between; }
    .checks { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .checks li { display: flex; gap: 10px; align-items: flex-start; }
    .checks li > span:last-child { display: flex; flex-direction: column; }
    .dot { flex: none; width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 12px; font-weight: 700; border: 2px solid var(--color-divider); }
    .dot.ok { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
    .dot.bad { background: var(--danger); border-color: var(--danger); color: #fff; }
    .banner { display: flex; flex-direction: column; gap: 4px; border-radius: 8px; padding: 12px 14px; border: 1px solid var(--color-divider); }
    .banner.ok { background: var(--color-accent-100); }
    .banner.bad { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger-bd); }
    .banner.warn { background: var(--warn-bg); border-color: var(--warn-bd); }
    .record pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; margin: 8px 0 0; }
  `,
  ],
})
export class AuditReviewComponent {
  private readonly records = inject(RecordsApi);
  private readonly sanitizer = inject(DomSanitizer);

  readonly pin = input.required<PinnedDocument>();
  /** The document type's name. */
  readonly kind = input.required<string>();
  /** The sealed fields with their names. */
  readonly fields = input<Array<{k: string; v: string}>>([]);
  readonly recordLabel = input.required<string>();
  readonly rangeText = input.required<string>();
  readonly addedIn = input.required<number>();
  /** The document's entry in the open checkpoint; null when an earlier audit covered it. */
  readonly checkDocument = input<CheckDocument | null>(null);
  readonly findings = input<Finding[]>([]);
  readonly position = input(1);
  readonly count = input(1);
  readonly canAnswer = input(false);
  readonly busy = input(false);

  readonly back = output<void>();
  readonly previous = output<void>();
  readonly next = output<void>();
  readonly raise = output<void>();
  readonly reply = output<FindingReply>();

  protected readonly tips = TIPS;
  protected readonly url = signal<SafeResourceUrl | null>(null);
  protected readonly rawUrl = signal<string>('');
  protected readonly fileError = signal<string | null>(null);

  protected readonly match = computed(
    () => this.checkDocument()?.match ?? null,
  );
  protected readonly changed = computed(
    () => this.match() === 'changed' && !this.checkDocument()?.superseded,
  );
  protected readonly matchLabel = computed(() => {
    const m = this.match();
    if (m === 'matches') {
      return 'Same fingerprint as on the blockchain';
    }
    return m ? MATCH[m].label : 'Checked at an earlier audit';
  });
  protected readonly dotSymbol = computed(() => {
    if (this.match() === 'matches') {
      return '✓';
    }
    return this.match() === 'changed' ? '✕' : '';
  });
  protected readonly banner = computed(
    () => BANNERS[this.match() ?? 'earlier'],
  );
  protected readonly status = computed(() => {
    const open = this.findings()
      .filter(f => f.status === 'open')
      .map(f => findingNumber(f.id));
    return documentStatus(this.changed(), open, this.match());
  });
  protected readonly metadata = computed(() => [
    {k: 'Document number', v: this.pin().edrmsNo},
    ...(this.pin().ref ? [{k: 'Reference', v: this.pin().ref as string}] : []),
    ...this.fields(),
  ]);
  protected readonly trailJson = computed(() =>
    JSON.stringify(
      {
        trail: `Audit trail of ${this.pin().edrmsNo}, also shown in the trail of ${this.recordLabel()}`,
        Findings: this.findings().map(f => ({
          id: f.id,
          status: f.status,
          outcome: f.outcome,
          raisedBy: {name: f.raisedByName, at: f.raisedAt},
          issue: f.description,
          answers: (f.answers || []).map(a => ({
            name: a.byName,
            role: a.role,
            at: a.at,
            text: a.text,
          })),
          ...(f.status === 'closed'
            ? {
                closedBy: {name: f.closedByName, at: f.closedAt},
                answer: f.closeReason,
              }
            : {}),
        })),
      },
      null,
      2,
    ),
  );

  constructor() {
    effect(() => {
      void this.loadFile(this.pin());
    });
  }

  private async loadFile(pin: PinnedDocument): Promise<void> {
    this.url.set(null);
    this.fileError.set(null);
    try {
      const {url} = await this.records.contentLink(
        pin.edrmsDocumentId,
        pin.version,
      );
      this.rawUrl.set(url);
      this.url.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
    } catch (e) {
      this.fileError.set(
        `The file could not be opened: ${(e as Error).message}`,
      );
    }
  }
}
