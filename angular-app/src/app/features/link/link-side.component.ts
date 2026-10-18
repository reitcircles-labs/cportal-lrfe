import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkOwnersEditor} from './link-owners-editor';
import {checkLabel, initials} from './link-format';

/** Land record: the registered owners and the record checks, beside the tabs. */
@Component({
  selector: 'app-link-side',
  imports: [CanDirective],
  template: `
    <div class="panel">
      <div class="panel-head"><h4>Registered owners</h4>@if (store.editable()) { <button class="btn btn-ghost" style="min-height:30px" appCan="record.link" (click)="ownersEditor.editOwners()">Edit</button> }</div>
      <div class="panel-body">
        @if (store.owners().length) {
          @for (o of store.owners(); track o.name) {
            <div class="owner"><span class="av sm">{{ initials(o.name) }}</span>
              <span class="stack" style="gap:0;min-width:0"><b class="ell">{{ o.name }}</b><span class="small muted num">{{ o.idNo || 'No ID number' }}</span>
                <span class="small" [style.color]="o.source?.from === 'manual' ? 'var(--warn-fg)' : 'var(--color-neutral-600)'" [title]="o.source?.reason || ''">{{ o.source?.from === 'manual' ? 'Entered by hand' : o.since ? 'Under ' + o.since : 'From the documents' }}</span></span>
              <b class="num">{{ o.share }}</b></div>
          }
        } @else { <span class="small muted">No owners yet.</span> }
        @if (store.editable() && ownersEditor.suggestedOwnersDiffer()) {
          <div class="sugg">
            <span class="small"><b>From the documents:</b> {{ ownersEditor.suggestedOwnersText() }}</span>
            <button class="btn btn-secondary" style="min-height:32px" appCan="record.link" [disabled]="store.busy()" (click)="store.accept('owners')">Use these owners</button>
          </div>
        }
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h4>Record checks</h4><span class="small muted">{{ store.passing() }} / {{ store.required().length }} required</span></div>
      <div class="panel-body stack" style="gap:12px">
        @for (c of store.checks(); track c.id) {
          <div class="chk"><span class="check-mark" [class.ok]="c.ok" [class.bad]="!c.ok && c.level === 'error'">{{ c.ok ? '✓' : c.level === 'error' ? '✕' : '!' }}</span>
            <div><div style="font-size:13.5px;font-weight:600">{{ checkLabel(c) }}</div><div class="small muted">{{ c.message }}</div></div></div>
        } @empty { <span class="small muted">No checks yet.</span> }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .owner { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--color-divider); }
    .owner:last-of-type { border-bottom: 0; }
    .sugg { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: var(--color-accent-100); border: 1px solid var(--color-accent-300); }
  `,
  ],
})
export class LinkSideComponent {
  protected readonly store = inject(LinkStore);
  protected readonly ownersEditor = inject(LinkOwnersEditor);
  protected readonly initials = initials;
  protected readonly checkLabel = checkLabel;
}
