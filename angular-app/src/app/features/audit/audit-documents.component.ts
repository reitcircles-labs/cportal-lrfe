import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
} from '@angular/core';

import {InfoTipComponent} from '../../shared/info-tip.component';
import {DocFilter, DocGroup, Selection} from './audit-record.types';
import {AUDIT_SHARED_STYLES} from './audit-shared.styles';
import {TIPS} from './audit-wording';

const DOC_FILTERS: Array<{id: DocFilter; label: string}> = [
  {id: 'attention', label: 'Needs attention'},
  {id: 'new', label: 'New in this audit'},
  {id: 'all', label: 'All'},
];

/**
 * One land record's audit: the documents of the version shown, filtered and searched, grouped by
 * kind; picking one shows it in the detail panel, Review opens its review.
 */
@Component({
  selector: 'app-audit-documents',
  imports: [InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <div class="panel-head row" style="gap:10px">
        <h2 class="panel-title" style="flex:1 1 auto;padding:0">Documents in v{{ shownN() }}
          <span class="muted small">· {{ docCounts().all }} documents{{ shownN() === current() ? ' · the newest version' : '' }}</span></h2>
        @if (shownN() !== current()) {
          <button type="button" class="btn btn-secondary" (click)="showNewest()">Show v{{ current() }}, the newest</button>
        }
        <input class="input" type="search" placeholder="Search number or type" aria-label="Search documents" style="width:220px" (input)="typeDocQuery($event)" />
      </div>
      <div class="row filters" role="group" aria-label="Filter documents">
        @for (f of docFilters; track f.id) {
          <button type="button" class="chip" [class.on]="docFilter() === f.id" [attr.aria-pressed]="docFilter() === f.id" (click)="docFilter.set(f.id)">
            {{ f.label }} <strong>{{ docCounts()[f.id] }}</strong>
          </button>
        }
        <app-info-tip label="filters" [text]="tips.documentFilters" />
      </div>
      <div style="overflow-x:auto">
        <table class="table" style="min-width:680px">
          <thead><tr><th>Document</th><th>Added in</th><th>Blockchain check</th><th>Open issues</th><th><span class="sr-only">Review</span></th></tr></thead>
          @for (g of docGroups(); track g.kind) {
            <tbody>
              <tr class="group"><td colspan="5">{{ g.kind }} <span class="muted">· {{ g.docs.length }}</span></td></tr>
              @for (d of g.docs; track d.pin.edrmsDocumentId) {
                <tr [class.on]="isSelected({ kind: 'doc', id: d.pin.edrmsDocumentId })">
                  <td><button type="button" class="doc" (click)="select({ kind: 'doc', id: d.pin.edrmsDocumentId })">
                    <strong>{{ d.pin.ref || d.pin.edrmsNo }}</strong><span class="small muted">{{ d.pin.edrmsNo }}</span></button></td>
                  <td>v{{ d.addedIn }}</td>
                  <td><span [class]="'small ' + d.checkTone" style="font-weight:600">{{ d.checkLabel }}</span></td>
                  <td>
                    @if (d.issues.length) {
                      <button type="button" class="issue" (click)="select({ kind: 'doc', id: d.pin.edrmsDocumentId })">Open · {{ d.issues.join(' · ') }}</button>
                    }
                  </td>
                  <td style="text-align:right"><button type="button" class="btn btn-secondary" [attr.aria-label]="'Review ' + (d.pin.ref || d.pin.edrmsNo)" (click)="review(d.pin.edrmsDocumentId)">Review</button></td>
                </tr>
              }
            </tbody>
          } @empty {
            <tbody><tr><td colspan="5" class="muted">No documents match. Clear the search or pick another filter.</td></tr></tbody>
          }
        </table>
      </div>
    </section>
  `,
  styles: [
    AUDIT_SHARED_STYLES,
    `
    :host {
      display: contents;
    }
    tr.on {
      background: var(--color-accent-100);
      box-shadow: inset 3px 0 0 var(--color-accent);
    }
    .filters {
      padding: 10px 16px;
      gap: 8px;
      border-top: 1px solid var(--color-divider);
      border-bottom: 1px solid var(--color-divider);
    }
    .chip {
      min-height: 36px;
      padding: 0 14px;
      border-radius: 999px;
      border: 1px solid var(--color-divider);
      background: var(--color-surface);
      cursor: pointer;
      font: inherit;
    }
    .chip.on {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: #fff;
    }
    tr.group td {
      background: var(--color-neutral-100, #f7f9fb);
      font-weight: 600;
      font-size: 13px;
    }
    .doc {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      min-height: 44px;
      justify-content: center;
      border: 0;
      background: transparent;
      padding: 0;
      cursor: pointer;
      font: inherit;
      color: inherit;
      text-align: left;
    }
    .issue {
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--warn-bg);
      color: var(--warn-fg);
      border: 1px solid var(--warn-bd);
      cursor: pointer;
      text-align: left;
    }
  `,
  ],
})
export class AuditDocumentsComponent {
  /** The version whose documents are shown. */
  readonly shownN = input.required<number>();
  /** The current version of the land record. */
  readonly current = input.required<number>();
  readonly docCounts = input.required<Record<DocFilter, number>>();
  readonly docGroups = input.required<DocGroup[]>();
  /** What the detail panel shows, to mark the row of the document it shows. */
  readonly selected = input.required<Selection>();
  readonly docFilter = model.required<DocFilter>();
  /** Show the newest version's documents again. */
  readonly newestRequested = output<void>();
  /** The search text changed. */
  readonly queryChanged = output<string>();
  /** A document was picked, to show in the detail panel. */
  readonly docSelected = output<Selection>();
  /** Review was asked for a document: its id. */
  readonly reviewRequested = output<string>();

  protected readonly tips = TIPS;
  protected readonly docFilters = DOC_FILTERS;

  protected isSelected(selection: Selection): boolean {
    return JSON.stringify(this.selected()) === JSON.stringify(selection);
  }

  protected showNewest(): void {
    this.newestRequested.emit();
  }

  protected typeDocQuery(event: Event): void {
    this.queryChanged.emit((event.target as HTMLInputElement).value);
  }

  protected select(selection: Selection): void {
    this.docSelected.emit(selection);
  }

  protected review(documentId: string): void {
    this.reviewRequested.emit(documentId);
  }
}
