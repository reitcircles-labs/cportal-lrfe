import {
  Component,
  DestroyRef,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import {VerifyDocumentComponent} from './verify-document.component';
import {VerifyQueueComponent} from './verify-queue.component';
import {VerifyStore} from './verify.store';

/**
 * #/verify — review AI extraction field by field against the scan, its evidence and the checks,
 * then file the verified values into the EDRMS (intake service). Opening a document claims it,
 * so two reviewers do not work on the same one; the claim is released on leaving it.
 */
@Component({
  selector: 'app-verify',
  imports: [VerifyQueueComponent, VerifyDocumentComponent],
  providers: [VerifyStore],
  template: `
    <div class="shell" [class.collapsed]="!store.railOpen()">
      <app-verify-queue />

      <app-verify-document />
    </div>

    @if (store.rejectDraft() !== null) {
      <div class="dialog-backdrop" (click)="store.rejectDraft.set(null)">
        <form class="dialog" style="width:min(520px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); store.reject()">
          <div class="dialog-title">Reject {{ store.doc()?.ref || store.doc()?.fileName }}?</div>
          <div class="dialog-body">The document is kept, but will not be filed. Say why, for example: not a land-registry instrument, a duplicate, unreadable.</div>
          <div class="field"><label for="why">Reason (required)</label><textarea id="why" class="input" rows="2" [value]="store.rejectDraft()" (input)="store.rejectDraft.set($any($event.target).value)"></textarea></div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-secondary" (click)="store.rejectDraft.set(null)">Cancel</button>
            <button type="submit" class="btn btn-danger" [disabled]="store.busy() || store.rejectDraft()!.trim().length < 3">Reject</button>
          </div>
        </form>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .shell { display: grid; grid-template-columns: 300px minmax(0, 1fr); align-items: start; max-width: 1560px; margin: 0 auto; }
    .shell.collapsed { grid-template-columns: 44px minmax(0, 1fr); }
    textarea.input { resize: vertical; font: inherit; }
    @media (max-width: 900px) { .shell { grid-template-columns: 44px minmax(0, 1fr); } }
  `,
  ],
})
export class VerifyComponent {
  protected readonly store = inject(VerifyStore);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.store.destroy());
  }
}
