import {Component, inject, ChangeDetectionStrategy} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {VerifyStore} from './verify.store';

/** Verify: the review queue, grouped by batch, with search, filters and sort; or its collapsed strip. */
@Component({
  selector: 'app-verify-queue',
  imports: [IconComponent],
  template: `
    @if (store.railOpen()) {
      <aside class="rail">
        <div class="rail-head">
          <div class="row" style="justify-content:space-between"><h4 style="margin:0">Review queue</h4>
            <button class="btn btn-ghost btn-icon" style="width:28px;height:28px" title="Collapse queue" (click)="store.railOpen.set(false)"><app-icon name="panelClose" /></button></div>
          <div class="stats">
            <div><b class="num">{{ store.counts().open }}</b><span>Open</span></div>
            <div><b class="num">{{ store.counts().checks }}</b><span>Need checks</span></div>
            <div><b class="num">{{ store.counts().filed }}</b><span>Filed</span></div>
          </div>
          <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, file, batch" [value]="store.search()" (input)="store.search.set($any($event.target).value)"></div>
          <div class="row" style="justify-content:space-between">
            <div class="seg">
              @for (f of store.filters; track f.id) {
                <label class="seg-opt sm"><input type="radio" name="qf" [checked]="store.filter() === f.id" (change)="store.filter.set(f.id)">{{ f.label }}</label>
              }
            </div>
            <button class="btn btn-ghost small" (click)="store.sortChecks.set(!store.sortChecks())"><app-icon name="sort" [size]="14" />{{ store.sortChecks() ? 'Most checks' : 'Batch order' }}</button>
          </div>
        </div>
        <div class="rail-list">
          @for (g of store.groups(); track g.id) {
            <button class="grp" (click)="store.toggle(g.id)">
              <span class="chev" [class.open]="!store.collapsed()[g.id]">▶</span>
              <span class="stack" style="gap:4px;min-width:0">
                <span class="h-cond" style="font-size:14px">{{ g.id }}</span>
                <span class="bar"><span [style.width.%]="g.pct"></span></span>
              </span>
              <span class="small muted num">{{ g.count }}</span>
            </button>
            @if (!store.collapsed()[g.id]) {
              @for (d of g.rows; track d.id) {
                <button class="qrow" [class.on]="d.id === store.docId()" (click)="store.select(d.id)">
                  <span class="status-sq" [class.filed]="d.status === 'filed'" [class.progress]="d.status === 'ready' && d.reviewed > 0" [title]="store.statusLabel(d.status)"></span>
                  <span class="stack" style="gap:0;min-width:0">
                    <span class="h-cond num ellipsis" style="font-size:15px;line-height:1.2">{{ d.ref || d.fileName }}</span>
                    <span class="small muted ellipsis" style="font-size:11px">{{ store.sub(d) }}</span>
                  </span>
                  <span class="stack" style="gap:1px;align-items:flex-end">
                    <span class="num" style="font-size:11px" [style.color]="store.rowAlert(d) ? 'var(--color-accent-800)' : 'var(--color-neutral-700)'">{{ store.rowState(d) }}</span>
                    @if (d.status === 'ready') { <span class="num" style="font-size:10px;color:var(--color-neutral-600)">{{ d.reviewed }}/{{ d.total }}</span> }
                  </span>
                </button>
              }
            }
          } @empty { <div class="small muted" style="padding:28px 16px;text-align:center">{{ store.loading() ? 'Loading…' : 'No documents match.' }}</div> }
        </div>
        <div class="rail-foot small muted"><span>Showing {{ store.visible().length }} of {{ store.list().length }}</span><span>□ open · ▣ in progress · ■ filed</span></div>
      </aside>
    } @else {
      <aside class="rail-min">
        <button class="btn btn-ghost btn-icon" title="Show queue" (click)="store.railOpen.set(true)"><app-icon name="panelOpen" /></button>
        <span class="vert">Queue · {{ store.counts().open }} open</span>
      </aside>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .rail { border-right: 1px solid var(--color-divider); background: var(--color-surface); display: flex; flex-direction: column; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); }
    .rail-head { padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--color-divider); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--color-divider); border-radius: 10px; overflow: hidden; }
    .stats > div { padding: 7px 9px; border-right: 1px solid var(--color-divider); display: flex; flex-direction: column; gap: 3px; }
    .stats > div:last-child { border-right: 0; }
    .stats b { font-family: var(--font-heading); font-weight: 800; font-size: 20px; line-height: 1; }
    .stats span { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--color-neutral-700); }
    .search { position: relative; }
    .search app-icon { position: absolute; left: 10px; top: 10px; color: var(--color-neutral-600); }
    .search .input { padding-left: 32px; min-height: 34px; font-size: 13px; }
    .seg-opt.sm { padding: 5px 9px; font-size: 12px; }
    .rail-list { overflow-y: auto; flex: 1; min-height: 0; }
    .grp { position: sticky; top: 0; z-index: 1; width: 100%; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 10px 14px 9px; background: var(--color-surface-2); border: 0; border-bottom: 1px solid var(--color-divider); cursor: pointer; text-align: left; }
    .chev { font-size: 10px; color: var(--color-neutral-700); transition: transform .15s; }
    .chev.open { transform: rotate(90deg); }
    .qrow { width: 100%; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 14px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 6%, transparent); background: transparent; cursor: pointer; text-align: left; }
    .qrow:hover { background: var(--color-accent-100); }
    .qrow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .rail-foot { padding: 8px 14px; border-top: 1px solid var(--color-divider); display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
    .rail-min { border-right: 1px solid var(--color-divider); background: var(--color-surface); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 0; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); }
    .vert { writing-mode: vertical-rl; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-neutral-700); }
    .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `,
  ],
})
export class VerifyQueueComponent {
  protected readonly store = inject(VerifyStore);
}
