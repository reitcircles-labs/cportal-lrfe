import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import {AuditApi, ProofStatus, TrailEntry} from '../../api/audit.api';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {
  TIPS,
  actionLabel,
  proofLabel,
  shortDateTime,
  toneClass,
} from './audit-wording';

/** How many entries are shown at a time. */
const PAGE = 25;

/** The result of verifying one entry. */
type Result = 'valid' | 'notValid' | 'notYet' | 'unavailable';

const RESULTS: Record<Result, string> = {
  valid: 'Valid',
  notValid: 'Not valid',
  notYet: 'Not on the blockchain yet',
  unavailable: 'Couldn’t check',
};

/**
 * The audit trail of a land record (API-661): every action on it, newest first, 25 at a time, with
 * each entry's proof status and a Verify per entry.
 */
@Component({
  selector: 'app-audit-trail',
  imports: [InfoTipComponent, ProofLinkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="stack" style="gap:10px">
      <h2 class="h">Audit trail<app-info-tip label="audit trail" [text]="tips.auditTrail" /></h2>
      @if (error(); as e) { <div class="small" role="alert">The trail could not be read: {{ e }}</div> }
      <div class="panel" style="overflow-x:auto">
        <table class="table" style="min-width:900px">
          <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Item</th><th>Proof</th><th>Entry fingerprint</th><th><span class="sr-only">Check</span></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.entry.seq) {
              <tr>
                <td class="num">{{ r.time }}</td>
                <td>{{ r.entry.actor.name }}</td>
                <td>{{ r.action }}</td>
                <td>{{ r.item }}</td>
                <td>@if (r.proof) { <app-proof-link [label]="r.proof.label" [tagClass]="r.proof.tagClass" [batch]="r.proof.batch" stacked /> }</td>
                <td class="mono small muted">{{ r.entry.hash.slice(0, 4) }}…{{ r.entry.hash.slice(-4) }}</td>
                <td style="text-align:right">
                  @if (r.result) {
                    <span class="small" style="font-weight:600">{{ r.result }}</span>
                  } @else {
                    <button type="button" class="btn btn-secondary" (click)="verify(r.entry.seq)">Verify</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="muted">{{ loading() ? 'Loading…' : 'No trail entries.' }}</td></tr>
            }
          </tbody>
        </table>
        <div class="row foot">
          <span class="muted small">Showing the newest {{ entries().length }} of {{ total() }} entries</span>
          @if (entries().length < total()) {
            <button type="button" class="btn btn-secondary" (click)="more()">Show {{ page }} more</button>
          }
        </div>
      </div>
    </section>
  `,
  styles: [
    `
    .h { margin: 0; font-size: 18px; display: flex; align-items: center; }
    .foot { padding: 12px 14px; border-top: 1px solid var(--color-divider); justify-content: space-between; gap: 10px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
  ],
})
export class AuditTrailComponent {
  private readonly audit = inject(AuditApi);

  readonly recordId = input.required<string>();
  /** Changes whenever the trail should be read again (after an action on the page). */
  readonly reloadKey = input(0);

  protected readonly tips = TIPS;
  protected readonly page = PAGE;
  protected readonly entries = signal<TrailEntry[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly proofs = signal<
    Record<number, {status: ProofStatus; batch: number | null}>
  >({});
  private readonly results = signal<Record<number, Result>>({});

  protected readonly rows = computed(() =>
    this.entries().map(entry => {
      const proof = this.proofs()[entry.seq];
      const result = this.results()[entry.seq];
      const status = proof ? proofLabel(proof.status) : null;
      return {
        entry,
        time: shortDateTime(entry.time),
        action: actionLabel(entry.type, entry.data),
        item: itemOf(entry),
        proof: status
          ? {
              label: status.label,
              tagClass: toneClass(status.tone),
              batch: proof?.batch ?? null,
            }
          : null,
        result: result ? RESULTS[result] : null,
      };
    }),
  );

  constructor() {
    effect(() => {
      this.reloadKey();
      void this.load(this.recordId(), PAGE);
    });
  }

  protected more(): void {
    void this.load(this.recordId(), this.entries().length + PAGE);
  }

  protected async verify(seq: number): Promise<void> {
    let result: Result;
    try {
      const v = await this.audit.verifyEntry(seq);
      if (v.valid) {
        result = 'valid';
      } else {
        result = v.status === 'waiting' ? 'notYet' : 'notValid';
      }
    } catch {
      result = 'unavailable';
    }
    this.results.update(r => ({...r, [seq]: result}));
  }

  /** The newest `count` entries, newest first, with their proof status. */
  private async load(recordId: string, count: number): Promise<void> {
    this.loading.set(true);
    try {
      const {total} = await this.audit.trail(recordId, 0, 1);
      const offset = Math.max(0, total - count);
      const {entries} = await this.audit.trail(
        recordId,
        offset,
        Math.min(count, 500),
      );
      this.total.set(total);
      this.entries.set([...entries].reverse());
      // proofs that were waiting may have moved on since: ask again for those
      const known = this.proofs();
      const missing = entries.filter(
        e => !known[e.seq] || known[e.seq].status === 'waiting',
      );
      const statuses = await Promise.all(
        missing.map(e =>
          this.audit.proofStatus(e.seq).then(
            p =>
              [
                e.seq,
                {status: p.status, batch: p.anchor?.batch ?? null},
              ] as const,
            () => null,
          ),
        ),
      );
      this.proofs.update(p => {
        const next = {...p};
        for (const s of statuses) {
          if (s) {
            next[s[0]] = s[1];
          }
        }
        return next;
      });
      this.error.set(null);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }
  }
}

/** What an entry is about: a land record version, a document, or the record. */
function itemOf(entry: TrailEntry): string {
  const d = entry.data as {
    recordNo?: string;
    versionNumber?: number;
    edrmsNo?: string;
    fromVersion?: number;
    toVersion?: number;
  };
  if (d.fromVersion && d.toVersion) {
    return d.fromVersion === d.toVersion
      ? `v${d.toVersion}`
      : `v${d.fromVersion}–v${d.toVersion}`;
  }
  if (d.edrmsNo) {
    return d.edrmsNo;
  }
  if (d.versionNumber) {
    return `v${d.versionNumber}`;
  }
  return d.recordNo ?? '';
}
