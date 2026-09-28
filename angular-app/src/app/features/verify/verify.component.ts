import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { BATCHES, DOCS, QUEUE, idFmt } from '../../data/mock-data';
import { DocField, LandDoc } from '../../data/models';
import { RegistryStore } from '../../state/registry.store';
import { ViewerService } from '../../state/viewer.service';
import { DocPageComponent } from '../../shared/doc-page.component';
import { IconComponent } from '../../shared/icon.component';

type QFilter = 'open' | 'filed' | 'all';

@Component({
  selector: 'app-verify',
  standalone: true,
  imports: [DocPageComponent, IconComponent],
  template: `
    <div class="shell" [class.collapsed]="!railOpen()">
      <!-- Review queue -->
      @if (railOpen()) {
        <aside class="rail">
          <div class="rail-head">
            <div class="row" style="justify-content:space-between"><h4 style="margin:0">Review queue</h4>
              <button class="btn btn-ghost btn-icon" style="width:28px;height:28px" title="Collapse queue" (click)="railOpen.set(false)"><app-icon name="panelClose" /></button></div>
            <div class="stats">
              <div><b class="num">{{ counts().open }}</b><span>Open</span></div>
              <div><b class="num">{{ counts().low }}</b><span>Need checks</span></div>
              <div><b class="num">{{ counts().filed }}</b><span>Filed</span></div>
            </div>
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, township, batch" [value]="search()" (input)="search.set($any($event.target).value)"></div>
            <div class="row" style="justify-content:space-between">
              <div class="seg">
                @for (f of filters; track f.id) {
                  <label class="seg-opt sm"><input type="radio" name="qf" [checked]="filter() === f.id" (change)="filter.set(f.id)">{{ f.label }}</label>
                }
              </div>
              <button class="btn btn-ghost small" (click)="sortLow.set(!sortLow())"><app-icon name="sort" [size]="14" />{{ sortLow() ? 'Lowest confidence' : 'Batch order' }}</button>
            </div>
          </div>
          <div class="rail-list">
            @for (g of groups(); track g.id) {
              <button class="grp" (click)="toggle(g.id)">
                <span class="chev" [class.open]="!collapsed()[g.id]">▶</span>
                <span class="stack" style="gap:4px;min-width:0">
                  <span class="row" style="gap:8px;flex-wrap:nowrap"><span class="h-cond" style="font-size:14px">{{ g.id }}</span><span class="small muted ellipsis">{{ g.src }}</span></span>
                  <span class="bar"><span [style.width.%]="g.pct"></span></span>
                </span>
                <span class="small muted num">{{ g.count }}</span>
              </button>
              @if (!collapsed()[g.id]) {
                @for (r of g.rows; track r.doc.id) {
                  <button class="qrow" [class.on]="r.doc.id === doc().id" (click)="select(r.doc.id)">
                    <span class="status-sq" [class.filed]="r.st === 'filed'" [class.progress]="r.st === 'progress'" [title]="r.st"></span>
                    <span class="stack" style="gap:0;min-width:0">
                      <span class="h-cond num" style="font-size:15px;line-height:1.2">{{ r.doc.ref }}</span>
                      <span class="small muted ellipsis" style="font-size:11px">{{ r.sub }}</span>
                    </span>
                    <span class="stack" style="gap:1px;align-items:flex-end">
                      <span class="num" style="font-size:11px" [style.color]="r.low && !r.filed ? 'var(--color-accent-800)' : 'var(--color-neutral-700)'">{{ r.filed ? 'Filed' : r.low ? r.low + ' low' : 'Clean' }}</span>
                      @if (!r.filed) { <span class="num" style="font-size:10px;color:var(--color-neutral-600)">{{ r.reviewed }}/{{ r.doc.fields.length }}</span> }
                    </span>
                  </button>
                }
              }
            } @empty { <div class="small muted" style="padding:28px 16px;text-align:center">No documents match.</div> }
          </div>
          <div class="rail-foot small muted"><span>Showing {{ visible().length }} of {{ rows().length }}</span><span>□ open · ▣ in progress · ■ filed</span></div>
        </aside>
      } @else {
        <aside class="rail-min">
          <button class="btn btn-ghost btn-icon" title="Show queue" (click)="railOpen.set(true)"><app-icon name="panelOpen" /></button>
          <span class="vert">Queue · {{ counts().open }} open</span>
        </aside>
      }

      <!-- Document -->
      <section class="main">
        <header class="doc-head">
          <div class="stack" style="gap:2px;min-width:0;margin-right:auto">
            <span class="card-kicker">{{ doc().batch }} · {{ posLabel() }}</span>
            <span class="row" style="gap:10px;align-items:baseline"><span class="h-cond" style="font-size:28px;line-height:1.05">{{ doc().ref }}</span><span style="font-size:13px;color:var(--color-neutral-800)">{{ doc().title }} · {{ prop() }}</span></span>
          </div>
          @if (canView()) { <button class="btn btn-secondary" (click)="viewer.open('batch', doc().id, 0)"><app-icon name="eye" [size]="15" />All pages</button> }
          <div class="seg">
            <label class="seg-opt"><input type="radio" name="vm" [checked]="layout() === 'split'" (change)="layout.set('split')">Side by side</label>
            <label class="seg-opt"><input type="radio" name="vm" [checked]="layout() === 'focus'" (change)="layout.set('focus')">Field focus</label>
          </div>
          <div class="row" style="gap:4px">
            <button class="btn btn-secondary btn-icon" [disabled]="pos() <= 0" (click)="move(-1)" title="Previous document"><app-icon name="up" /></button>
            <button class="btn btn-secondary btn-icon" [disabled]="pos() < 0 || pos() >= flat().length - 1" (click)="move(1)" title="Next document"><app-icon name="down" /></button>
          </div>
        </header>

        @if (layout() === 'split') {
          <div class="auto-grid">
            <div class="stack" style="gap:8px;min-width:0">
              <div class="row small muted" style="justify-content:space-between"><span>Page image · page 1 of {{ doc().pages }}</span><span>Click a highlighted value to jump to its field</span></div>
              <app-doc-page [doc]="doc()" mode="review" [activeKey]="activeKey()" (segClick)="active.set($event)" />
            </div>
            <div class="stack sticky" style="gap:10px">
              <div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">Extracted metadata</h3><span class="small muted">{{ reviewed() }} of {{ doc().fields.length }} fields reviewed</span></div>
              <div class="row" style="gap:8px"><span class="tag tag-neutral">{{ doc().type }}</span><span class="tag tag-neutral">Classifier {{ pct(doc().cls) }}</span><span class="tag tag-outline">{{ lowCount() }} below {{ pct(store.threshold()) }}</span></div>
              <div style="border-top:1px solid var(--color-divider)">
                @for (f of fields(); track f.k) {
                  <div class="frow" [class.on]="f.k === activeKey()" (click)="active.set(f.k)">
                    <div class="row small muted" style="gap:8px"><span>{{ f.label }}</span>
                      @if (f.low) { <span class="flag">· check</span> }
                      @if (f.fmt) { <span style="font-size:11px;color:var(--color-accent-800)">{{ f.fmt }}</span> }</div>
                    <div class="small muted num" style="text-align:right;font-size:11px">{{ f.conf }}</div>
                    <input class="input" [value]="f.value" (focus)="active.set(f.k)" (change)="edit(f.k, $any($event.target).value)">
                    <button class="btn btn-icon" [class.btn-primary]="f.done" [class.btn-secondary]="!f.done" style="width:40px;height:32px" title="Accept" (click)="toggleAccept(f, $event)"><app-icon name="check" /></button>
                    <div class="confbar"><span [style.width]="f.conf" [style.background]="f.low ? 'var(--color-accent-800)' : 'var(--color-accent-400)'"></span></div>
                  </div>
                }
              </div>
              <div class="row" style="margin-top:4px">
                <button class="btn btn-secondary" (click)="acceptHigh()">Accept high-confidence</button>
                <span class="spacer"></span>
                @if (filed()) { <span class="tag tag-accent" style="padding:8px 12px">Filed · {{ doc().edrms }}</span> }
                @else { <button class="btn btn-primary" [disabled]="reviewed() < doc().fields.length" (click)="approve()">Approve &amp; file to EDRMS</button> }
              </div>
            </div>
          </div>
        } @else {
          <div class="focus">
            <div class="stack" style="gap:16px;min-width:0;flex:3 1 420px">
              <div class="pips">@for (f of fields(); track f.k) { <button [class.done]="f.done" [class.low]="f.low && !f.done" [class.on]="f.k === activeKey()" [title]="f.label" (click)="active.set(f.k)"></button> }</div>
              <div class="row small muted" style="justify-content:space-between"><span>Field {{ activeIdx() + 1 }} of {{ fields().length }} · {{ doc().title }}</span><span>Enter accepts &amp; moves on</span></div>
              <div class="blueprint paper" style="padding:28px 32px"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                <div class="small muted" style="letter-spacing:.08em;margin-bottom:10px">REGION · page 1 · paragraph {{ focusPara().n }} · ×2.4</div>
                <p class="crop">@for (s of focusPara().segs; track $index) {<span [class.act]="s.active" [class.dim]="!s.active">{{ s.text }}</span>}</p>
              </div>
              <div class="focus-edit">
                <div class="field" style="min-width:0">
                  <label class="row" style="gap:10px;align-items:baseline"><span class="h-cond" style="font-size:22px;color:var(--color-text)">{{ activeField().label }}</span><span>{{ activeField().conf }} confidence</span>@if (activeField().fmt) { <span style="color:var(--color-accent-800)">{{ activeField().fmt }}</span> }</label>
                  <input class="input" style="font-size:20px;min-height:48px" [value]="activeField().value" (change)="edit(activeField().k, $any($event.target).value)" (keydown.enter)="edit(activeField().k, $any($event.target).value); acceptAndNext()">
                </div>
                <div class="row" style="flex-wrap:nowrap">
                  <button class="btn btn-secondary" style="height:48px" (click)="stepField(-1)">← Prev</button>
                  <button class="btn btn-primary" style="height:48px;padding:0 18px" (click)="acceptAndNext()">Accept ↵</button>
                </div>
                <div class="small muted" style="grid-column:1/-1">{{ activeField().low ? 'Below the ' + pct(store.threshold()) + ' threshold — compare carefully with the image before accepting.' : 'High confidence — accept if it reads the same on the image.' }}</div>
              </div>
            </div>
            <aside class="stack sticky" style="gap:10px;flex:1 1 240px;min-width:0">
              <h4 style="margin:0">{{ reviewed() }} of {{ doc().fields.length }} fields reviewed</h4>
              <div style="border-top:1px solid var(--color-divider)">
                @for (f of fields(); track f.k) {
                  <button class="list-btn flist" [class.is-active]="f.k === activeKey()" (click)="active.set(f.k)">
                    <span class="status-sq" [class.filed]="f.done"></span>
                    <span class="stack" style="gap:0;min-width:0"><span class="small muted" style="font-size:11px">{{ f.label }}</span><span class="ellipsis" style="font-size:13px">{{ f.value }}</span></span>
                  </button>
                }
              </div>
              @if (filed()) { <span class="tag tag-accent" style="padding:8px 12px">Filed · {{ doc().edrms }}</span> }
              @else { <button class="btn btn-primary" [disabled]="reviewed() < doc().fields.length" (click)="approve()">Approve &amp; file to EDRMS</button> }
            </aside>
          </div>
        }

        @if (batchFiled()) {
          <div class="blueprint row" style="padding:12px 14px;justify-content:space-between"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            <span style="font-size:13px">Batch WDH-B017 filed — all 3 instruments for Erf 1873 are in the EDRMS. Next: review and finalize the land record.</span>
            <button class="btn btn-primary" (click)="router.navigate(['/link'], { queryParams: { record: 'erf1873' } })">Open land record →</button>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .shell { display: grid; grid-template-columns: 300px minmax(0, 1fr); align-items: start; max-width: 1560px; margin: 0 auto; }
    .shell.collapsed { grid-template-columns: 44px minmax(0, 1fr); }
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
    .qrow { width: 100%; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 14px; border: 0; border-left: 2px solid transparent; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 6%, transparent); background: transparent; cursor: pointer; text-align: left; }
    .qrow:hover { background: var(--color-accent-100); }
    .qrow { border-left-width: 3px; }
    .qrow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .rail-foot { padding: 8px 14px; border-top: 1px solid var(--color-divider); display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
    .rail-min { border-right: 1px solid var(--color-divider); background: var(--color-surface); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 0; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); }
    .vert { writing-mode: vertical-rl; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-neutral-700); }
    .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .main { padding: 16px 24px 32px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .doc-head { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 16px 18px; background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
    .sticky { position: sticky; top: calc(var(--topbar-h) + 16px); }
    .frow { display: grid; grid-template-columns: minmax(0, 1fr) 40px; gap: 4px 10px; padding: 10px 14px; border-bottom: 1px solid var(--color-divider); border-left: 3px solid transparent; background: var(--color-surface); }
    .frow:first-child { border-top-left-radius: 10px; border-top-right-radius: 10px; }
    .frow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .frow .input { min-height: 32px; padding: 4px 8px; background: transparent; }
    .flag { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-accent-800); }
    .confbar { grid-column: 1 / -1; height: 2px; background: var(--color-neutral-200); }
    .confbar span { display: block; height: 100%; }
    .focus { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
    .pips { display: flex; gap: 3px; }
    .pips button { flex: 1; height: 8px; border: 0; padding: 0; cursor: pointer; background: var(--color-neutral-300); border-radius: 99px; }
    .pips button.low { background: var(--color-accent-300); }
    .pips button.done { background: var(--success); }
    .pips button.on { outline: 1.5px solid var(--color-accent-900); outline-offset: 1px; }
    .crop { margin: 0; font-size: 24px; line-height: 1.7; color: var(--paper-ink); text-wrap: pretty; }
    .crop .dim { opacity: .45; }
    .crop .act { background: var(--color-accent-300); box-shadow: 0 0 0 1.5px var(--color-accent-700); padding: 1px 2px; }
    .focus-edit { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 14px; align-items: end; }
    .flist { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: center; border-bottom: 1px solid var(--color-divider); padding: 7px 8px; }
    @media (max-width: 900px) { .shell { grid-template-columns: 44px minmax(0, 1fr); } }
  `]
})
export class VerifyComponent {
  store = inject(RegistryStore);
  viewer = inject(ViewerService);
  router = inject(Router);
  private route = inject(ActivatedRoute);

