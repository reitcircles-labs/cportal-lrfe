import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DOCS, TOTAL } from '../../data/mock-data';
import { RegistryStore } from '../../state/registry.store';
import { ViewerService } from '../../state/viewer.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-capture',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="page layout">
      <aside class="stack" style="gap:18px">
        <div class="seg">
          <label class="seg-opt"><input type="radio" name="src" [checked]="store.src() === 'live'" (change)="store.src.set('live')"><app-icon name="scan" [size]="14" />Live scanner</label>
          <label class="seg-opt"><input type="radio" name="src" [checked]="store.src() === 'hot'" (change)="store.src.set('hot')"><app-icon name="folder" [size]="14" />Hot folder</label>
        </div>
        <div class="blueprint" style="padding:14px"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
          @if (store.src() === 'live') {
            <div class="row" style="justify-content:space-between"><span class="card-kicker">Scanner</span><span class="tag tag-accent">{{ statusLabel() }}</span></div>
            <div class="card-title" style="margin:4px 0 10px">SC-02 · Registry floor 2</div>
            <div class="kv" style="font-size:13px">
              <span>Resolution</span><span>300 dpi (600 for diagrams)</span>
              <span>Mode</span><span>Duplex · Greyscale</span>
              <span>Separation</span><span>Patch-code sheets</span>
              <span>Output</span><span>PDF/A-2b + TIFF</span>
            </div>
          } @else {
            <div class="row" style="justify-content:space-between"><span class="card-kicker">Watched folder</span><span class="tag tag-accent">{{ statusLabel() }}</span></div>
            <div class="num" style="font-size:13px;margin:6px 0 8px;word-break:break-all">\\\\wdh-deeds\\scan\\hot\\B017\\</div>
            <div class="small muted">Picks up PDF/TIFF from networked MFPs and the large-format diagram scanner. One file = one instrument.</div>
          }
        </div>
        <div class="stack">
          <div class="field"><label>Batch ID</label><input class="input" value="WDH-B017" readonly></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="field"><label>Registry</label><input class="input" value="Windhoek" readonly></div>
            <div class="field"><label>Reg. division</label><input class="input" value="K · Khomas" readonly></div>
          </div>
          <div class="field"><label>Source</label><input class="input" value="Vault 3 · T-series vol. 2008, 2019" readonly></div>
        </div>
        <div class="stack" style="gap:8px">
          <div class="row small" style="justify-content:space-between"><span>{{ store.pages() }} of {{ total }} pages · {{ docsIn() }} instruments</span><span class="muted">{{ pct() }}%</span></div>
          <div style="height:4px;background:var(--color-neutral-200)"><div style="height:100%;background:var(--color-accent);transition:width .3s" [style.width.%]="pct()"></div></div>
          <div class="row" style="margin-top:6px;flex-wrap:nowrap">
            <button class="btn btn-secondary" style="flex:1" [disabled]="store.scanning()" (click)="store.startScan()">{{ scanLabel() }}</button>
            <button class="btn btn-primary" style="flex:1" [disabled]="!store.scanDone()" (click)="router.navigate(['/verify'])">Send to review →</button>
          </div>
        </div>
      </aside>

      <section class="stack" style="gap:20px;min-width:0">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <h2 style="margin:0">{{ store.src() === 'hot' ? 'Files in hot folder' : 'Incoming pages' }}</h2>
          <span class="small muted">Split per instrument · classified and OCR'd on arrival · click any page to open the viewer</span>
        </div>
        @if (store.pages() === 0) {
          <div class="blueprint empty"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            {{ store.src() === 'hot' ? '3 files waiting in the hot folder. Press Import to ingest.' : 'Load the T-series volumes into the feeder and press Start scan. Pages appear here as they are captured.' }}
          </div>
        } @else if (store.src() === 'hot') {
          <table class="table">
            <thead><tr><th>File</th><th>Size</th><th>Classified as</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (g of groups(); track g.doc.id) {
                <tr>
                  <td class="num">{{ g.file }}</td>
                  <td class="small muted">{{ g.got ? g.size : '—' }}</td>
                  <td>{{ g.done ? g.doc.title + ' ' + g.doc.ref : g.got ? 'Reading…' : '—' }}</td>
                  <td><span class="tag" [class.tag-accent]="g.done" [class.tag-neutral]="!g.done">{{ g.done ? 'Ingested' : g.got ? 'Processing' : 'Queued' }}</span></td>
                  <td style="text-align:right"><button class="btn btn-secondary" [disabled]="!g.got" (click)="viewer.open('batch', g.doc.id, 0)"><app-icon name="eye" [size]="15" />View</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          @for (g of groups(); track g.doc.id) {
            @if (g.got) {
              <div class="doc-row">
                <div class="row" style="gap:14px;align-items:flex-start">
                  @for (p of g.pageList; track p) {
                    <button class="bare pg" (click)="viewer.open('batch', g.doc.id, p)" title="Open in viewer">
                      <span class="blueprint thumb"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                        <span class="t"></span><span class="l" style="margin-top:6px"></span><span class="l" style="width:92%"></span><span class="l"></span><span class="l" style="width:70%"></span><span class="seal"></span>
                      </span>
                      <span class="small muted" style="font-size:10px">p. {{ g.start + p + 1 }}{{ store.flaggedPages()[g.doc.id + p] ? ' · rescan' : '' }}</span>
                    </button>
                  }
                </div>
                <div class="stack" style="gap:5px">
                  <div class="card-kicker">Instrument {{ g.i + 1 }} · {{ g.got }}/{{ g.doc.pages }} pages</div>
                  <div class="h-cond" style="font-size:19px;line-height:1.15">{{ g.done ? g.doc.title + ' ' + g.doc.ref : 'Receiving pages…' }}</div>
                  @if (g.done) {
                    <div class="small muted">{{ g.doc.type }} · {{ Math.round(g.doc.cls * 100) }}% confidence</div>
                    <div class="small">{{ g.doc.qc }}</div>
                  }
                  <button class="btn btn-secondary" style="align-self:flex-start;margin-top:4px" (click)="viewer.open('batch', g.doc.id, 0)"><app-icon name="eye" [size]="15" />Open viewer</button>
                </div>
              </div>
            }
          }
        }
      </section>
    </div>
  `,
  styles: [`
    .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 32px; align-items: start; }
    .empty { padding: 44px; text-align: center; color: var(--color-neutral-700); font-size: 14px; border-style: dashed; }
    .doc-row { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--color-divider); }
    .pg { display: flex; flex-direction: column; gap: 4px; align-items: center; cursor: zoom-in; }
    .pg:hover { opacity: .8; }
    .seg-opt { gap: 6px; }
    @media (max-width: 860px) { .layout, .doc-row { grid-template-columns: 1fr; } }
  `]
})
export class CaptureComponent {
  store = inject(RegistryStore);
  viewer = inject(ViewerService);
  router = inject(Router);
  total = TOTAL;
  Math = Math;
  pct = computed(() => Math.round(this.store.pages() / TOTAL * 100));
  groups = computed(() => {
    let off = 0;
    this.store.pages();
    return DOCS.map((doc, i) => {
      const got = this.store.gotPages(doc), start = off; off += doc.pages;
      return { doc, i, got, start, done: got === doc.pages, pageList: Array.from({ length: got }, (_, j) => j),
        file: 'WDH-B017_' + String(i + 1).padStart(4, '0') + (doc.isDiagram ? '.tif' : '.pdf'),
        size: (doc.pages * (doc.isDiagram ? 38 : 1.4)).toFixed(1) + ' MB' };
    });
  });
  docsIn = computed(() => this.groups().filter(g => g.got > 0).length);
  statusLabel = computed(() => this.store.scanning() ? (this.store.src() === 'hot' ? 'Importing' : 'Scanning') : this.store.scanDone() ? 'Batch complete' : this.store.src() === 'hot' ? 'Watching' : 'Ready');
  scanLabel = computed(() => this.store.scanning() ? 'Working…' : this.store.scanDone() ? 'Re-run batch' : this.store.src() === 'hot' ? 'Import 3 files' : 'Start scan');
}
