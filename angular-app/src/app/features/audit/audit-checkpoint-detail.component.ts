import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';

import {CheckVersion, Checkpoint, Finding} from '../../api/audit.api';
import {LandRecord} from '../../api/records.api';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {AUDIT_SHARED_STYLES} from './audit-shared.styles';
import {
  ANCHORING,
  CHANGED_SINCE_REVIEW,
  shortDateTime,
  toneClass,
} from './audit-wording';
import {FindingReply, FindingThreadComponent} from './finding-thread.component';

/** One land record's audit, detail panel: the audit sign-off, its checklist and its findings. */
@Component({
  selector: 'app-audit-checkpoint-detail',
  imports: [ProofLinkComponent, FindingThreadComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let rec = record();
    <div class="small muted">Audit sign-off</div>
    <h3>{{ rec.label }} · {{ range() ? rangeText() : 'nothing to audit' }}</h3>
    @if (range()) {
      <p class="muted" style="margin:0">One sign-off for every version committed since the last audit. Only what is on the blockchain can be trusted, so the audit can happen only once everything is there and matches. Documents are checked against the blockchain automatically; you check that each version's changes follow from its documents.</p>
      <ul class="checks">
        @for (c of checklist(); track c.label) {
          <li><span class="dot" [class.ok]="c.done">{{ c.done ? '✓' : '' }}</span><span class="stack" style="gap:0"><strong>{{ c.label }}</strong><span class="small muted">{{ c.detail }}</span></span></li>
        }
      </ul>
      @if (changedItems().length) {
        <div class="note danger" role="alert"><strong>Changed since review: {{ changedItems().join(', ') }}</strong><span>{{ changedSinceReview }}</span></div>
      }
      @for (f of recordFindings(); track f.id) {
        <app-finding-thread [finding]="f" [canAnswer]="canAct()" [busy]="busy()" (reply)="replyToFinding($event)" />
      }
      @if (check()?.openFindings?.length) {
        <div class="note warn">An open finding blocks the sign-off. It is resolved by a corrected version (reviewed, submitted and on the blockchain), or an auditor closes it when it was resolved by agreement outside the portal, with the reason.</div>
      }
      @if (canAct()) {
        <div class="row actions">
          <button type="button" class="btn btn-primary" [disabled]="!!signReason() || busy()" (click)="signOff()">Sign off {{ rangeText() }}</button>
        </div>
        @if (signReason(); as r) { <div class="reason">{{ r }}</div> }
      } @else {
        <div class="small muted">You can view and verify. Signing off and raising findings need the auditor role.</div>
      }
    } @else {
      @if (check()?.lastSignoff; as last) {
        <div class="signed">
          <strong class="tone-success">✓ Audit signed off up to v{{ last.toVersion }}</strong>
          <span class="small muted">By {{ last.signedByName ?? 'an auditor' }} · {{ dateTime(last.signedAt) }}</span>
          @if (last.proof; as p) {
            <app-proof-link [label]="anchoringText(p.status)" [tagClass]="anchoringClass(p.status)" [batch]="p.batch" />
          }
        </div>
      }
      <p class="muted" style="margin:0">{{ check()?.reason }}</p>
    }
  `,
  styles: [
    AUDIT_SHARED_STYLES,
    `
    :host {
      display: contents;
    }
    h3 {
      margin: 0;
      font-size: 20px;
    }
    .checks {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .checks li {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .dot {
      flex: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
      border: 2px solid var(--color-divider);
    }
    .dot.ok {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
    }
    .signed {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-start;
      padding: 12px 14px;
      border: 1px solid var(--success-bd);
      border-radius: 10px;
      background: var(--success-bg);
    }
  `,
  ],
})
export class AuditCheckpointDetailComponent {
  readonly record = input.required<LandRecord>();
  /** The versions this audit covers; null when there is nothing to audit. */
  readonly range = input.required<Checkpoint['range']>();
  readonly rangeText = input.required<string>();
  readonly checklist =
    input.required<Array<{label: string; detail: string; done: boolean}>>();
  /** The versions and documents changed since they were reviewed. */
  readonly changedItems = input.required<string[]>();
  /** Findings on a land record version (not on a document). */
  readonly recordFindings = input.required<Finding[]>();
  readonly canAct = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly check = input.required<Checkpoint | null>();
  /** Why the audit cannot be signed off yet; null when it can. */
  readonly signReason = input.required<string | null>();
  /** Sign off was asked for. */
  readonly signedOff = output<void>();
  /** An answer to a finding. */
  readonly reply = output<FindingReply>();

  protected readonly changedSinceReview = CHANGED_SINCE_REVIEW;

  protected signOff(): void {
    this.signedOff.emit();
  }

  protected replyToFinding(reply: FindingReply): void {
    this.reply.emit(reply);
  }

  protected dateTime(iso: string): string {
    return shortDateTime(iso);
  }

  protected anchoringText(state: CheckVersion['anchoring']): string {
    return ANCHORING[state].label;
  }

  protected anchoringClass(state: CheckVersion['anchoring']): string {
    return toneClass(ANCHORING[state].tone);
  }
}
