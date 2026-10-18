import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkDetailsForm} from './link-details-form';
import {extentText, parcelLabel} from './link-format';

/** Land record, Details tab: the parcel, and the tenure, extent, encumbrances and attributes form. */
@Component({
  selector: 'app-link-details-tab',
  imports: [IconComponent, CanDirective],
  template: `
    <div class="panel">
      <div class="panel-head"><h4>Parcel</h4></div>
      <div class="panel-body kv">
        @for (k of form.parcelKeys(); track k) { <span>{{ parcelLabel(k) }}</span><span>{{ store.data()!.parcel[k] }}</span> }
      </div>
    </div>
    <form class="panel" (submit)="$event.preventDefault(); form.saveDetails()">
      <div class="panel-head"><h4>Details</h4>@if (!store.editable()) { <span class="small muted">Change the record to edit</span> }</div>
      <div class="panel-body stack" style="gap:14px">
        <div class="form-grid">
          <div class="field"><label for="ten">Tenure</label>
            <select id="ten" class="input" [disabled]="!store.editable()" (change)="form.setDf('tenure', $any($event.target).value)">
              @for (o of form.tenures; track o.id) { <option [value]="o.id" [selected]="o.id === store.df().tenure">{{ o.label }}</option> }
            </select></div>
          <div class="field"><label for="ext">Extent</label>
            <div class="row" style="gap:6px;flex-wrap:nowrap">
              <input id="ext" class="input num" inputmode="decimal" [readonly]="!store.editable()" [value]="store.df().extent" (input)="form.setDf('extent', $any($event.target).value)">
              <select class="input" style="width:90px" aria-label="Extent unit" [disabled]="!store.editable()" (change)="form.setDf('unit', $any($event.target).value)">@for (o of form.units; track o.id) { <option [value]="o.id" [selected]="o.id === store.df().unit">{{ o.label }}</option> }</select>
            </div>
            @if (store.shown()?.data?.extent?.source; as s) { <span class="small muted">{{ s.from === 'document' ? 'From ' + s.edrmsNo : 'Entered by hand' + (s.reason ? ': ' + s.reason : '') }}</span> }
            @if (store.editable() && form.suggestedExtentDiffers()) {
              <button type="button" class="btn btn-ghost" style="min-height:30px;justify-self:start" appCan="record.link" (click)="store.accept('extent')">Use {{ extentText(store.shown()!.derived!.extent) }} from the documents</button>
            }
          </div>
        </div>
        <div class="stack" style="gap:6px">
          <b style="font-size:13.5px">Encumbrances</b>
          @for (e of store.df().encumbrances; track $index; let i = $index) {
            <div class="row" style="gap:6px;flex-wrap:nowrap">
              <select class="input" style="width:130px" aria-label="Type" [disabled]="!store.editable()" (change)="form.setEnc(i, 'type', $any($event.target).value)">@for (o of form.encumbranceTypes; track o.id) { <option [value]="o.id" [selected]="o.id === e.type">{{ o.label }}</option> }</select>
              <input class="input" placeholder="Reference" aria-label="Reference" [readonly]="!store.editable()" [value]="e.ref" (input)="form.setEnc(i, 'ref', $any($event.target).value)">
              <input class="input" placeholder="In favour of" aria-label="In favour of" [readonly]="!store.editable()" [value]="e.inFavourOf || ''" (input)="form.setEnc(i, 'inFavourOf', $any($event.target).value)">
              @if (store.editable()) { <button type="button" class="btn btn-ghost btn-icon danger" title="Remove" aria-label="Remove" (click)="form.removeEnc(i)"><app-icon name="x" [size]="16" /></button> }
            </div>
          } @empty { <span class="small muted">None</span> }
          @if (store.editable() && form.offeredEncumbrances(); as o) {
            <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" appCan="record.link" (click)="form.acceptEncumbrances(o)">{{ o.label }}</button>
          }
          @if (store.editable()) { <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" (click)="form.addEnc()">+ Add encumbrance</button> }
        </div>
        <div class="stack" style="gap:6px">
          <b style="font-size:13.5px">Other attributes</b>
          @for (a of store.df().attributes; track $index; let i = $index) {
            <div class="row" style="gap:6px;flex-wrap:nowrap">
              <input class="input" placeholder="Name, e.g. zoning" aria-label="Attribute name" [readonly]="!store.editable()" [value]="a.k" (input)="form.setAttr(i, 'k', $any($event.target).value)">
              <input class="input" placeholder="Value" aria-label="Attribute value" [readonly]="!store.editable()" [value]="a.v" (input)="form.setAttr(i, 'v', $any($event.target).value)">
              @if (store.editable()) { <button type="button" class="btn btn-ghost btn-icon danger" title="Remove" aria-label="Remove" (click)="form.removeAttr(i)"><app-icon name="x" [size]="16" /></button> }
            </div>
          } @empty { <span class="small muted">None</span> }
          @if (store.editable()) { <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" (click)="form.addAttr()">+ Add attribute</button> }
        </div>
        @if (store.editable()) {
          @if (form.extentByHand()) {
            <div class="field"><label for="dreason">Reason for the extent entered by hand</label><input id="dreason" class="input" [value]="store.df().reason" (input)="form.setDf('reason', $any($event.target).value)" placeholder="e.g. as on the approved diagram"></div>
          }
          <div class="row" style="justify-content:flex-end"><button type="submit" class="btn btn-primary" appCan="record.link" [disabled]="store.busy()">Save details</button></div>
        }
      </div>
    </form>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
  `,
  ],
})
export class LinkDetailsTabComponent {
  protected readonly store = inject(LinkStore);
  protected readonly form = inject(LinkDetailsForm);
  protected readonly parcelLabel = parcelLabel;
  protected readonly extentText = extentText;
}
