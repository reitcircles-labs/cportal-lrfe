import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../api/api.service';
import { InfoTipComponent } from '../../shared/info-tip.component';
import { HEALTH_TIPS, HealthWarning, liveLine, warningLine } from './anchoring-health-wording';

/** How often the panel reads the report again while it is open, in milliseconds. */
const REFRESH_MS = 30_000;

/** The audit service's health report (GET /audit/anchoring/health). */
interface Health {
  configured: boolean;
  wallet: { readable: boolean; address: string | null; funds: { ada: string; low: boolean; minimumAda: number } | null };
  chain: { reachable: boolean; tipHeight: number | null; synced: boolean | null };
  lastAnchoring: { batch: number; status: string; createdAt: string } | null;
  next: { dueAt: string; waiting: number } | null;
  overdue: boolean;
  gaps: { count: number; latest: { seq: number; at: string; missing: number | null }[] };
  warnings: HealthWarning[];
  live: { kind: 'lowFunds' | 'trailGap'; at: string; missing: number | null }[];
}

/** How far a batch has got, as the Anchorings screens say it. */
const STATUS: Record<string, string> = { sent: 'Sent to the blockchain', onChain: 'On the blockchain', confirmed: 'Confirmed', failed: 'Failed' };

/** A date and time: "12 Oct 2026, 13:10". */
function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Anchoring health (`#/admin/anchoring`, API-674), for administrators: whether the portal is
 * writing its fingerprints to the blockchain, without reading server logs. The wallet with a copy
 * button, its funds, the blockchain connection, the last and next anchoring and recorded trail gaps,
 * each with an (i); clear warnings at the top; and the broadcast warnings (low funds, trail gaps),
 * read again every 30 seconds while the page is open.
 */
