import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkDocumentsSearch} from './link-documents-search';
import {linkedText} from './link-format';

/** Land record, Documents tab: the linked documents and, on a draft, adding documents from the EDRMS. */
@Component({
  selector: 'app-link-documents-tab',
  imports: [IconComponent, CanDirective],
  template: `
    <div class="panel">
      <div class="panel-head"><h4>Linked documents</h4></div>
      @if (store.docs().length) {
        <div style="overflow-x:auto">
          <table class="table">
            <thead><tr><th>Document</th><th>Property</th><th>EDRMS ID</th><th></th></tr></thead>
            <tbody>
              @for (d of store.docs(); track d.edrmsDocumentId) {
                <tr>
                  <td><div class="dcell"><span class="di"><app-icon name="file" [size]="16" /></span><span class="stack" style="gap:0"><b class="num">{{ d.ref || d.edrmsNo }}</b><span class="small muted">{{ store.typeLabel(d.docType) }}</span></span></div></td>
                  <td style="font-size:13.5px">{{ d.fields['property'] || '—' }}</td>
                  <td class="small muted num">{{ d.edrmsNo }} · v{{ d.version }}.0</td>
                  <td style="text-align:right;white-space:nowrap">
                    @if (documents.newer(d); as to) {
                      @if (store.editable()) { <button class="btn btn-secondary" style="min-height:32px" appCan="record.link" [disabled]="store.busy()" (click)="documents.refresh(d)">Use v{{ to }}.0</button> }
                      @else { <span class="tag tag-outline">v{{ to }}.0 in EDRMS</span> }
                    }
                    <button class="btn btn-ghost btn-icon" title="View document" aria-label="View document" (click)="documents.view(d.edrmsDocumentId, d.version)"><app-icon name="eye" [size]="17" /></button>
                    @if (store.editable()) { <button class="btn btn-ghost btn-icon danger" title="Remove from record" aria-label="Remove from record" appCan="record.unlink" (click)="documents.remove(d)"><app-icon name="x" [size]="17" /></button> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="empty"><app-icon name="layers" [size]="28" /><b>No documents linked yet</b><span class="muted small">Search the EDRMS below and add the deeds, grants and diagrams that make up this record.</span></div>
      }
    </div>

    @if (store.editable()) {
      <div class="panel">
        <button class="panel-head add-head" (click)="store.addOpen.set(!store.addOpen())">
          <span class="stack" style="gap:2px;text-align:left"><h4>Add documents from the EDRMS</h4><span class="small muted">Filed documents, found by their verified details</span></span>
          <span class="chev" [class.open]="store.addOpen()">▾</span>
        </button>
        @if (store.addOpen()) {
          <div class="panel-body stack" style="gap:12px">
            <div class="row">
              <div class="seg">
                <label class="seg-opt"><input type="radio" name="pf" [checked]="store.mode() === 'match'" (change)="documents.setMode('match')">Matching this parcel</label>
                <label class="seg-opt"><input type="radio" name="pf" [checked]="store.mode() === 'search'" (change)="documents.setMode('search')">Search</label>
              </div>
              @if (store.mode() === 'search') {
                <div class="search" style="flex:1;min-width:220px"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, party name or EDRMS ID" [value]="store.dq()" (input)="documents.searchDocs($any($event.target).value)" aria-label="Search EDRMS documents"></div>
              }
            </div>
            <div class="results">
              @for (p of store.found(); track p.edrmsDocumentId) {
                <div class="res" [class.match]="!!p.reasons?.length && !p.inThisRecord">
                  <div class="stack" style="gap:2px;min-width:0">
                    <span class="row" style="gap:8px"><b class="num">{{ p.ref || p.edrmsNo }}</b><span class="small muted">{{ store.typeLabel(p.docType) }} · {{ p.edrmsNo }}</span></span>
                    <span style="font-size:13px" class="ell">{{ p.property || p.title }}</span>
                    @for (why of p.reasons || []; track why) { <span class="small" style="color:var(--color-accent-700)">{{ why }}</span> }
                    @if (p.linkedTo.length) { <span class="small muted">Also in {{ linkedText(p) }}</span> }
                  </div>
                  <div class="row" style="gap:6px;flex-wrap:nowrap">
                    <button class="btn btn-ghost btn-icon" title="Preview" aria-label="Preview" (click)="documents.view(p.edrmsDocumentId)"><app-icon name="eye" [size]="17" /></button>
                    @if (p.inThisRecord) { <span class="tag tag-info">In this record</span> }
                    @else { <button class="btn btn-secondary" appCan="record.link" [disabled]="store.busy()" (click)="documents.add(p)">+ Add</button> }
                  </div>
                </div>
              } @empty {
                <div class="small muted" style="padding:18px;text-align:center">{{ store.finding() ? 'Searching…' : store.mode() === 'match' ? 'No filed documents match this parcel yet. Try Search.' : store.dq().trim() ? 'No documents match your search.' : 'Type to search the EDRMS.' }}</div>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .dcell { display: flex; gap: 10px; align-items: center; }
    .dcell b { white-space: nowrap; }
    .di { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; flex: none; background: var(--color-accent-100); color: var(--color-accent-600); }
    .add-head { width: 100%; border: 0; background: transparent; cursor: pointer; border-bottom: 1px solid var(--color-divider); }
    .chev { font-size: 16px; color: var(--color-neutral-600); transition: transform .15s; transform: rotate(-90deg); }
    .chev.open { transform: none; }
  `,
  ],
})
export class LinkDocumentsTabComponent {
  protected readonly store = inject(LinkStore);
  protected readonly documents = inject(LinkDocumentsSearch);
  protected readonly linkedText = linkedText;
}
