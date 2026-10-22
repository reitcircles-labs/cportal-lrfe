import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  untracked,
} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {ApiService} from '../../api/api.service';
import {IconComponent} from '../../shared/icon.component';
import {LinkChainTabComponent} from './link-chain-tab.component';
import {LinkCreateDialogComponent} from './link-create-dialog.component';
import {LinkDetailsTabComponent} from './link-details-tab.component';
import {LinkDiscussionTabComponent} from './link-discussion-tab.component';
import {LinkDocumentsTabComponent} from './link-documents-tab.component';
import {LinkHeaderComponent} from './link-header.component';
import {LinkHistoryTabComponent} from './link-history-tab.component';
import {LinkListComponent} from './link-list.component';
import {LinkOwnersDialogComponent} from './link-owners-dialog.component';
import {LinkReviewTabComponent} from './link-review-tab.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkSideComponent} from './link-side.component';
import {LinkBinDialogComponent} from './link-bin-dialog.component';
import {LinkStore} from './link.store';
import {LinkDetailsForm} from './link-details-form';
import {LinkOwnersEditor} from './link-owners-editor';
import {LinkCreateFlow} from './link-create-flow';
import {LinkDocumentsSearch} from './link-documents-search';
import {LinkDiscussion} from './link-discussion';
import {LinkReviewFlow} from './link-review-flow';
import {LinkLifecycle} from './link-lifecycle';
import {LinkExtracts} from './link-extracts';
import {LinkExtractsTabComponent} from './link-extracts-tab.component';

/**
 * Land records (#/link) on the land-records service: list and search records; a record's documents
 * (pinned EDRMS versions), chain of title, details, owners and checks; build a draft from filed
 * documents, accept or override the suggested owners and extent, submit it for review, withdraw it,
 * and open a change on a committed record. Whoever may finalize records reviews and approves a
 * submitted version on its Review & approve tab, or from the task inbox; the Discussion shows the
 * comments and the review decisions together (API-729).
 */
