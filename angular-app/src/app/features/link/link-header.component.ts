import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';

/** Land record: the header of the open record, its actions, and its notes (returned, newer documents). */
@Component({
  selector: 'app-link-header',
  imports: [IconComponent, CanDirective],
  template: `
    @let r = store.rec()!;
    <header class="panel head">
      <div class="stack" style="gap:6px;min-width:0">
        <div class="row" style="gap:10px">
          <button class="btn btn-ghost btn-icon tog" (click)="store.listOpen.set(!store.listOpen())" [title]="store.listOpen() ? 'Hide record list' : 'Show record list'"><app-icon [name]="store.listOpen() ? 'panelClose' : 'panelOpen'" [size]="18" /></button>
          <span class="card-kicker num">{{ r.recordNo }} · {{ store.versionLabel() }}</span>
          <span class="tag" [class]="'tag ' + store.statusOf(r).tag">{{ store.statusOf(r).label }}</span>
        </div>
        <h1 class="rt">{{ r.label }}</h1>
        <div class="meta">
          @if (store.data()?.parcel?.regDiv) { <span>Reg. division {{ store.data()!.parcel.regDiv }}{{ store.data()!.parcel.region ? ' · ' + store.data()!.parcel.region : '' }}</span> }
          <span>Extent {{ store.extentText(store.data()?.extent) }}</span>
          <span>{{ store.tenureLabel(store.data()?.tenure) }}</span>
          <span>{{ store.docs().length }} linked document{{ store.docs().length === 1 ? '' : 's' }}</span>
          <span>Updated {{ store.fmt(r.updatedAt) }}</span>
        </div>
      </div>
      <div class="row">
        @if (store.editable()) {
          <button class="btn btn-secondary" appCan="record.link" (click)="store.tab.set('documents'); store.addOpen.set(true)"><app-icon name="search" [size]="16" />Add documents</button>
          <button class="btn btn-primary" appCan="record.link" [disabled]="store.busy() || store.failing().length > 0" [title]="store.failing().length ? 'Every required check must pass first' : ''" (click)="store.submit()"><app-icon name="checkCircle" [size]="17" />Submit for review</button>
        } @else if (r.draftState === 'in_review') {
          @if (store.isSubmitter()) { <button class="btn btn-secondary" appCan="record.link" [disabled]="store.busy()" (click)="store.withdraw()">Withdraw from review</button> }
          <span class="small muted">Waiting for approval by a second person</span>
        } @else if (r.status === 'committed' && !r.draftVersion) {
          <button class="btn btn-secondary" appCan="record.link" [disabled]="store.busy()" (click)="store.change()">Change record</button>
        }
      </div>
    </header>

    @if (r.draft?.reviewComment && r.draft?.state === 'draft') {
      <div class="note warn" role="status"><b>Returned by the reviewer:</b> {{ r.draft!.reviewComment }}</div>
    }
    @for (f of r.flags; track f.edrmsDocumentId) {
      <div class="note warn" role="status"><b>{{ f.message }}</b>{{ f.reason ? ' Reason: ' + f.reason + '.' : '' }}
        {{ store.editable() ? 'Use the newer version in the documents below.' : r.draftVersion ? '' : 'Change the record to take it over.' }}</div>
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
  `,
  ],
})
export class LinkHeaderComponent {
  protected readonly store = inject(LinkStore);
}
