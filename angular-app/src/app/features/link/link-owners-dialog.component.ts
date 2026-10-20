import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkOwnersEditor} from './link-owners-editor';

/** Land record: the dialog that edits the registered owners of a draft. */
@Component({
  selector: 'app-link-owners-dialog',
  imports: [IconComponent],
  template: `
    @if (store.ownerForm(); as of) {
      <div class="dialog-backdrop" (click)="store.ownerForm.set(null)">
        <form class="dialog" style="width:min(640px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); ownersEditor.saveOwners()">
          <div class="dialog-title">Registered owners</div>
          <div class="dialog-body">Owners that differ from what the documents say are marked as entered by hand and shown to the reviewer.</div>
          <div class="stack" style="gap:8px">
            @for (o of of.owners; track $index; let i = $index) {
              <div class="orow">
                <input class="input" placeholder="Name" aria-label="Owner name" [value]="o.name" (input)="ownersEditor.setOwner(i, 'name', $any($event.target).value)">
                <input class="input num" placeholder="ID number" aria-label="ID number" [value]="o.idNo || ''" (input)="ownersEditor.setOwner(i, 'idNo', $any($event.target).value)">
                <input class="input num" placeholder="Share, e.g. 1/2" aria-label="Share" [value]="o.share" (input)="ownersEditor.setOwner(i, 'share', $any($event.target).value)">
                <button type="button" class="btn btn-ghost btn-icon danger" title="Remove" aria-label="Remove" (click)="ownersEditor.removeOwner(i)"><app-icon name="x" [size]="16" /></button>
              </div>
            }
            <button type="button" class="btn btn-ghost" style="min-height:30px;align-self:flex-start" (click)="ownersEditor.addOwner()">+ Add owner</button>
            <div class="field"><label for="oreason">Reason (needed for owners not as in the documents)</label><input id="oreason" class="input" [value]="of.reason" (input)="ownersEditor.setOwnerReason($any($event.target).value)"></div>
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="store.ownerForm.set(null)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="store.busy()">Save owners</button>
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
    .orow { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 6px; }
    @media (max-width: 900px) { .orow { grid-template-columns: 1fr; } }
  `,
  ],
})
export class LinkOwnersDialogComponent {
  protected readonly store = inject(LinkStore);
  protected readonly ownersEditor = inject(LinkOwnersEditor);
}