@Component({
  selector: 'app-link',
  imports: [
    IconComponent,
    LinkListComponent,
    LinkHeaderComponent,
    LinkDocumentsTabComponent,
    LinkChainTabComponent,
    LinkDetailsTabComponent,
    LinkHistoryTabComponent,
    LinkDiscussionTabComponent,
    LinkReviewTabComponent,
    LinkSideComponent,
    LinkCreateDialogComponent,
    LinkOwnersDialogComponent,
    LinkBinDialogComponent,
    LinkExtractsTabComponent,
  ],
  providers: [
    LinkStore,
    LinkDetailsForm,
    LinkOwnersEditor,
    LinkCreateFlow,
    LinkDocumentsSearch,
    LinkDiscussion,
    LinkReviewFlow,
    LinkLifecycle,
    LinkExtracts,
  ],
  template: `
    <div class="ws" [class.list-hidden]="!store.listOpen()">
      <!-- Land record list -->
      <aside class="list"><app-link-list /></aside>

      <!-- Selected record -->
      @if (store.rec()) {
        <section class="main">
          <app-link-header />

          <div class="body">
            <div class="stack" style="gap:16px;min-width:0">
              <nav class="tabs" role="tablist">
                <button role="tab" [attr.aria-selected]="store.tab() === 'documents'" [class.on]="store.tab() === 'documents'" (click)="store.tab.set('documents')">Documents <span>{{ store.docs().length }}</span></button>
                <button role="tab" [attr.aria-selected]="store.tab() === 'chain'" [class.on]="store.tab() === 'chain'" (click)="store.tab.set('chain')">Chain of title</button>
                <button role="tab" [attr.aria-selected]="store.tab() === 'details'" [class.on]="store.tab() === 'details'" (click)="store.tab.set('details')">Details</button>
                <button role="tab" [attr.aria-selected]="store.tab() === 'history'" [class.on]="store.tab() === 'history'" (click)="store.tab.set('history'); store.loadHistory()">History</button>
                <button role="tab" [attr.aria-selected]="store.tab() === 'discussion'" [class.on]="store.tab() === 'discussion'" (click)="store.tab.set('discussion'); store.loadDiscussion()">Discussion <span>{{ store.events().length }}</span></button>
                @if (extracts.allowed()) {
                  <button role="tab" [attr.aria-selected]="store.tab() === 'extracts'" [class.on]="store.tab() === 'extracts'" (click)="store.tab.set('extracts')">Extracts <span>{{ extracts.validCount() }}</span></button>
                }
                @if (store.rbac.can('record.finalize')) {
                  <button role="tab" [attr.aria-selected]="store.tab() === 'review'" [class.on]="store.tab() === 'review'" (click)="store.openReview()">Review &amp; approve @if (store.myTask()) { <span class="due" aria-hidden="true">1</span><span class="sr-only">(waiting for you)</span> }</button>
                }
              </nav>

              @if (store.tab() === 'documents') { <app-link-documents-tab /> }
              @if (store.tab() === 'chain') { <app-link-chain-tab /> }
              @if (store.tab() === 'details') { <app-link-details-tab /> }
              @if (store.tab() === 'history') { <app-link-history-tab /> }
              @if (store.tab() === 'discussion') { <app-link-discussion-tab /> }
              @if (store.tab() === 'review') { <app-link-review-tab /> }
              @if (store.tab() === 'extracts') { <app-link-extracts-tab /> }
            </div>

            <aside class="stack side" style="gap:16px"><app-link-side /></aside>
          </div>
        </section>
      } @else if (!store.loading()) {
        <section class="main"><div class="panel empty"><app-icon name="layers" [size]="28" /><b>No land record selected</b><span class="muted small">Pick a record from the list, or create one for a parcel.</span></div></section>
      }
    </div>

    <app-link-create-dialog />

    <app-link-owners-dialog />

    <app-link-bin-dialog />
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    .ws { display: grid; grid-template-columns: 320px minmax(0, 1fr); align-items: start; min-height: calc(100vh - var(--topbar-h)); }
    .ws.list-hidden { grid-template-columns: minmax(0, 1fr); }
    .ws.list-hidden .list { display: none; }
    .list { position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); display: flex; flex-direction: column; background: var(--color-surface); border-right: 1px solid var(--color-divider); }
    .main { padding: 20px 24px 40px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
    .side { position: sticky; top: calc(var(--topbar-h) + 16px); }
    /* six tabs: they wrap rather than hide the last one behind a scroll on narrow screens */
    .tabs { display: flex; flex-wrap: wrap; gap: 0 4px; border-bottom: 1px solid var(--color-divider); }
    .tabs button { border: 0; background: transparent; padding: 10px 14px; font-weight: 600; font-size: 14px; color: var(--color-neutral-700); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; display: flex; gap: 8px; align-items: center; white-space: nowrap; }
    .tabs button span { font-size: 11.5px; background: var(--color-neutral-200); color: var(--color-neutral-700); padding: 1px 7px; border-radius: 99px; }
    .tabs button:hover { color: var(--color-text); }
    .tabs button.on { color: var(--color-accent-600); border-bottom-color: var(--color-accent); }
    .tabs button.on span { background: var(--color-accent-100); color: var(--color-accent-700); }
    .tabs button span.due { background: var(--color-accent); color: #fff; }
    @media (max-width: 1440px) { .body { grid-template-columns: 1fr; } .side { position: static; } }
    @media (max-width: 900px) {
      .ws { grid-template-columns: 1fr; }
      .list { position: static; height: auto; max-height: 360px; border-right: 0; border-bottom: 1px solid var(--color-divider); }
      .main { padding: 16px; }
    }
  `,
  ],
})
export class LinkComponent {
  protected readonly store = inject(LinkStore);
  // created with the page, so a record's extracts are loaded when it is opened (API-692)
  protected readonly extracts = inject(LinkExtracts);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    // ?record=…&tab=review opens the record's Review & approve tab (the task inbox links there)
    this.route.queryParamMap.subscribe(p => {
      const r = p.get('record');
      const review = p.get('tab') === 'review';
      if (r && r !== this.store.selId()) {
        this.store.select(r, review ? 'review' : 'documents');
      } else if (r && review && this.store.tab() !== 'review') {
        this.store.openReview();
      }
    });
    this.api
      .get<{docTypes: Array<{id: string; label: string}>}>(
        '/document-catalogue',
      )
      .then(c => this.store.docTypes.set(c.docTypes))
      .catch(() => {});
    this.store.loadList();
    // keep the details form in step with the record shown
    // (not on every change: unsaved details survive adding a document or saving owners)
    effect(() => {
      const v = this.store.shownKey();
      untracked(() => this.store.resetDetails());
      void v;
    });
    // once the address names a record (a link, e.g. from the task inbox), it follows the record and the Review & approve
    // tab shown, so following such a link again always opens them; a plain #/link stays as it is
    effect(() => {
      const record = this.store.selId();
      const review = this.store.tab() === 'review';
      untracked(() => {
        if (!record || !this.route.snapshot.queryParamMap.has('record')) return;
        this.router.navigate([], {
          queryParams: {record, tab: review ? 'review' : null},
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      });
    });
  }
}