  docId = signal('a');
  active = signal<string | null>(null);
  layout = signal<'split' | 'focus'>('split');
  railOpen = signal(window.innerWidth > 900);
  search = signal('');
  filter = signal<QFilter>('open');
  sortLow = signal(false);
  collapsed = signal<Record<string, boolean>>({});
  filters: { id: QFilter; label: string }[] = [{ id: 'open', label: 'Open' }, { id: 'filed', label: 'Filed' }, { id: 'all', label: 'All' }];

  constructor() {
    this.route.queryParamMap.subscribe(q => { const d = q.get('doc'); if (d) { this.docId.set(d); this.active.set(null); const doc = QUEUE.find(x => x.id === d); if (doc && this.store.isFiled(doc)) this.filter.set('all'); } });
    effect(() => { this.docId(); }, { allowSignalWrites: true });
  }

  rows = computed(() => {
    const th = this.store.threshold();
    this.store.fs(); this.store.filed();
    return QUEUE.map(doc => {
      const reviewed = this.store.reviewedCount(doc), filed = this.store.isFiled(doc);
      const low = doc.fields.filter(f => (f.c ?? 1) < th).length;
      const minc = Math.min(...doc.fields.map(f => f.c ?? 1));
      const propV = doc.fields.find(f => f.k === 'property')?.v || '';
      return { doc, reviewed, filed, low, minc, propV, st: filed ? 'filed' : reviewed > 0 ? 'progress' : 'open',
        sub: (doc.isDiagram ? 'SG diagram' : doc.title) + ' · ' + propV.replace(/,.*/, '') + (doc.assignee ? ' · ' + doc.assignee : '') };
    });
  });
  visible = computed(() => {
    const q = this.search().toLowerCase().trim(), f = this.filter();
    const v = this.rows().filter(r => (f === 'all' || (f === 'filed' ? r.filed : !r.filed)) && (!q || (r.doc.ref + ' ' + r.propV + ' ' + r.doc.title + ' ' + r.doc.batch).toLowerCase().includes(q)));
    return this.sortLow() ? [...v].sort((a, b) => a.minc - b.minc) : v;
  });
  groups = computed(() => BATCHES.map(b => {
    const all = this.rows().filter(r => r.doc.batch === b.id), rows = this.visible().filter(r => r.doc.batch === b.id);
    const nf = all.filter(r => r.filed).length;
    return { id: b.id, src: b.src, rows, count: nf + '/' + all.length, pct: Math.round(nf / all.length * 100) };
  }).filter(g => g.rows.length));
  flat = computed(() => this.groups().flatMap(g => g.rows.map(r => r.doc)));
  counts = computed(() => { const r = this.rows(); const open = r.filter(x => !x.filed); return { open: open.length, low: open.filter(x => x.low).length, filed: r.length - open.length }; });

