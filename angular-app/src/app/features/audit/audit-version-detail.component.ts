import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
} from '@angular/core';

import {CheckVersion} from '../../api/audit.api';
import {Diff, LandRecord} from '../../api/records.api';
import {InfoTipComponent} from '../../shared/info-tip.component';
import {ProofDownloadComponent} from '../../shared/proof-download.component';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {RecordDiffComponent} from '../../shared/record-diff.component';
import {DetailTab, SelectedVersion} from './audit-record.types';
import {AUDIT_SHARED_STYLES} from './audit-shared.styles';
import {ANCHORING, TIPS, toneClass} from './audit-wording';

/**
 * One land record's audit, detail panel: one version, with its blockchain check and its changes
 * to check.
 */
@Component({
  selector: 'app-audit-version-detail',
  imports: [
    InfoTipComponent,
    ProofLinkComponent,
    ProofDownloadComponent,
    RecordDiffComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let rec = record();
    @if (selectedVersion(); as v) {
      <div class="small muted">Land record version · {{ v.earlier ? 'signed off at an earlier audit' : 'part of this audit' }}</div>
      <h3>{{ rec.label }} · version {{ v.n }}</h3>
      <div class="tabs" role="tablist">
        <button role="tab" type="button" [attr.aria-selected]="tab() === 'proof'" [class.on]="tab() === 'proof'" (click)="tab.set('proof')">1 · Blockchain check</button>
        <button role="tab" type="button" [attr.aria-selected]="tab() === 'meta'" [class.on]="tab() === 'meta'" (click)="tab.set('meta')">2 · Check changes</button>
      </div>
      @if (tab() === 'proof') {
        @if (v.inRange; as i) {
          @if (i.match === 'matches') {
            <span class="small tone-success" style="font-weight:600">Matches the blockchain ✓</span>
          } @else {
            <span class="reason">{{ versionLocked() }}</span>
          }
          <dl class="kv"><dt>Proof</dt><dd><app-proof-link [label]="anchoringText(i.anchoring)" [tagClass]="anchoringClass(i.anchoring)" [batch]="i.batch" />
            <app-proof-download kind="record-version" [itemId]="rec.id" [version]="v.n" [fileName]="'proof-' + rec.recordNo + '-v' + v.n + '.json'" [waiting]="i.anchoring === 'waiting'" /></dd>
            <dt class="row" style="gap:0">Fingerprint<app-info-tip label="fingerprint" [text]="tips.fingerprint" /></dt><dd class="mono small">{{ i.seal.slice(0, 16) }}…</dd></dl>
        } @else {
          <span class="small muted">Checked and signed off in the audit of {{ lastSignoffText() }}.</span>
        }
      } @else {
        <p class="small muted" style="margin:0">Check that the changes in this version match the documents it added, for example the new owner against the deed of transfer.</p>
        <app-record-diff [diff]="selectedDiff()" />
        @if (v.inRange) {
          @if (versionLocked(); as note) {
            <div class="reason">{{ note }}</div>
          } @else if (checked().has(v.n)) {
            <span class="tone-success small" style="font-weight:600">✓ You checked this version's changes.</span>
          } @else if (canAct()) {
            <div class="row actions">
              <button type="button" class="btn btn-primary" (click)="markChecked(v.n)">Changes match: mark checked</button>
              @if (v.n === current()) { <button type="button" class="btn btn-secondary" (click)="openRaise()">Doesn't match: raise finding</button> }
            </div>
            @if (v.n !== current()) { <div class="small muted">Findings are raised on the current version, v{{ current() }}. Describe there what is wrong in v{{ v.n }}.</div> }
          }
        }
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
export class AuditVersionDetailComponent {
  readonly selectedVersion = input.required<SelectedVersion | null>();
  readonly record = input.required<LandRecord>();
  readonly tab = model.required<DetailTab>();
  /** Why the version cannot be checked yet; empty when it can. */
  readonly versionLocked = input.required<string>();
  readonly lastSignoffText = input.required<string>();
  readonly selectedDiff = input.required<Diff | null>();
  /** The versions whose changes the auditor checked. */
  readonly checked = input.required<ReadonlySet<number>>();
  readonly canAct = input.required<boolean>();
  /** The current version of the land record. */
  readonly current = input.required<number>();
  /** The auditor checked a version's changes: its number. */
  readonly versionChecked = output<number>();
  /** Raising a finding was asked for. */
  readonly raise = output<void>();

  protected readonly tips = TIPS;

  protected markChecked(n: number): void {
    this.versionChecked.emit(n);
  }

  protected openRaise(): void {
    this.raise.emit();
  }

  protected anchoringText(state: CheckVersion['anchoring']): string {
    return ANCHORING[state].label;
  }

  protected anchoringClass(state: CheckVersion['anchoring']): string {
    return toneClass(ANCHORING[state].tone);
  }
}
