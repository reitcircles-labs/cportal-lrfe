import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkDocumentsSearch} from './link-documents-search';

/** Land record, Chain of title tab: the title deeds in order. */
@Component({
  selector: 'app-link-chain-tab',
  imports: [IconComponent],
  template: `
    <div class="panel panel-body">
      @for (e of store.chain(); track e.ref; let last = $last) {
        <div class="ev">
          <div class="when"><b class="num">{{ e.date ? e.date.slice(0, 4) : '—' }}</b></div>
          <div class="spine"><i></i><b class="ok"></b>@if (!last) { <i style="flex:1"></i> }</div>
          <div class="evc">
            <div class="row" style="justify-content:space-between"><b>{{ store.typeLabel(e.docType) }} · <span class="num">{{ e.ref }}</span></b>
              <button class="btn btn-ghost" style="min-height:30px" (click)="documents.viewByNo(e.edrmsNo)"><app-icon name="eye" [size]="15" />View</button></div>
            <div style="font-size:13.5px;color:var(--color-neutral-800)">
              {{ e.transferor ? e.transferor + ' → ' : '' }}{{ e.holders.join(', ') || '—' }}{{ e.regDate ? ' · registered ' + e.regDate : '' }}{{ e.priorTitle ? ' · held under ' + e.priorTitle : '' }}
            </div>
          </div>
        </div>
      } @empty { <div class="muted small" style="text-align:center;padding:18px">Link title deeds to build the chain of title.</div> }
      @for (n of store.shown()?.derived?.notes || []; track n) { <div class="small muted" style="padding-top:6px">{{ n }}</div> }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .ev { display: grid; grid-template-columns: 56px 18px minmax(0, 1fr); gap: 0 12px; }
    .when { padding-top: 12px; text-align: right; font-size: 16px; }
    .spine { display: flex; flex-direction: column; align-items: center; }
    .spine i { width: 2px; height: 16px; background: var(--color-divider); display: block; }
    .spine b { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--color-accent); background: var(--color-surface); display: block; }
    .spine b.ok { background: var(--color-accent); }
    .evc { padding: 10px 0 18px; }
  `,
  ],
})
export class LinkChainTabComponent {
  protected readonly store = inject(LinkStore);
  protected readonly documents = inject(LinkDocumentsSearch);
}
