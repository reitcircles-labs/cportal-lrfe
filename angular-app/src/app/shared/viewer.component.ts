import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DOCS, VIEWDOCS, NEW, hash } from '../data/mock-data';
import { LandDoc } from '../data/models';
import { RegistryStore } from '../state/registry.store';
import { ViewerService } from '../state/viewer.service';
import { DocPageComponent } from './doc-page.component';
import { IconComponent } from './icon.component';

const RECORD_ORDER = ['g1', 'g2', 'b', 'a', 'c'];

@Component({
  selector: 'app-viewer',
  standalone: true,
  imports: [DocPageComponent, IconComponent],
  template: `
    @if (doc(); as d) {
      <div class="dialog-backdrop" (click)="vs.close()">
        <div class="blueprint frame" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" [attr.aria-label]="d.title + ' ' + d.ref">
          <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
          <div class="v-bar">
            <div class="ttl">
              <span class="h-cond" style="font-size:19px;line-height:1.1">{{ d.title }} {{ d.ref }}</span>
              <span class="small muted">{{ fileName() }} · {{ d.type }} · {{ pct(d.cls) }} classifier</span>
            </div>
            <span class="tag" [class]="statusTag()">{{ statusLabel() }}</span>
            <div class="row" style="gap:4px">
              <button class="btn btn-secondary btn-icon" (click)="step(-1)" [disabled]="flatIndex() <= 0" title="Previous page"><app-icon name="left" /></button>
              <span class="small num" style="min-width:76px;text-align:center">{{ page() + 1 }} / {{ d.pages }}{{ got() < d.pages ? ' (' + got() + ' in)' : '' }}</span>
              <button class="btn btn-secondary btn-icon" (click)="step(1)" [disabled]="flatIndex() >= flat().length - 1" title="Next page"><app-icon name="right" /></button>
            </div>
            <div class="row" style="gap:4px">
              <button class="btn btn-secondary btn-icon" (click)="zoomBy(-0.25)" title="Zoom out"><app-icon name="zoomOut" /></button>
              <button class="btn btn-ghost num" style="min-width:54px" (click)="zoom.set(1)">{{ pct(zoom()) }}</button>
              <button class="btn btn-secondary btn-icon" (click)="zoomBy(0.25)" title="Zoom in"><app-icon name="zoomIn" /></button>
              <button class="btn btn-secondary btn-icon" (click)="rot.set((rot() + 90) % 360)" title="Rotate"><app-icon name="rotate" /></button>
            </div>
            <button class="btn btn-secondary btn-icon" (click)="vs.close()" title="Close (Esc)"><app-icon name="x" /></button>
          </div>
          <div class="body">
            <nav class="strip">
              <span class="strip-ttl">{{ stripTitle() }}</span>
              @for (x of avail(); track x.doc.id) {
                <div class="grp">
                  <span class="grp-ref" [class.on]="x.doc.id === d.id">{{ x.doc.ref }}{{ x.suffix }}</span>
                  @for (p of x.pageList; track p) {
                    <button class="bare pg" (click)="vs.go(x.doc.id, p)">
                      <span class="mini" [class.sel]="x.doc.id === d.id && p === page()"><span class="t"></span><span></span><span style="width:90%"></span><span></span><span style="width:72%"></span></span>
                      <span class="small muted" style="font-size:10px">p. {{ p + 1 }}{{ store.flaggedPages()[x.doc.id + p] ? ' · rescan' : '' }}</span>
                    </button>
                  }
                </div>
              }
            </nav>
            <div class="stage">
              <div class="sheet-wrap" [style.width.px]="560 * zoom()" [style.transform]="'rotate(' + rot() + 'deg)'">
                <app-doc-page [doc]="d" [page]="page()" [scale]="zoom()" [fixedRatio]="true" [mode]="ctx() === 'audit' ? 'audit' : 'none'" />
              </div>
            </div>
            <aside class="side">
              <div>
                <div class="card-kicker">File</div>
                <div class="kv" style="margin-top:6px">
                  @for (p of fileProps(); track p.k) { <span>{{ p.k }}</span><span class="num">{{ p.v }}</span> }
                </div>
              </div>
              @if (ctx() !== 'batch') {
                <div>
                  <div class="card-kicker">Verified metadata</div>
                  <div class="kv" style="margin-top:6px">
                    @for (f of d.fields; track f.k) { <span>{{ f.label }}</span><span>{{ store.value(d, f) }}</span> }
                  </div>
                </div>
              } @else {
                <div><div class="card-kicker">Capture QC</div><div class="small" style="margin-top:6px">{{ d.qc }}{{ store.flaggedPages()[d.id + page()] ? ' · this page flagged for rescan' : '' }}</div></div>
              }
              <div class="actions">
                @if (ctx() === 'batch') {
                  <button class="btn btn-secondary" (click)="store.toggleRescan(d, page())">Flag page for rescan</button>
                  <button class="btn btn-primary" [disabled]="got() < d.pages" (click)="openReview(d)">Open in review →</button>
                }
                @if (ctx() === 'record' && linkState() === 'suggested') {
                  <div class="small" style="border-top:1px dashed var(--color-divider);padding-top:10px">{{ matchText(d) }}</div>
                  <button class="btn btn-secondary" (click)="store.reject(d.id)">Not this erf</button>
                  <button class="btn btn-primary" (click)="store.link(d.id)">Link to Erf 1873</button>
                }
                @if (ctx() === 'record' && (linkState() === 'linked' || linkState() === 'rejected')) {
                  <button class="btn btn-secondary" (click)="store.undo(d.id)">Undo {{ linkState() === 'linked' ? 'link' : 'rejection' }}</button>
                }
              </div>
            </aside>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .dialog-backdrop { z-index: 50; padding: 24px; }
    .frame { width: min(1240px, 100%); height: min(880px, calc(100vh - 48px)); overflow: hidden; background: var(--color-surface); box-shadow: var(--shadow-lg); display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .v-bar { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-bottom: 1px solid var(--color-divider); flex-wrap: wrap; }
    .ttl { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin-right: auto; }
    .v-bar { min-height: 56px; box-sizing: border-box; background: var(--color-bg); }
    .body { display: grid; grid-template-columns: 150px minmax(0, 1fr) 250px; min-height: 0; }
    .strip { background: var(--color-surface-2); border-right: 1px solid var(--color-divider); overflow-y: auto; padding: 12px 10px; display: flex; flex-direction: column; gap: 12px; }
    .strip-ttl { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--color-neutral-700); border-bottom: 1px solid var(--color-divider); padding-bottom: 6px; }
    .grp { display: flex; flex-direction: column; gap: 6px; align-items: center; }
    .grp-ref { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--color-neutral-700); align-self: flex-start; }
    .grp-ref.on { color: var(--color-accent-800); }
    .pg { display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .mini { width: 72px; height: 96px; background: var(--paper); border: 1px solid var(--paper-line); border-radius: 3px; box-sizing: border-box; padding: 9px 8px; display: flex; flex-direction: column; gap: 4px; }
    .mini > span { height: 2px; background: var(--paper-line); display: block; }
    .mini > span.t { height: 3px; width: 60%; background: var(--paper-mute); align-self: center; margin-bottom: 4px; }
    .mini.sel { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 2px; }
    .stage { overflow: auto; background: var(--color-neutral-300); padding: 28px; display: flex; align-items: flex-start; min-height: 0; }
    .sheet-wrap { flex: none; margin: 0 auto; transform-origin: center top; transition: transform .2s; }
    .side { border-left: 1px solid var(--color-divider); overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 16px; }
    .actions { display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
    @media (max-width: 900px) { .body { grid-template-columns: 110px minmax(0, 1fr); } .side { display: none; } }
  `]
})
export class ViewerComponent {
  vs = inject(ViewerService);
  store = inject(RegistryStore);
  private router = inject(Router);
  zoom = signal(1);
  rot = signal(0);