@Component({
  selector: 'app-anchoring-health',
  imports: [RouterLink, InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <header class="row head">
        <div>
          <div class="card-kicker">Administration</div>
          <h1 style="margin:4px 0 4px;font-size:32px">Anchoring health</h1>
          <p class="muted" style="margin:0">Whether the portal is writing its fingerprints to the blockchain.</p>
        </div>
        <span class="small muted">{{ checkedText() }}</span>
      </header>

      @if (error(); as e) { <div class="note danger" role="alert">{{ e }}</div> }

      @if (health(); as h) {
        @if (!h.configured) {
          <div class="note">This installation does not write to a blockchain. Fingerprints are sealed in the portal only.</div>
        }
        @if (warnings().length) {
          <div role="alert">
            <ul class="warnings">
              @for (w of warnings(); track w.text) { <li [class]="'warn-' + w.tone">{{ w.text }}</li> }
            </ul>
          </div>
        } @else if (h.configured) {
          <div class="ok" role="status">Anchoring is working: nothing needs attention.</div>
        }

        @if (h.configured) {
          <div class="grid">
            <section class="panel card">
              <h2 class="th">Anchoring wallet<app-info-tip label="anchoring wallet" [text]="tips.wallet" /></h2>
              @if (h.wallet.address; as address) {
                <code class="addr">{{ address }}</code>
                <button type="button" class="btn btn-secondary btn-sm" (click)="copy(address)">{{ copied() ? 'Copied' : 'Copy address' }}</button>
              } @else {
                <span class="bad">Its key can’t be read now</span>
              }
            </section>
            <section class="panel card">
              <h2 class="th">Funds<app-info-tip label="funds" [text]="tips.funds" /></h2>
              @if (h.wallet.funds; as f) {
                <span class="big" [class.bad]="f.low">{{ f.ada }}</span>
                <span class="small muted">At least {{ f.minimumAda }} needed{{ f.low ? ': top it up' : '' }}</span>
              } @else {
                <span class="muted">Can’t be read now</span>
              }
            </section>
            <section class="panel card">
              <h2 class="th">Blockchain connection<app-info-tip label="blockchain connection" [text]="tips.chain" /></h2>
              @if (h.chain.reachable) {
                <span class="big good">Connected</span>
                <span class="small muted">{{ h.chain.synced === false ? 'Still catching up' : 'In step with the latest block' }}@if (h.chain.tipHeight) { · block {{ h.chain.tipHeight.toLocaleString('en') }} }</span>
              } @else {
                <span class="big bad">Can’t be reached</span>
              }
            </section>
            <section class="panel card">
              <h2 class="th">Last anchoring<app-info-tip label="last anchoring" [text]="tips.last" /></h2>
              @if (h.lastAnchoring; as a) {
                <a class="big" [routerLink]="['/anchorings', a.batch]">Batch {{ a.batch.toLocaleString('en') }}</a>
                <span class="small muted">{{ status(a.status) }} · {{ when(a.createdAt) }}</span>
              } @else {
                <span class="muted">None yet</span>
              }
            </section>
            <section class="panel card">
              <h2 class="th">Next anchoring<app-info-tip label="next anchoring" [text]="tips.next" /></h2>
              @if (h.next; as n) {
                <span class="big" [class.bad]="h.overdue">{{ h.overdue ? 'Overdue' : 'Due ' + when(n.dueAt) }}</span>
                <span class="small muted">{{ n.waiting === 1 ? '1 fingerprint waiting' : n.waiting.toLocaleString('en') + ' fingerprints waiting' }}</span>
              } @else {
                <span class="muted">—</span>
              }
            </section>
          </div>
        }

        <section class="panel card">
          <h2 class="th">Trail gaps<app-info-tip label="trail gaps" [text]="tips.gaps" /></h2>
          @if (h.gaps.count) {
            <span>{{ h.gaps.count === 1 ? '1 gap recorded' : h.gaps.count + ' gaps recorded' }}</span>
            <ul class="list">
              @for (g of h.gaps.latest; track g.seq) {
                <li>{{ when(g.at) }}: {{ g.missing ?? 'some' }} event{{ g.missing === 1 ? '' : 's' }} lost · trail entry {{ g.seq }}</li>
              }
            </ul>
          } @else {
            <span class="good">None: the trail has every event.</span>
          }
        </section>

        <section class="panel card">
          <h2 class="th">Recent alerts<app-info-tip label="recent alerts" [text]="tips.live" /></h2>
          @if (live().length) {
            <ul class="list" aria-live="polite">
              @for (l of live(); track $index) { <li>{{ l }}</li> }
            </ul>
          } @else {
            <span class="muted" aria-live="polite">None in the last day.</span>
          }
        </section>
      } @else if (!error()) {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
  styles: [`
    .head { justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
    .note { padding: 12px 14px; border-radius: 10px; background: var(--color-surface-2); border: 1px solid var(--color-divider); }
    .note.danger { background: var(--danger-bg); color: var(--danger-fg); border-color: var(--danger-bd); }
    .warnings { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .warnings li { padding: 12px 14px; border-radius: 10px; font-weight: 600; }
    .warn-danger { background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); }
    .warn-warn { background: var(--warn-bg); color: var(--warn-fg); border: 1px solid var(--warn-bd); }
    .ok { padding: 12px 14px; border-radius: 10px; background: var(--success-bg); color: var(--success-fg); border: 1px solid var(--success-bd); font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .card { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .card h2 { margin: 0; font-size: 15px; }
    .th { display: inline-flex; align-items: center; }
    .big { font-size: 20px; font-weight: 700; text-decoration: none; }
    .good { color: var(--success-fg); } .bad { color: var(--danger-fg); }
    .addr { font-size: 12.5px; word-break: break-all; padding: 8px 10px; border-radius: 8px; background: var(--color-surface-2); border: 1px solid var(--color-divider); }
    .btn-sm { min-height: 32px; padding: 0 10px; font-size: 13px; }
    .list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
  `]
})
export class AnchoringHealthComponent {
  private readonly api = inject(ApiService);

  protected readonly tips = HEALTH_TIPS;
  protected readonly health = signal<Health | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly checkedAt = signal<Date | null>(null);
  protected readonly copied = signal(false);
  private loading = false;

  protected readonly warnings = computed(() => {
    const h = this.health();
    return h ? h.warnings.map(w => warningLine(w, h)) : [];
  });
  protected readonly live = computed(() => [...(this.health()?.live ?? [])].reverse().map(liveLine));
  protected readonly checkedText = computed(() => {
    const at = this.checkedAt();
    return at ? `Checked ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · again every 30 seconds` : '';
  });

  constructor() {
    void this.load();
    const timer = setInterval(() => void this.load(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected status(status: string): string {
    return STATUS[status] ?? status;
  }

  protected when(iso: string): string {
    return dateTime(iso);
  }

  protected async copy(address: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2_000);
    } catch {
      // the clipboard can be blocked; the address stays on screen to copy by hand
    }
  }

  private async load(): Promise<void> {
    if (this.loading) {
      return;                                    // the previous read is still running
    }
    this.loading = true;
    try {
      this.health.set(await this.api.get<Health>('/audit/anchoring/health'));
      this.error.set(null);
      this.checkedAt.set(new Date());
    } catch {
      this.error.set('The anchoring health could not be read. It is tried again in 30 seconds.');
    } finally {
      this.loading = false;
    }
  }
}
