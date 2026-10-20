import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import {AuditApi, ProofStatus, TrailEntry} from '../../api/audit.api';
import {AuditTabsComponent} from '../../shared/audit-tabs.component';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {ProofDownloadComponent} from '../../shared/proof-download.component';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {
  EVENT_GROUPS,
  SEARCH_TIPS,
  TIPS,
  actionLabel,
  chainResult,
  gapText,
  proofLabel,
  shortDateTime,
  sourceLabel,
  toneClass,
} from './audit-wording';

/** How many entries a page shows. */
const PAGE = 25;

/** How long typing a name must pause before people are looked up, in milliseconds. */
const LOOKUP_PAUSE_MS = 250;

/** What the search is about. */
type SubjectKind = 'any' | 'user' | 'document' | 'record';

const SUBJECT_KINDS: Array<{id: SubjectKind; label: string}> = [
  {id: 'any', label: 'Anything'},
  {id: 'user', label: 'A person'},
  {id: 'document', label: 'A document'},
  {id: 'record', label: 'A land record'},
];

/** The search as it was run, for paging. */
interface Search {
  subject?: string;
  type?: string;
  from?: string;
  to?: string;
}

/** Local midnight at the start of a picked day ("2026-10-12"), as the instant the trail compares with. */
function startOfDay(date: string): string {
  return new Date(`${date}T00:00`).toISOString();
}