  ctx = computed(() => this.vs.state()?.ctx ?? 'batch');
  avail = computed(() => {
    const s = this.vs.state();
    if (!s) return [];
    const store = this.store;
    let docs: LandDoc[];
    if (s.ctx === 'batch') docs = DOCS.filter(d => store.gotPages(d) > 0);
    else docs = RECORD_ORDER.map(id => VIEWDOCS.find(v => v.id === id)!)
      .filter(d => d.isBase || store.filed()[d.id] || (s.ctx === 'audit' && store.gotPages(d) === d.pages));
    return docs.map(doc => {
      const got = s.ctx === 'batch' ? store.gotPages(doc) : doc.pages;
      const ls = store.linkState(doc.id);
      return { doc, got, pageList: Array.from({ length: got }, (_, i) => i), suffix: s.ctx === 'record' && !doc.isBase ? ' · ' + ls : '' };
    });
  });
  doc = computed(() => {
    const s = this.vs.state(), a = this.avail();
    if (!s || !a.length) return null;
    return (a.find(x => x.doc.id === s.docId) || a[0]).doc;
  });
  got = computed(() => this.avail().find(x => x.doc.id === this.doc()?.id)?.got ?? 0);
  page = computed(() => Math.max(0, Math.min(this.vs.state()?.page ?? 0, this.got() - 1)));
  flat = computed(() => this.avail().flatMap(x => x.pageList.map(p => [x.doc.id, p] as [string, number])));
  flatIndex = computed(() => this.flat().findIndex(([id, p]) => id === this.doc()?.id && p === this.page()));
  linkState = computed(() => this.doc() ? this.store.linkState(this.doc()!.id) : 'pending');
  stripTitle = computed(() => this.ctx() === 'audit' ? 'Erf 1873 · audit evidence' : this.ctx() === 'record' ? 'Erf 1873 · record documents' : 'Batch WDH-B017');
  fileName = computed(() => {
    const d = this.doc()!;
    return d.isBase ? 'PILOT-2025_' + d.ref.replace(/\W+/g, '') + '.pdf' : 'WDH-B017_' + String(DOCS.indexOf(d) + 1).padStart(4, '0') + (d.isDiagram ? '.tif' : '.pdf');
  });
  statusLabel = computed(() => {
    const d = this.doc()!;
    if (this.ctx() === 'batch') return this.store.filed()[d.id] ? 'Filed' : this.got() < d.pages ? 'Receiving' : 'Ingested · awaiting review';
    return ({ base: 'Linked · record v2', linked: 'Linked to Erf 1873', rejected: 'Rejected', suggested: 'Suggested for Erf 1873', pending: 'In review' } as any)[this.linkState()];
  });
  statusTag = computed(() => {
    const s = this.statusLabel();
    return 'tag ' + (s.startsWith('Linked') || s === 'Filed' ? 'tag-accent' : s.startsWith('Suggested') ? 'tag-outline' : 'tag-neutral');
  });
  fileProps = computed(() => {
    const d = this.doc()!;
    return [
      { k: 'Source', v: d.isBase ? 'Pilot back-scan 2025 · Vault 1' : this.store.src() === 'hot' ? '\\\\wdh-deeds\\scan\\hot\\B017\\' + this.fileName() : 'SC-02 · patch-code split' },
      { k: 'Format', v: d.isDiagram ? 'TIFF · 600 dpi' : 'PDF/A-2b · 300 dpi' },
      { k: 'Pages', v: this.got() + ' of ' + d.pages },
      { k: 'Batch', v: d.isBase ? 'PILOT-2025' : 'WDH-B017' },
      { k: 'EDRMS ID', v: this.store.isFiled(d) ? d.edrms : 'Assigned on filing' },
      { k: 'SHA-256', v: hash(d.ref + 'file') }
    ];
  });

  pct(n: number) { return Math.round(n * 100) + '%'; }
  zoomBy(dz: number) { this.zoom.set(Math.min(2, Math.max(0.5, +(this.zoom() + dz).toFixed(2)))); }
  step(dir: number) {
    const t = this.flat()[this.flatIndex() + dir];
    if (t) { this.vs.go(t[0], t[1]); this.rot.set(0); }
  }
  matchText(d: LandDoc) { const n = NEW[d.id]; return n ? n.match + ' match · ' + n.reasons : ''; }
  openReview(d: LandDoc) { this.vs.close(); this.router.navigate(['/verify'], { queryParams: { doc: d.id } }); }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (!this.vs.state()) return;
    if (e.key === 'Escape') this.vs.close();
    else if (e.key === 'ArrowRight') this.step(1);
    else if (e.key === 'ArrowLeft') this.step(-1);
  }
}
