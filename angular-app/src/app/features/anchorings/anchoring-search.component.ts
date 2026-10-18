import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {RouterLink} from '@angular/router';

import {AnchoringsApi, LookupResult} from '../../api/anchorings.api';
import {
  ITEM_STATUS,
  MESSAGES,
  answerStatus,
  answerText,
  aboutTime,
  count,
  historyLine,
  inSentence,
  notFoundText,
  toneClass,
} from './anchorings-wording';

/** The example searches offered under the field. */
const EXAMPLES = ['LR-NA-2026-000001', 'EDR-NA-2026-000412', 'Erf 1873'];

/**
 * "Is it on the blockchain?" (API-698, design API-688 board 1): look up a land record or document
 * by number, Erf or deed number, and see the answer in plain words with its history of batches.
 */
@Component({
  selector: 'app-anchoring-search',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel find" aria-labelledby="find-title">
      <h2 id="find-title">Is it on the blockchain?</h2>
      <p class="muted">{{ messages.searchIntro }}</p>
      <form class="row form" role="search" (submit)="submit($event)">
        <label class="field" style="flex:1 1 420px">
          <span class="small muted">{{ messages.searchLabel }}</span>
          <input class="input big" type="search" name="q" maxlength="100" [placeholder]="messages.searchPlaceholder" [value]="query()" (input)="query.set(value($event))" />
        </label>
        <button type="submit" class="btn btn-primary big" [disabled]="busy()">Search</button>
      </form>
      <div class="row small" style="gap:8px">
        <span class="muted">Try:</span>
        @for (e of examples; track e) {
          <button type="button" class="example" (click)="search(e)">{{ e }}</button>
        }
      </div>

      @if (error(); as e) {
        <div class="note danger" role="alert">{{ e }}</div>
      }
      @if (result(); as r) {
        @switch (r.kind) {
          @case ('none') {
            <div class="note" role="status">{{ notFound(r.query) }}</div>
          }
          @case ('choices') {
            <div class="result">
              <div class="result-head"><strong>{{ r.choices.length }} land records match “{{ r.query }}”. Pick one:</strong></div>
              <ul class="choices">
                @for (c of r.choices; track c.recordId) {
                  <li><button type="button" class="btn btn-secondary" (click)="search(c.recordNo)">{{ c.label }} · {{ c.recordNo }}</button></li>
                }
              </ul>
            </div>
          }
          @default {
            @if (card(); as c) {
              <div class="result" aria-live="polite">
                <div class="result-head" [class.good]="c.good">
                  <span class="card-kicker">{{ c.kind }}</span>
                  <span class="title">{{ c.title }}</span>
                  <span>{{ c.subtitle }}</span>
                  <span class="row" style="gap:10px;margin-top:4px"><span [class]="c.statusClass">{{ c.statusLabel }}</span><strong>{{ c.answer }}</strong></span>
                </div>
                <div class="history">
                  <h3>{{ c.historyTitle }}</h3>
                  <ol>
                    @for (h of c.history; track $index) {
                      <li>
                        <span class="what"><strong>{{ h.what }}</strong><span class="small muted">{{ h.when }}</span></span>
                        <span [class]="h.statusClass">{{ h.statusLabel }}</span>
                        <span class="where">
                          @if (h.batch) {
                            <a [routerLink]="['/anchorings', h.batch]">Batch {{ h.batchLabel }} →</a>
                          } @else if (h.waiting) {
                            <span class="small muted">{{ h.waiting }}</span>
                          }
                        </span>
                      </li>
                    }
                  </ol>
                </div>
                <div class="foot small">{{ c.footnote }}</div>
              </div>
            }
          }
        }
      }
    </section>
  `,
  styles: [
    `
    .find { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .find h2 { margin: 0; font-size: 20px; }
    .find p { margin: 0; }
    .form { gap: 10px; align-items: flex-end; }
    .big { height: 48px; font-size: 16px; }
    .example { min-height: 32px; padding: 0 10px; border: 1px solid var(--color-divider); border-radius: 999px; background: var(--color-surface-2); color: inherit; cursor: pointer; font: inherit; font-size: 13px; }
    .note { padding: 14px 16px; border: 1px solid var(--color-divider); border-radius: 10px; background: var(--color-surface-2); }
    .note.danger { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger-bd); }
    .result { border: 1px solid var(--color-divider); border-radius: 12px; overflow: hidden; }
    .result-head { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; background: var(--color-surface-2); }
    .result-head.good { background: var(--color-accent-100); }
    .title { font-size: 18px; font-weight: 700; }
    .choices { list-style: none; margin: 0; padding: 12px 18px; display: flex; flex-wrap: wrap; gap: 8px; }
    .history { padding: 4px 18px 6px; border-top: 1px solid var(--color-divider); }
    .history h3 { margin: 12px 0 4px; font-size: 14px; font-weight: 600; color: var(--color-neutral-700); }
    .history ol { margin: 0; padding: 0; list-style: none; }
    .history li { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 10px 0; border-top: 1px solid var(--color-divider); }
    .what { display: flex; flex-direction: column; flex: 1 1 320px; min-width: 0; }
    .where { min-width: 150px; text-align: right; }
    .where a { font-weight: 600; display: inline-flex; min-height: 44px; align-items: center; }
    .foot { padding: 12px 18px; border-top: 1px solid var(--color-divider); background: var(--color-surface-2); }
  `,
  ],
})
export class AnchoringSearchComponent {
  private readonly api = inject(AnchoringsApi);

  protected readonly messages = MESSAGES;
  protected readonly examples = EXAMPLES;
  protected readonly query = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<LookupResult | null>(null);
  private readonly typeLabels = signal(new Map<string, string>());
  /** Counts searches, so a slow answer to an earlier one never replaces a newer one. */
  private requestNo = 0;

  /** The result card of a land record or document. */
  protected readonly card = computed(() => {
    const r = this.result();
    if (!r || (r.kind !== 'record' && r.kind !== 'document')) {
      return null;
    }
    const now = new Date();
    const labels = this.typeLabels();
    const typeLabel = (id: string | null | undefined) =>
      id ? (labels.get(id) ?? '') : '';
    const status = answerStatus(r);
    const answer = answerText(r, now);
    const nextDue =
      r.answer.status === 'waiting' && r.answer.nextDueAt
        ? `Next batch ${aboutTime(r.answer.nextDueAt, now)}`
        : 'With the next batch';
    let head: {
      kind: string;
      title: string;
      subtitle: string;
      historyTitle: string;
      footnote: string;
    };
    if (r.kind === 'record') {
      head = {
        kind: 'Land record',
        title: `${r.record.recordNo} · ${r.record.label}`,
        subtitle: r.record.currentVersion
          ? `Current version v${r.record.currentVersion}, committed ${inSentence(r.record.committedAt, now)}`
          : 'No committed version yet',
        historyTitle: 'Its history on the blockchain, newest first',
        footnote: answer.good
          ? MESSAGES.recordFootnote
          : MESSAGES.waitingFootnote,
      };
    } else {
      const type = [typeLabel(r.document.docType), r.document.ref]
        .filter(Boolean)
        .join(' ');
      head = {
        kind: 'Document',
        title: `${r.document.edrmsNo}${type ? ` · ${type}` : ''}`,
        subtitle: `Version ${r.document.currentVersion}`,
        historyTitle: 'Its versions on the blockchain',
        footnote: MESSAGES.documentFootnote,
      };
    }
    return {
      ...head,
      good: answer.good,
      answer: answer.text,
      statusLabel: status.label,
      statusClass: toneClass(status.tone),
      history: r.history.map(h => {
        const line = historyLine(h, typeLabel, now);
        const s = ITEM_STATUS[h.status];
        return {
          ...line,
          statusLabel: s.label,
          statusClass: toneClass(s.tone),
          batch: h.batch,
          batchLabel: h.batch ? count(h.batch) : '',
          waiting: h.status === 'waiting' ? nextDue : '',
        };
      }),
    };
  });

  constructor() {
    this.api
      .documentTypes()
      .then(t => this.typeLabels.set(t))
      .catch(() => {});
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected notFound(query: string): string {
    return notFoundText(query);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.search(this.query());
  }

  protected async search(q: string): Promise<void> {
    this.query.set(q);
    const text = q.trim();
    if (!text) {
      return;
    }
    const mine = ++this.requestNo;
    this.busy.set(true);
    try {
      const result = await this.api.lookup(text);
      if (mine === this.requestNo) {
        this.result.set(result);
        this.error.set(null);
      }
    } catch (e) {
      if (mine === this.requestNo) {
        this.result.set(null);
        this.error.set(
          (e as {status?: number}).status === 400
            ? MESSAGES.tooLong
            : (e as Error).message,
        );
      }
    } finally {
      if (mine === this.requestNo) {
        this.busy.set(false);
      }
    }
  }
}
