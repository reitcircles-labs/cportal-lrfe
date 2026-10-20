import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
} from '@angular/core';

import {CheckVersion} from '../../api/audit.api';
import {IntakeDocType} from '../../api/intake.api';
import {PinnedDocument} from '../../api/records.api';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {ProofDownloadComponent} from '../../shared/proof-download.component';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {DetailTab, DocRow, docTypeLabel, fieldsOf} from './audit-record.types';
import {AUDIT_SHARED_STYLES} from './audit-shared.styles';
import {
  ANCHORING,
  CHANGED_SINCE_REVIEW,
  TIPS,
  toneClass,
} from './audit-wording';
import {FindingReply, FindingThreadComponent} from './finding-thread.component';

/**
 * One land record's audit, detail panel: one document, with its blockchain check, its metadata and
 * its open issues.
 */
@Component({
  selector: 'app-audit-doc-detail',
  imports: [
    InfoTipComponent,
    ProofLinkComponent,
    ProofDownloadComponent,
    FindingThreadComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (selectedDoc(); as d) {
      <div class="small muted">{{ docTypeLabel(d.pin.docType) }} · document version {{ d.pin.version }} · added in v{{ d.addedIn }}</div>
      <h3>{{ d.pin.ref || d.pin.edrmsNo }}</h3>
      <button type="button" class="btn btn-primary btn-block" (click)="review(d.pin.edrmsDocumentId)">Review document: view it, check it →</button>
      <div class="tabs" role="tablist">
        <button role="tab" type="button" [attr.aria-selected]="tab() === 'proof'" [class.on]="tab() === 'proof'" (click)="tab.set('proof')">1 · Blockchain check</button>
        <button role="tab" type="button" [attr.aria-selected]="tab() === 'meta'" [class.on]="tab() === 'meta'" (click)="tab.set('meta')">2 · Metadata</button>
        <button role="tab" type="button" [attr.aria-selected]="tab() === 'issues'" [class.on]="tab() === 'issues'" (click)="tab.set('issues')">3 · Open issues{{ d.issues.length ? ' (' + d.issues.length + ')' : '' }}</button>
      </div>
      @if (tab() === 'proof') {
        <span [class]="'small ' + d.checkTone" style="font-weight:600">{{ d.checkLabel }}</span>
        <dl class="kv"><dt class="row" style="gap:0">Fingerprint<app-info-tip label="fingerprint" [text]="tips.fingerprint" /></dt><dd class="mono small">{{ d.pin.seal.slice(0, 16) }}…</dd>
          @if (d.check; as c) {
            <dt>Proof</dt><dd><app-proof-link [label]="anchoringText(c.anchoring)" [tagClass]="anchoringClass(c.anchoring)" [batch]="c.batch" />
              <app-proof-download kind="document-version" [itemId]="d.pin.edrmsDocumentId" [version]="d.pin.version" [fileName]="'proof-' + d.pin.edrmsNo + '-v' + d.pin.version + '.json'" [waiting]="c.anchoring === 'waiting'" /></dd>
          }</dl>
      } @else if (tab() === 'meta') {
        <table class="table small"><tbody>
          <tr><th scope="row" class="muted">Document number</th><td>{{ d.pin.edrmsNo }}</td></tr>
          @for (f of fieldsOf(d.pin); track f.k) { <tr><th scope="row" class="muted">{{ f.k }}</th><td>{{ f.v }}</td></tr> }
        </tbody></table>
      } @else {
        @if (d.changed) {
          <div class="note danger" role="alert"><strong>Open · On-chain data mismatch</strong><span>This document doesn't match the blockchain. {{ changedSinceReview }}</span></div>
        }
        @for (f of d.findings; track f.id) {
          <app-finding-thread [finding]="f" [canAnswer]="canAct()" [busy]="busy()" (reply)="replyToFinding($event)" />
        }
        @if (!d.changed && !d.findings.length) {
          <div class="small muted">No open issues: the document matches the blockchain and has no open finding.</div>
        }
        @if (canAct()) { <div><button type="button" class="btn btn-secondary" (click)="openRaise()">Raise finding</button></div> }
      }
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
  `,
  ],
})
export class AuditDocDetailComponent {
  readonly selectedDoc = input.required<DocRow | null>();
  /** The intake catalogue's document types, for their names and field labels. */
  readonly docTypes = input.required<IntakeDocType[]>();
  readonly tab = model.required<DetailTab>();
  readonly canAct = input.required<boolean>();
  readonly busy = input.required<boolean>();
  /** Review was asked for a document: its id. */
  readonly reviewRequested = output<string>();
  /** An answer to a finding. */
  readonly reply = output<FindingReply>();
  /** Raising a finding was asked for. */
  readonly raise = output<void>();

  protected readonly tips = TIPS;
  protected readonly changedSinceReview = CHANGED_SINCE_REVIEW;

  protected review(documentId: string): void {
    this.reviewRequested.emit(documentId);
  }

  protected replyToFinding(reply: FindingReply): void {
    this.reply.emit(reply);
  }

  protected openRaise(): void {
    this.raise.emit();
  }

  protected docTypeLabel(id: string): string {
    return docTypeLabel(this.docTypes(), id);
  }

  protected fieldsOf(pin: PinnedDocument): Array<{k: string; v: string}> {
    return fieldsOf(this.docTypes(), pin);
  }

  protected anchoringText(state: CheckVersion['anchoring']): string {
    return ANCHORING[state].label;
  }

  protected anchoringClass(state: CheckVersion['anchoring']): string {
    return toneClass(ANCHORING[state].tone);
  }
}
