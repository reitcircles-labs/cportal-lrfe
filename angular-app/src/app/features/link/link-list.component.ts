import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkCreateFlow} from './link-create-flow';
import {dot, statusOf} from './link-format';

/** Land records: the list of records, with search and status filters. */
@Component({
  selector: 'app-link-list',
  imports: [IconComponent, CanDirective],
  template: `
    <div class="list-head">
      <div class="row" style="justify-content:space-between">
        <h4 style="margin:0">Land records</h4>
        <button class="btn btn-primary" style="min-height:34px;padding:0 12px" appCan="record.create" (click)="creating.openCreate()"><span style="font-size:18px;line-height:0">+</span>New record</button>
      </div>
      <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Record no., parcel, owner or deed" [value]="store.q()" (input)="store.search($any($event.target).value)" aria-label="Search land records"></div>
      <div class="chips">
        @for (f of store.filters(); track f.id) {
          <button class="chip" [class.on]="store.sf() === f.id" (click)="store.sf.set(f.id)">{{ f.label }} <b>{{ f.n }}</b></button>
        }
      </div>
    </div>
    <div class="list-body">
      @for (r of store.visible(); track r.id) {
        <button class="rec" [class.on]="r.id === store.selId()" (click)="store.select(r.id)">
          <span class="d" [class]="'d ' + dot(r)"></span>
          <span class="stack" style="gap:1px;min-width:0">
            <b class="ell">{{ r.label }}</b>
            <span class="small muted ell num">{{ r.recordNo }}</span>
            @if (r.newDocuments) { <span class="small newdoc">{{ r.newDocuments === 1 ? 'New document' : r.newDocuments + ' new documents' }}</span> }
          </span>
          <span class="tag" [class]="'tag ' + statusOf(r).tag">{{ statusOf(r).label }}</span>
        </button>
      } @empty { <div class="small muted" style="padding:28px;text-align:center">{{ store.loading() ? 'Loading…' : 'No land records match.' }}</div> }
    </div>
    <div class="list-foot small muted">{{ store.visible().length }} of {{ store.records().length }} records</div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .list-head { padding: 16px; display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid var(--color-divider); }
    .list-body { flex: 1; overflow-y: auto; min-height: 0; }
    .newdoc { color: var(--warn-fg); font-weight: 600; }
    .rec { width: 100%; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 16px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid var(--color-divider); background: transparent; cursor: pointer; text-align: left; }
    .rec:hover { background: var(--color-neutral-100); }
    .rec.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .rec b { font-size: 14px; }
    .rec .tag { font-size: 11px; }
    .d { width: 9px; height: 9px; border-radius: 50%; background: var(--color-neutral-400); }
    .d.review { background: var(--color-accent); } .d.committed { background: var(--success); } .d.flag { background: var(--nam-red, #c0392b); } .d.draft { background: transparent; border: 1.5px dashed var(--color-neutral-500); }
    .list-foot { padding: 10px 16px; border-top: 1px solid var(--color-divider); }
  `,
  ],
})
export class LinkListComponent {
  protected readonly store = inject(LinkStore);
  protected readonly creating = inject(LinkCreateFlow);
  protected readonly statusOf = statusOf;
  protected readonly dot = dot;
}
