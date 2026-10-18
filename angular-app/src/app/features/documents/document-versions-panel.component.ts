import {
  Component,
  computed,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import {fmtTime} from '../../state/rbac.service';
import {anchoringLabel, anchoringTag} from '../../shared/anchoring';
import {BlockchainVerifyComponent} from '../../shared/blockchain-verify.component';
import {ProofDownloadComponent} from '../../shared/proof-download.component';
import {ProofLinkComponent} from '../../shared/proof-link.component';
import {DocDetail} from './documents.types';

/** Documents: the version history of the open document, with each version's blockchain proof. */
@Component({
  selector: 'app-document-versions-panel',
  imports: [
    ProofLinkComponent,
    ProofDownloadComponent,
    BlockchainVerifyComponent,
  ],
  template: `
    @let d = doc();
    <div class="panel">
      <div class="panel-head"><h3>Version history</h3><span class="small muted">every version is sealed and kept</span></div>
      <div class="panel-body stack" style="gap:14px">
        @for (v of versionsDesc(); track v.versionNumber) {
          <div class="ver">
            <div class="row" style="justify-content:space-between;gap:8px"><b>v{{ v.label }} · {{ v.kind === 'filed' ? 'Filed' : 'Amendment' }}</b><span class="small muted">{{ fmt(v.createdAt) }}</span></div>
            <div class="small">{{ v.kind === 'filed' ? 'Filed by ' + (v.createdByName || '—') : 'Requested by ' + (v.createdByName || '—') + ' · approved by ' + (v.approvedByName || '—') }}</div>
            @if (v.reason) { <div class="small muted">“{{ v.reason }}”</div> }
            @for (c of v.changes; track c.k) { <div class="small"><span class="muted">{{ c.k }}:</span> <span class="strike">{{ c.from }}</span> → <b>{{ c.to }}</b></div> }
            <div class="small mono muted" [title]="'content SHA-256 ' + v.sha256 + ' · seal ' + v.seal">sha256 {{ v.sha256.slice(0, 12) }}… · seal {{ v.seal.slice(0, 12) }}…</div>
            @if (v.anchoring; as a) {
              <div class="row" style="gap:8px;align-items:center"><app-proof-link [label]="anchoringLabel(a)" [tagClass]="anchoringTag(a)" [batch]="a.batch" />
                <app-proof-download kind="document-version" [itemId]="d.id" [version]="v.versionNumber" [fileName]="'proof-' + d.edrmsNo + '-v' + v.versionNumber + '.json'" [waiting]="a.status === 'waiting'" /></div>
              <app-blockchain-verify kind="document-version" [itemId]="d.id" [version]="v.versionNumber" />
            }
          </div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .ver { display: flex; flex-direction: column; gap: 3px; padding-left: 12px; border-left: 2px solid var(--color-divider); }
    .strike { text-decoration: line-through; color: var(--color-neutral-600); }
  `,
  ],
})
export class DocumentVersionsPanelComponent {
  doc = input.required<DocDetail>();

  fmt = fmtTime;
  anchoringLabel = anchoringLabel;
  anchoringTag = anchoringTag;
  versionsDesc = computed(() => [...(this.doc().versions || [])].reverse());
}