  doc = computed<LandDoc>(() => QUEUE.find(d => d.id === this.docId()) || QUEUE[0]);
  pos = computed(() => this.flat().findIndex(d => d.id === this.doc().id));
  posLabel = computed(() => this.pos() >= 0 ? (this.pos() + 1) + ' of ' + this.flat().length + ' in view' : 'not in current filter');
  prop = computed(() => this.doc().fields.find(f => f.k === 'property')?.v);
  canView = computed(() => DOCS.includes(this.doc()) && this.store.gotPages(this.doc()) > 0);
  filed = computed(() => this.store.isFiled(this.doc()));
  batchFiled = computed(() => DOCS.every(d => this.store.filed()[d.id]));

  fields = computed(() => {
    const d = this.doc(), th = this.store.threshold();
    this.store.fs();
    return d.fields.map((f, i) => {
      const value = this.store.value(d, f), status = this.store.status(d, f, i);
      return { k: f.k, label: f.label, value, status, done: status !== 'pending', low: (f.c ?? 1) < th, conf: this.pct(f.c ?? 1), fmt: idFmt(f.k, value), src: f };
    });
  });
  activeKey = computed(() => { const a = this.active(); return this.doc().fields.some(f => f.k === a) ? a : this.doc().fields[0].k; });
  activeIdx = computed(() => this.fields().findIndex(f => f.k === this.activeKey()));
  activeField = computed(() => this.fields()[this.activeIdx()]);
  reviewed = computed(() => this.fields().filter(f => f.done).length);
  lowCount = computed(() => this.fields().filter(f => f.low).length);
  focusPara = computed(() => {
    const d = this.doc(), k = this.activeKey();
    const idx = Math.max(0, d.paras.findIndex(p => p.includes(k)));
    return { n: idx + 1, segs: d.paras[idx].map(s => { const f = d.fields.find(x => x.k === s); return { text: f ? this.store.value(d, f) : s, active: s === k }; }) };
  });

