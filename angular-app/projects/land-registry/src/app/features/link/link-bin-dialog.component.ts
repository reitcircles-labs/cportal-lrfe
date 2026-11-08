import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkLifecycle} from './link-lifecycle';

/**
 * Land record: the bin dialog (API-767). Moving a record that was never approved to the bin, or
 * discarding the open draft of an approved record: what happens, and the reason, which the
 * History keeps.
 */
@Component({
  selector: 'app-link-bin-dialog',
  template: `
    @if (store.binning(); as what) {
      @let r = store.rec()!;
      <div class="dialog-backdrop" (click)="store.binning.set(null)">
        <form class="dialog" style="width:min(560px,100%)" aria-labelledby="bin-title" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); lifecycle.bin()">
          <div class="dialog-title" id="bin-title">{{ what === 'record' ? 'Move to bin' : 'Discard draft version ' + r.draftVersion }}</div>
          <div class="dialog-body"><span class="num">{{ r.recordNo }}</span> · {{ r.label }} · {{ what === 'record' ? 'draft version 1, never approved' : 'version ' + r.currentVersion + ' is current' }}</div>
          <ul class="effects">
            @if (what === 'record') {
              <li>The record leaves the record list and the work lists. It is kept, not deleted, under “In the bin”.</li>
              <li>{{ r.label }} is free again: a new record can be created for it.</li>
              <li>Its {{ store.docs().length }} {{ store.docs().length === 1 ? 'document is' : 'documents are' }} no longer shown as part of it.</li>
              <li>The record number stays used. Nothing of this record was approved or put on the blockchain.</li>
            } @else {
              <li>The changes in draft version {{ r.draftVersion }} are dropped. Version {{ r.currentVersion }} stays as it is.</li>
              <li>A new change can be opened afterwards.</li>
              <li>The History keeps what the draft changed, who discarded it, when and why.</li>
            }
          </ul>
          <div class="field"><label for="bin-reason">Reason <span class="muted" style="font-weight:400">(required, shown in History)</span></label>
            <textarea id="bin-reason" class="input" rows="3" style="height:auto;padding:8px 12px" [value]="store.binReason()" (input)="store.binReason.set($any($event.target).value)"></textarea></div>
          @if (what === 'record') {
            <div class="note info" style="margin-top:12px">You can restore it from “In the bin” as long as no other record has been created for this parcel.</div>
          }
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="store.binning.set(null)">Cancel</button>
            <button type="submit" class="btn btn-danger" [disabled]="store.busy() || !store.binReason().trim()">{{ what === 'record' ? 'Move to bin' : 'Discard draft' }}</button>
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
    .effects { margin: 12px 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
  `,
  ],
})
export class LinkBinDialogComponent {
  protected readonly store = inject(LinkStore);
  protected readonly lifecycle = inject(LinkLifecycle);
}
