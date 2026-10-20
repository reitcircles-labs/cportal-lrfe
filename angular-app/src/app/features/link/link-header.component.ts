import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkLifecycle} from './link-lifecycle';
import {LinkDocumentDetailsComponent} from './link-document-details.component';
import {extentText, statusOf, tenureLabel} from './link-format';

/**
 * Land record: the header of the open record, its actions, and its notes: returned by the
 * reviewer, a newer version of a linked document, a new document filed for the parcel (API-766)
 * with adding or dismissing it, and the bin (API-767): moving there, restoring, discarding a draft.
 */
@Component({
  selector: 'app-link-header',
  imports: [IconComponent, CanDirective, LinkDocumentDetailsComponent],
  template: `
    @let r = store.rec()!;
    <header class="panel head">
      <div class="stack" style="gap:6px;min-width:0">
        <div class="row" style="gap:10px">
          <button class="btn btn-ghost btn-icon tog" (click)="store.listOpen.set(!store.listOpen())" [title]="store.listOpen() ? 'Hide record list' : 'Show record list'"><app-icon [name]="store.listOpen() ? 'panelClose' : 'panelOpen'" [size]="18" /></button>
          <span class="card-kicker num">{{ r.recordNo }} · {{ store.versionLabel() }}</span>
          <span class="tag" [class]="'tag ' + statusOf(r).tag">{{ statusOf(r).label }}</span>
        </div>
        <h1 class="rt">{{ r.label }}</h1>
        <div class="meta">
          @if (store.data()?.parcel?.regDiv) { <span>Reg. division {{ store.data()!.parcel.regDiv }}{{ store.data()!.parcel.region ? ' · ' + store.data()!.parcel.region : '' }}</span> }
          <span>Extent {{ extentText(store.data()?.extent) }}</span>
          <span>{{ tenureLabel(store.data()?.tenure) }}</span>
          <span>{{ store.docs().length }} linked document{{ store.docs().length === 1 ? '' : 's' }}</span>
          <span>Updated {{ store.fmt(r.updatedAt) }}</span>
        </div>
      </div>
      <div class="row">
        @if (r.inBin) {
          <button class="btn btn-secondary" appCan="record.create" [disabled]="store.busy()" (click)="lifecycle.restore()">Restore</button>
        } @else if (store.editable()) {
          <button class="btn btn-ghost danger" appCan="record.create" [disabled]="store.busy()" (click)="lifecycle.askBin()">{{ r.currentVersion ? 'Discard draft' : 'Move to bin' }}</button>
          <button class="btn btn-secondary" appCan="record.link" (click)="store.tab.set('documents'); store.addOpen.set(true)"><app-icon name="search" [size]="16" />Add documents</button>
          <button class="btn btn-primary" appCan="record.link" [disabled]="store.busy() || store.failing().length > 0" [title]="store.failing().length ? 'Every required check must pass first' : ''" (click)="lifecycle.submit()"><app-icon name="checkCircle" [size]="17" />Submit for review</button>
        } @else if (r.draftState === 'in_review') {
          @if (store.isSubmitter()) { <button class="btn btn-secondary" appCan="record.link" [disabled]="store.busy()" (click)="lifecycle.withdraw()">Withdraw from review</button> }
          <span class="small muted">Waiting for approval by a second person</span>
        } @else if (r.status === 'committed' && !r.draftVersion) {
          <button class="btn btn-secondary" appCan="record.link" [disabled]="store.busy()" (click)="lifecycle.change()">Change record</button>
        }
      </div>
    </header>

    @if (r.bin; as b) {
      <div class="note warn" role="status"><b>In the bin since {{ store.fmt(b.at) }}{{ b.byName ? ', moved by ' + b.byName : '' }}.</b> Reason: {{ b.reason }}
        <div class="small" style="margin-top:2px">It cannot be changed until it is restored.</div></div>
    }
    @if (r.draft?.reviewComment && r.draft?.state === 'draft') {
      <div class="note warn" role="status"><b>Returned by the reviewer:</b> {{ r.draft!.reviewComment }}</div>
    }
    @for (f of r.flags; track f.type + f.edrmsDocumentId) {
      @if (f.type === 'document_filed') {
        <div class="note info filed" role="status">
          <span class="stack" style="gap:2px;min-width:0;flex:1">
            <b>New document for this parcel: {{ f.ref || f.edrmsNo }}{{ f.docType ? ' (' + store.typeLabel(f.docType).toLowerCase() + ')' : '' }}</b>
            <span class="small">{{ f.matchedBy === 'chain' ? 'It names a title deed of this record as its prior title.' : 'Its property describes this parcel.' }}
              {{ r.draftState === 'in_review' ? 'Add it once the version in review is approved or returned.' : '' }}</span>
          </span>
          <span class="row" style="gap:6px;flex-wrap:nowrap">
            <app-link-document-details [documentId]="f.edrmsDocumentId" [name]="f.ref || f.edrmsNo" [edrmsNo]="f.edrmsNo" [typeLabel]="f.docType ? store.typeLabel(f.docType) : ''" />
            @if (r.draftState !== 'in_review') {
              <button class="btn btn-secondary" appCan="record.link" [disabled]="store.busy()" (click)="lifecycle.addFiled(f)">{{ r.draftVersion ? 'Add to the draft' : 'Open a change with it' }}</button>
            }
            <button class="btn btn-ghost" appCan="record.link" [disabled]="store.busy()" (click)="store.dismissReason.set(''); store.dismissing.set(f)">Dismiss</button>
          </span>
        </div>
      } @else {
        <div class="note warn" role="status"><b>{{ f.message }}</b>{{ f.reason ? ' Reason: ' + f.reason + '.' : '' }}
          {{ store.editable() ? 'Use the newer version in the documents below.' : r.draftVersion ? '' : 'Change the record to take it over.' }}</div>
      }
    }

    @if (store.dismissing(); as f) {
      <div class="dialog-backdrop" (click)="store.dismissing.set(null)">
        <form class="dialog" style="width:min(480px,100%)" aria-labelledby="dismiss-title" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); lifecycle.dismissFiled()">
          <div class="dialog-title" id="dismiss-title">Dismiss {{ f.ref || f.edrmsNo }}?</div>
          <div class="dialog-body">The record stays as it is and this document will not be offered for it again. The reason is kept in the History.</div>
          <div class="field" style="margin-top:12px"><label for="dismiss-reason">Reason</label>
            <textarea id="dismiss-reason" class="input" rows="3" style="height:auto;padding:8px 12px" [value]="store.dismissReason()" (input)="store.dismissReason.set($any($event.target).value)" placeholder="For example: a copy of a document already in the record"></textarea></div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="store.dismissing.set(null)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="store.busy() || !store.dismissReason().trim()">Dismiss</button>
          </div>
        </form>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .head { padding: 18px 20px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
    .rt { font-size: 28px; margin: 0; letter-spacing: -.02em; }
    .meta { display: flex; gap: 6px 18px; flex-wrap: wrap; font-size: 13.5px; color: var(--color-neutral-700); }
    .tog { width: 32px; height: 32px; margin-left: -6px; }
    .filed { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .field { display: flex; flex-direction: column; gap: 4px; }
  `,
  ],
})
export class LinkHeaderComponent {
  protected readonly store = inject(LinkStore);
  protected readonly lifecycle = inject(LinkLifecycle);
  protected readonly statusOf = statusOf;
  protected readonly tenureLabel = tenureLabel;
  protected readonly extentText = extentText;
}