  pct(n: number) { return Math.round(n * 100) + '%'; }
  select(id: string) { this.docId.set(id); this.active.set(null); }
  toggle(id: string) { this.collapsed.update(c => ({ ...c, [id]: !c[id] })); }
  move(dir: number) { const t = this.flat()[this.pos() + dir]; if (t) this.select(t.id); }
  edit(k: string, value: string) {
    const f = this.doc().fields.find(x => x.k === k)!;
    if (value !== this.store.value(this.doc(), f)) this.store.setField(this.doc().id, k, { value, status: 'edited' });
  }
  toggleAccept(f: { k: string; done: boolean; status: string }, e: Event) {
    e.stopPropagation();
    this.store.setField(this.doc().id, f.k, { status: f.done ? 'pending' : f.status === 'edited' ? 'edited' : 'accepted' });
  }
  acceptHigh() {
    const d = this.doc(), th = this.store.threshold();
    d.fields.forEach((f: DocField, i) => { if ((f.c ?? 1) >= th && this.store.status(d, f, i) === 'pending') this.store.setField(d.id, f.k, { status: 'accepted' }); });
  }
  stepField(dir: number) { const t = this.fields()[this.activeIdx() + dir]; if (t) this.active.set(t.k); }
  acceptAndNext() {
    const f = this.activeField();
    if (!f.done) this.store.setField(this.doc().id, f.k, { status: 'accepted' });
    this.stepField(1);
  }
  approve() {
    const d = this.doc(), flat = this.flat(), i = this.pos();
    this.store.fileDoc(d);
    const next = [...flat.slice(i + 1), ...flat.slice(0, Math.max(0, i))].find(x => !this.store.isFiled(x));
    if (next) this.select(next.id);
  }
}