/** Local midnight at the end of a picked day, so "to" includes the day picked. */
function endOfDay(date: string): string {
  const d = new Date(`${date}T00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/**
 * The trail search of the Audit screen (`#/audit/trail`, API-673): what a person did, what happened
 * to a document, what happened in a period, not only on one land record. Filters by person,
 * document number or land record number, by event type or family, and by dates; results oldest
 * first, paged, each opening its details and its proof. "Check the trail" recomputes the whole
 * chain. Recorded gaps are shown as gaps.
 */
@Component({
  selector: 'app-audit-trail-search',
  imports: [
    AuditTabsComponent,
    InfoTipComponent,
    ProofDownloadComponent,
    ProofLinkComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <header>
        <div class="card-kicker">Read-only</div>
        <h1 style="margin:4px 0 4px;font-size:36px">Audit</h1>
        <p class="muted" style="margin:0">Search the whole trail: what a person did, what happened to a document, or what happened in a period.</p>
      </header>
      <app-audit-tabs />

      <section class="panel">
        <form class="filters" (submit)="run($event)">
          <label class="field">
            <span class="small muted row" style="gap:0">About<app-info-tip label="about" [text]="tips.subject" /></span>
            <select class="input" aria-label="About" [value]="kind()" (change)="pickKind($event)">
              @for (k of kinds; track k.id) { <option [value]="k.id">{{ k.label }}</option> }
            </select>
          </label>
          @switch (kind()) {
            @case ('user') {
              <label class="field grow">
                <span class="small muted">Name</span>
                <input class="input" list="trail-actors" [value]="person()" (input)="typePerson($event)" placeholder="Start typing a name" autocomplete="off" />
                <datalist id="trail-actors">
                  @for (a of actors(); track a.id) { <option [value]="a.name"></option> }
                </datalist>
              </label>
            }
            @case ('document') {
              <label class="field grow">
                <span class="small muted">Document number</span>
                <input class="input" [value]="number()" (input)="number.set(value($event))" placeholder="e.g. EDR-NA-2026-000412" />
              </label>
            }
            @case ('record') {
              <label class="field grow">
                <span class="small muted">Land record number</span>
                <input class="input" [value]="number()" (input)="number.set(value($event))" placeholder="e.g. LR-NA-2026-000001" />
              </label>
            }
          }
          <label class="field">
            <span class="small muted row" style="gap:0">What<app-info-tip label="what" [text]="tips.type" /></span>
            <select class="input" aria-label="What" [value]="type()" (change)="type.set(value($event))">
              <option value="">Every event</option>
              @for (g of groups; track g.prefix) { <option [value]="g.prefix">{{ g.label }}</option> }
            </select>
          </label>
          <label class="field">
            <span class="small muted row" style="gap:0">From<app-info-tip label="dates" [text]="tips.dates" /></span>
            <input class="input" type="date" aria-label="From" [value]="from()" (input)="from.set(value($event))" />
          </label>
          <label class="field">
            <span class="small muted">To</span>
            <input class="input" type="date" aria-label="To" [value]="to()" (input)="to.set(value($event))" />
          </label>
          <button type="submit" class="btn btn-primary" [disabled]="loading()">Search</button>
        </form>

        <div class="row chain">
          <button type="button" class="btn btn-secondary" [disabled]="checking()" (click)="checkChain()">{{ checking() ? 'Checking…' : 'Check the trail' }}</button>
          <app-info-tip label="check the trail" [text]="trailTip" />
          @if (chain(); as c) { <span role="status" [class]="'small tone-' + c.tone">{{ c.text }}</span> }
        </div>

        @if (error(); as e) { <div class="note danger" role="alert">{{ e }}</div> }

        @if (result(); as r) {
          <div style="overflow-x:auto">
            <table class="table" style="min-width:900px">
              <thead><tr><th>When</th><th>Who</th><th>What</th><th><span class="row" style="gap:0">Source<app-info-tip label="source" align="right" [text]="tips.source" /></span></th><th><span class="sr-only">Details</span></th></tr></thead>
              <tbody>
                @for (row of rows(); track row.entry.seq) {
                  <tr [class.gap]="row.gap">
                    <td>{{ row.when }}</td>
                    <td>{{ row.who }}</td>
                    <td>
                      <strong>{{ row.action }}</strong>
                      @if (row.gap) { <div class="small">{{ row.gap }}</div> }
                    </td>
                    <td>{{ row.source }}</td>
                    <td style="text-align:right">
                      <button type="button" class="btn btn-secondary btn-sm" [attr.aria-expanded]="open() === row.entry.seq" (click)="toggle(row.entry.seq)">{{ open() === row.entry.seq ? 'Hide' : 'Details' }}</button>
                    </td>
                  </tr>
                  @if (open() === row.entry.seq) {
                    <tr class="details"><td colspan="5">
                      <div class="detail-grid">
                        <dl class="kv">
                          <dt>Entry</dt><dd>{{ row.entry.seq }}</dd>
                          <dt>Event</dt><dd class="mono small">{{ row.entry.type }}</dd>
                          <dt>About</dt><dd class="small">{{ row.entry.subjects.join(', ') || '—' }}</dd>
                          <dt class="row" style="gap:0">Fingerprint<app-info-tip label="fingerprint" [text]="fingerprintTip" /></dt><dd class="mono small">{{ row.entry.hash.slice(0, 16) }}…</dd>
                          <dt>Proof</dt>
                          <dd>
                            @if (proofOf(row.entry.seq); as p) {
                              <app-proof-link [label]="p.label" [tagClass]="p.tagClass" [batch]="p.batch" />
                              <app-proof-download kind="trail-entry" [itemId]="'' + row.entry.seq" [fileName]="'proof-trail-entry-' + row.entry.seq + '.json'" [waiting]="p.waiting" />
                            } @else { <span class="small muted">Loading…</span> }
                          </dd>
                        </dl>
                        <pre class="data">{{ row.data }}</pre>
                      </div>
                    </td></tr>
                  }
                } @empty {
                  <tr><td colspan="5" class="muted" style="padding:20px 16px">Nothing in the trail matches. Widen the dates, or pick every event.</td></tr>
                }
              </tbody>
            </table>
          </div>
          <nav class="row pager" aria-label="Pages">
            <span class="muted">{{ range() }}</span>
            <div class="row" style="gap:6px">
              <button type="button" class="btn btn-secondary" [disabled]="offset() === 0 || loading()" (click)="go(offset() - page)">Earlier</button>
              <button type="button" class="btn btn-secondary" [disabled]="offset() + page >= r.total || loading()" (click)="go(offset() + page)">Later</button>
            </div>
          </nav>
        } @else if (!loading()) {
          <p class="muted" style="margin:0;padding:16px">Pick what to search for, then Search.</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
    .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; padding: 14px 16px; border-bottom: 1px solid var(--color-divider); }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field.grow { flex: 1 1 240px; }
    .chain { padding: 10px 16px; gap: 6px; border-bottom: 1px solid var(--color-divider); align-items: center; flex-wrap: wrap; }
    .tone-success { color: var(--success-fg); font-weight: 600; } .tone-danger { color: var(--danger-fg); font-weight: 600; }
    .note.danger { margin: 10px 16px; padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); }
    tr.gap { background: var(--warn-bg); color: var(--warn-fg); }
    tr.details td { background: var(--color-surface-2); }
    .detail-grid { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(0, 1.4fr); gap: 16px; align-items: start; }
    .data { margin: 0; max-height: 280px; overflow: auto; padding: 10px; border-radius: 8px; background: var(--color-surface); border: 1px solid var(--color-divider); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .btn-sm { min-height: 32px; padding: 0 10px; font-size: 13px; }
    .pager { padding: 12px 16px; border-top: 1px solid var(--color-divider); justify-content: space-between; gap: 10px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @media (max-width: 760px) { .detail-grid { grid-template-columns: minmax(0, 1fr); } }
  `,
  ],
})
export class AuditTrailSearchComponent {
  private readonly audit = inject(AuditApi);

  protected readonly kinds = SUBJECT_KINDS;
  protected readonly groups = EVENT_GROUPS;
  protected readonly tips = SEARCH_TIPS;
  protected readonly trailTip = TIPS.trailChain;
  protected readonly fingerprintTip = TIPS.fingerprint;
  protected readonly page = PAGE;

  protected readonly kind = signal<SubjectKind>('any');
  protected readonly person = signal('');
  protected readonly number = signal('');
  protected readonly type = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly actors = signal<Array<{id: string; name: string}>>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<{
    total: number;
    entries: TrailEntry[];
  } | null>(null);
  protected readonly offset = signal(0);
  protected readonly open = signal<number | null>(null);
  protected readonly checking = signal(false);
  protected readonly chain = signal<{text: string; tone: string} | null>(null);
  private readonly proofs = signal<
    Record<number, {status: ProofStatus; batch: number | null}>
  >({});
  private search: Search = {};
  private lookupTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts searches, so a slow answer to an earlier one never replaces a newer one. */
  private requestNo = 0;

  protected readonly rows = computed(() =>
    (this.result()?.entries ?? []).map(entry => ({
      entry,
      when: shortDateTime(entry.time),
      who: entry.actor.name,
      action: actionLabel(entry.type, entry.data),
      source: sourceLabel(entry.source),
      gap:
        entry.type === 'audit.trail.gap'
          ? gapText(Number(entry.data['missing'] ?? 0))
          : '',
      data: JSON.stringify(entry.data, null, 2),
    })),
  );

  protected readonly range = computed(() => {
    const total = this.result()?.total ?? 0;
    if (!total) {
      return 'No entries';
    }
    const first = this.offset() + 1;
    return `${first}–${Math.min(first + PAGE - 1, total)} of ${total.toLocaleString('en')} entries, oldest first`;
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected pickKind(event: Event): void {
    this.kind.set(this.value(event) as SubjectKind);
    this.number.set('');
    this.person.set('');
  }

  protected typePerson(event: Event): void {
    const q = this.value(event);
    this.person.set(q);
    clearTimeout(this.lookupTimer);
    this.lookupTimer = setTimeout(() => {
      // a slow answer for an earlier name never replaces the suggestions for the name typed now
      this.audit.actors(q).then(
        r => {
          if (q === this.person()) {
            this.actors.set(r.items);
          }
        },
        () => this.actors.set([]),
      );
    }, LOOKUP_PAUSE_MS);
  }

  protected async run(event: Event): Promise<void> {
    event.preventDefault();
    const mine = ++this.requestNo;
    this.error.set(null);
    let subject: string | undefined;
    try {
      subject = await this.subject();
    } catch (e) {
      if (mine === this.requestNo) {
        this.error.set((e as Error).message);
      }
      return;
    }
    if (mine !== this.requestNo) {
      return;
    }
    this.search = {
      subject,
      type: this.type() || undefined,
      from: this.from() ? startOfDay(this.from()) : undefined,
      to: this.to() ? endOfDay(this.to()) : undefined,
    };
    await this.go(0, mine);
  }

  /** The page at `offset` of the search last run; `mine` continues a search started by run(). */
  protected async go(offset: number, mine = ++this.requestNo): Promise<void> {
    this.loading.set(true);
    this.open.set(null);
    try {
      const result = await this.audit.searchTrail({
        ...this.search,
        offset,
        limit: PAGE,
      });
      if (mine === this.requestNo) {
        this.result.set(result);
        this.offset.set(offset);
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

  protected toggle(seq: number): void {
    this.open.set(this.open() === seq ? null : seq);
    if (this.open() === seq && !this.proofs()[seq]) {
      this.audit.proofStatus(seq).then(
        p =>
          this.proofs.update(all => ({
            ...all,
            [seq]: {status: p.status, batch: p.anchor?.batch ?? null},
          })),
        () => {},
      );
    }
  }

  protected proofOf(seq: number) {
    const p = this.proofs()[seq];
    if (!p) {
      return null;
    }
    const label = proofLabel(p.status);
    return {
      label: label.label,
      tagClass: toneClass(label.tone),
      batch: p.batch,
      waiting: p.status === 'waiting',
    };
  }

  protected async checkChain(): Promise<void> {
    this.checking.set(true);
    try {
      this.chain.set(chainResult(await this.audit.verifyTrail()));
    } catch (e) {
      this.chain.set({text: (e as Error).message, tone: 'danger'});
    } finally {
      this.checking.set(false);
    }
  }

  /** The trail subject the filters name, or undefined for anything; an error when it can't be found. */
  private async subject(): Promise<string | undefined> {
    const kind = this.kind();
    if (kind === 'user') {
      const name = this.person().trim();
      if (!name) {
        return undefined;
      }
      const {items} = await this.audit.actors(name);
      const exact = items.filter(
        a => a.name.toLowerCase() === name.toLowerCase(),
      );
      const candidates = exact.length ? exact : items;
      if (candidates.length !== 1) {
        throw new Error(
          candidates.length
            ? 'Several people match. Type the full name of one of them.'
            : `Nobody called “${name}” appears in the trail.`,
        );
      }
      return `user:${candidates[0].id}`;
    }
    const number = this.number().trim().toUpperCase();
    if (kind === 'document' && number) {
      return `edrmsNo:${number}`;
    }
    if (kind === 'record' && number) {
      // through the audit service, so whoever can open the Audit screen can search by land record
      const {items} = await this.audit.list({
        q: number,
        filter: 'all',
        limit: 100,
        offset: 0,
      });
      const found = items.find(r => r.recordNo.toUpperCase() === number);
      if (!found) {
        throw new Error(`There is no land record ${number}. Check the number.`);
      }
      return `record:${found.id}`;
    }
    return undefined;
  }
}
