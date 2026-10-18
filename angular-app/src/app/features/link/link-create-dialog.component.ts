import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';

/** Land records: the dialog that creates a record from a filed document or for a parcel. */
@Component({
  selector: 'app-link-create-dialog',
  imports: [IconComponent],
  template: `
    @if (store.createOpen()) {
      <div class="dialog-backdrop" (click)="store.createOpen.set(false)">
        <form class="dialog" style="width:min(560px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); store.create()">
          <div class="dialog-title">New land record</div>
          <div class="seg" style="margin:4px 0 10px">
            <label class="seg-opt"><input type="radio" name="cm" [checked]="store.cmode() === 'doc'" (change)="store.cmode.set('doc')">From a filed document</label>
            <label class="seg-opt"><input type="radio" name="cm" [checked]="store.cmode() === 'parcel'" (change)="store.cmode.set('parcel')">For a parcel</label>
          </div>
          @if (store.cmode() === 'doc') {
            <div class="dialog-body">The parcel is read from the document, and the document is linked to the new record.</div>
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, party name or EDRMS ID" [value]="store.cq()" (input)="store.searchCreate($any($event.target).value)" aria-label="Find a filed document"></div>
            <div class="results" style="max-height:280px;overflow-y:auto;margin-top:10px">
              @for (p of store.cfound(); track p.edrmsDocumentId) {
                <label class="res pick" [class.match]="store.cpick() === p.edrmsDocumentId">
                  <input type="radio" name="cpick" [checked]="store.cpick() === p.edrmsDocumentId" (change)="store.cpick.set(p.edrmsDocumentId)">
                  <span class="stack" style="gap:2px;min-width:0"><b class="num">{{ p.ref || p.edrmsNo }}</b><span class="small muted ell">{{ store.typeLabel(p.docType) }} · {{ p.property || p.title }}</span>
                    @if (p.linkedTo.length) { <span class="small muted">Already in {{ store.linkedText(p) }}</span> }</span>
                </label>
              } @empty { <div class="small muted" style="padding:12px;text-align:center">{{ store.cq().trim() ? 'No documents match.' : 'Type to search the EDRMS.' }}</div> }
            </div>
          } @else {
            <div class="form-grid">
              <div class="field" style="grid-column:1/-1"><label for="kind">Kind of parcel</label>
                <select id="kind" class="input" (change)="store.ckind.set($any($event.target).value)">
                  @for (k of store.kinds(); track k.id) { <option [value]="k.id" [selected]="k.id === store.ckind()">{{ k.label }}</option> }
                </select></div>
              @for (f of store.kindFields(); track f.k) {
                <div class="field"><label [for]="'pf-' + f.k">{{ store.parcelLabel(f.k) }}{{ f.required ? '' : ' (optional)' }}</label>
                  <input class="input" [id]="'pf-' + f.k" [value]="store.cparcel()[f.k] || ''" (input)="store.setParcel(f.k, $any($event.target).value)"></div>
              }
            </div>
          }
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="store.createOpen.set(false)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="store.busy() || !store.canCreate()">Create record</button>
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
  `,
  ],
})
export class LinkCreateDialogComponent {
  protected readonly store = inject(LinkStore);
}
