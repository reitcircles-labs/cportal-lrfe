import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {RecordDiffComponent} from '../../shared/record-diff.component';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {ProofDownloadComponent} from '../../shared/proof-download.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';

/** Land record, History tab: the committed versions with their seals and proofs. */
@Component({
  selector: 'app-link-history-tab',
  imports: [RecordDiffComponent, ProofLinkComponent, ProofDownloadComponent],
  template: `
    @let r = store.rec()!;
    <div class="panel">
      <div class="panel-head"><h4>Committed versions</h4>
        @if (store.history(); as h) { @if (h.versions.length) { <span class="tag" [class]="'tag ' + (h.intact ? 'tag-accent' : 'tag-danger')">{{ h.intact ? 'Seal chain intact' : 'Seal chain broken' }}</span> } }</div>
      <div class="panel-body stack" style="gap:18px">
        @for (v of store.history()?.versions || []; track v.versionNumber) {
          <div class="hv">
            <div class="row" style="justify-content:space-between;gap:8px">
              <b>Version {{ v.versionNumber }}{{ v.current ? ' · current' : '' }}</b>
              <span class="tag" [class]="'tag ' + (v.intact && v.linked ? 'tag-accent' : 'tag-danger')" [title]="'seal ' + v.seal">{{ v.intact && v.linked ? 'Seal verified' : v.intact ? 'Seal chain broken here' : 'Seal does not match' }}</span>
            </div>
            <div class="small muted">Committed {{ store.fmt(v.committedAt) }} · submitted by {{ v.submittedByName || '—' }} · approved by {{ v.approvedByName || '—' }}</div>
            @if (v.reviewComment) { <div class="small">Reviewer: {{ v.reviewComment }}</div> }
            <div class="row small" style="gap:8px;align-items:center"><span class="mono muted">seal {{ v.seal.slice(0, 16) }}…</span>
              @if (v.anchoring; as a) { <app-proof-link [label]="store.anchoringLabel(a)" [tagClass]="store.anchoringTag(a)" [batch]="a.batch" />
                <app-proof-download kind="record-version" [itemId]="r.id" [version]="v.versionNumber" [fileName]="'proof-' + r.recordNo + '-v' + v.versionNumber + '.json'" [waiting]="a.status === 'waiting'" /> }</div>
            <app-record-diff [diff]="v.diff" />
          </div>
        } @empty { <div class="small muted" style="text-align:center;padding:12px">{{ store.history() ? 'No committed version yet.' : store.historyFailed() ? 'The history could not be loaded.' : 'Loading…' }}</div> }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .hv { display: flex; flex-direction: column; gap: 6px; padding-bottom: 16px; border-bottom: 1px solid var(--color-divider); }
    .hv:last-child { border-bottom: 0; padding-bottom: 0; }
  `,
  ],
})
export class LinkHistoryTabComponent {
  protected readonly store = inject(LinkStore);
}
