import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BASE, CANDS, DOCS, MONTHS, NEW } from '../../data/mock-data';
import { LinkState } from '../../data/models';
import { RegistryStore } from '../../state/registry.store';
import { ViewerService } from '../../state/viewer.service';
import { IconComponent } from '../../shared/icon.component';

const LABEL: Record<LinkState, [string, string]> = {
  base: ['Linked', 'tag-neutral'], linked: ['Linked', 'tag-accent'], suggested: ['Suggested', 'tag-outline'], pending: ['In review', 'tag-neutral'], rejected: ['Rejected', 'tag-neutral']
};

@Component({
  selector: 'app-link',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="page stack" style="gap:20px">
      <header class="rec-head">
        <div>
          <div class="card-kicker">ERP land record · version {{ store.committed() ? 3 : 2 }}</div>
          <h1 style="margin:4px 0 4px;font-size:38px">Erf 1873, Klein Windhoek</h1>
          <div class="row small" style="gap:16px;color:var(--color-neutral-800);font-size:13px">
            <span>Reg. division K · Khomas</span><span>Municipality of Windhoek</span><span>Extent 1 214 m²</span><span>Freehold</span><span>{{ base.length + store.linkedCount() }} documents linked</span>
          </div>
        </div>
        <div class="row">
          <div class="seg">
            <label class="seg-opt"><input type="radio" name="lm" [checked]="mode() === 'timeline'" (change)="mode.set('timeline')">Chain timeline</label>
            <label class="seg-opt"><input type="radio" name="lm" [checked]="mode() === 'queue'" (change)="mode.set('queue')">Match queue</label>
          </div>
          @if (store.committed()) { <span class="tag tag-accent" style="padding:8px 12px">Committed · ready for tokenization</span> }
          <button class="btn btn-primary blueprint" style="padding:10px 18px;font-size:15px" [disabled]="!store.canCommit()" (click)="store.commit()"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>Commit record v3</button>
        </div>
      </header>

      <div class="auto-grid" style="gap:30px">
        @if (mode() === 'timeline') {
          <section class="stack" style="gap:4px;min-width:0">
            <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:8px">
              <h3 style="margin:0">Chain of title</h3>
              <span class="row small muted">Each entry is one EDRMS document of record
                <button class="btn btn-secondary" (click)="viewer.open('record', 'g1', 0)"><app-icon name="eye" [size]="15" />View all documents</button></span>
            </div>
            @for (e of events(); track e.id) {
              <div class="ev" [style.opacity]="e.st === 'pending' || e.st === 'rejected' ? 0.55 : 1">
                <div class="when"><div class="h-cond" style="font-size:20px;line-height:1">{{ e.year }}</div><div class="small muted" style="font-size:11px">{{ e.day }}</div></div>
                <div class="spine"><i></i><b [class.fill]="e.st === 'base' || e.st === 'linked'"></b><i style="flex:1"></i></div>
                <div class="blueprint evcard" [class.dashed]="e.st === 'suggested' || e.st === 'pending'" [class.sugg]="e.st === 'suggested'"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                  <div class="row" style="justify-content:space-between">
                    <span class="h-cond" style="font-size:17px">{{ e.type }} · {{ e.ref }}</span>
                    <span class="row" style="gap:8px"><span class="small muted num" style="font-size:11px">{{ e.edrms }}</span><span class="tag" [class]="'tag ' + label(e.st)[1]">{{ label(e.st)[0] }}</span>
                      @if (e.st !== 'pending') { <button class="btn btn-secondary" style="padding:3px 8px;font-size:12px" (click)="viewer.open('record', e.id, 0)"><app-icon name="eye" [size]="14" />View</button> }</span>
                  </div>
                  <div style="font-size:13px;margin-top:4px">{{ e.summary }}</div>
                  @if (e.st === 'suggested') {
                    <div class="row sugg-bar">
                      <div class="small" style="color:var(--color-neutral-800)"><strong style="color:var(--color-accent-800)">{{ e.match }} match</strong> · {{ e.reasons }}</div>
                      <div class="row" style="gap:8px"><button class="btn btn-secondary" (click)="store.reject(e.id)">Not this erf</button><button class="btn btn-primary" (click)="store.link(e.id)">Link to record</button></div>
                    </div>
                  }
                  @if (e.st === 'pending') { <div class="small muted" style="margin-top:8px">Still in metadata review — <a href="" (click)="$event.preventDefault(); router.navigate(['/verify'], { queryParams: { doc: e.id } })">verify now</a></div> }
                  @if (e.st === 'linked' || e.st === 'rejected') {
                    <div class="row small muted" style="margin-top:8px;gap:8px">{{ e.st === 'linked' ? 'Linked by J. !Gawaseb · just now' : 'Rejected — returned to unmatched queue' }}<button class="btn btn-ghost" style="font-size:12px;padding:0 4px" (click)="store.undo(e.id)">Undo</button></div>
                  }
                </div>
              </div>
            }
          </section>
        } @else {
          <section class="mq">
            <div class="stack" style="gap:6px;flex:1 1 180px;max-width:260px">
              <h4 style="margin:0 0 4px">Unlinked documents</h4>
              @for (d of docs; track d.id) {
                <button class="qitem" [class.on]="qdoc()?.id === d.id" (click)="pickQueue(d.id)">
                  <span class="h-cond" style="font-size:15px">{{ d.ref }}</span>
                  <span class="small muted">{{ d.title }}</span>
                  <span class="tag" [class]="'tag ' + label(store.linkState(d.id))[1]" style="align-self:flex-start;margin-top:4px">{{ label(store.linkState(d.id))[0] }}</span>
                </button>
              }
            </div>
            <div class="stack" style="gap:12px;min-width:0;flex:4 1 340px">
              @if (qdoc(); as q) {
                <div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">Candidate records for {{ q.ref }}</h3><span class="small muted">Ranked by identifier, chain and party matches</span></div>
                <div class="preview">
                  <button class="bare pv" (click)="viewer.open('record', q.id, 0)" title="Open in viewer">
                    <span class="paper pv-sheet">
                      <span class="pv-hdr">{{ q.header }}</span>
                      <span class="pv-ttl">{{ q.title }}</span>
                      @for (t of previewText(); track $index) { <span class="pv-p">{{ t }}</span> }
                      <span class="fade"></span>
                    </span>
                    <span class="row small" style="gap:6px;color:var(--color-accent-800)"><app-icon name="eye" [size]="15" />Open full document</span>
                  </button>
                  <div class="stack" style="padding:12px 14px;gap:6px">
                    <div class="card-kicker">Verified metadata</div>
                    <div class="kv">@for (f of previewKeys(); track f.k) { <span>{{ f.label }}</span><span>{{ store.value(q, f) }}</span> }</div>
                  </div>
                </div>
                @for (c of candidates(); track c.name; let first = $first) {
                  <div class="blueprint cand" [class.top]="first"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                    <div class="cand-row">
                      <div class="h-cond score">{{ c.score }}</div>
                      <div><div class="h-cond" style="font-size:18px">{{ c.name }}</div><div class="small muted">{{ c.meta }}</div></div>
                      @if (first) {
                        <div class="row" style="gap:8px">
                          <button class="btn btn-ghost" (click)="viewer.open('record', 'g2', 0)"><app-icon name="eye" [size]="15" />Record docs</button>
                          <button class="btn btn-secondary" (click)="store.reject(q.id)">Not a match</button>
                          <button class="btn btn-primary" (click)="store.link(q.id)">Confirm link</button>
                        </div>
                      }
                    </div>
                    <div class="row" style="gap:6px;margin-top:10px">
                      @for (r of c.r; track r[1]) { <span class="tag" [class.tag-accent]="r[0] === 'ok'" [class.tag-outline]="r[0] === 'warn'" [class.tag-neutral]="r[0] === 'no'">{{ r[0] === 'ok' ? '✓' : r[0] === 'warn' ? '!' : '✗' }} {{ r[1] }}</span> }
                    </div>
                  </div>
                }
              } @else {
                <div class="blueprint empty"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                  {{ store.pendingReview().length ? store.pendingReview().length + ' document(s) still in metadata review.' : 'Queue clear — every filed document is linked or rejected.' }}</div>
              }
            </div>
          </section>
        }

        <aside class="stack" style="gap:24px;position:sticky;top:70px">
          <div>
            <h3 style="margin:0 0 8px">Registered owners</h3>
            <table class="table">
              <thead><tr><th>Owner</th><th>Namibian ID</th><th style="text-align:right">Undivided share</th></tr></thead>
              <tbody>
                @for (o of store.owners(); track o.name) {
                  <tr><td><div>{{ o.name }}</div><div class="small muted" style="font-size:11px">{{ o.note }}</div></td><td class="small muted num">{{ o.nid }}</td><td class="num" style="text-align:right">{{ o.frac }}</td></tr>
                }
              </tbody>
            </table>
            <div class="row" style="height:8px;margin-top:10px;gap:2px;flex-wrap:nowrap">
              @for (o of store.owners(); track o.name; let i = $index) { <div style="height:100%" [style.width.%]="o.pct" [style.background]="barColors[i]" [title]="o.name"></div> }
            </div>
          </div>
          <div>
            <h3 style="margin:0 0 8px">Record validation</h3>
            <div style="border-top:1px solid var(--color-divider)">
              @for (c of store.checks(); track c.label) {
                <div class="check">
                  <span class="check-mark" [class.ok]="c.state === 'ok'">{{ c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '–' }}</span>
                  <div><div style="font-size:13px;font-weight:500">{{ c.label }}</div><div class="small muted">{{ c.detail }}</div></div>
                </div>
              }
            </div>
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: [`
    .rec-head { display: flex; justify-content: space-between; align-items: end; gap: 20px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px solid var(--color-divider); }
    .ev { display: grid; grid-template-columns: 84px 20px minmax(0, 1fr); gap: 0 10px; }
    .when { padding-top: 12px; text-align: right; }
    .spine { display: flex; flex-direction: column; align-items: center; }
    .spine i { width: 1px; height: 16px; background: var(--color-divider); display: block; }
    .spine b { width: 9px; height: 9px; border: 1px solid var(--color-accent-700); background: var(--color-bg); transform: rotate(45deg); display: block; }
    .spine b.fill { background: var(--color-accent-700); }
    .evcard { padding: 11px 14px; margin: 6px 0 10px; }
    .evcard.dashed { border-style: dashed; }
    .evcard.sugg { background: var(--color-accent-100); }
    .sugg-bar { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--color-divider); justify-content: space-between; }
    .mq { display: flex; flex-wrap: wrap; gap: 20px; min-width: 0; align-items: flex-start; }
    .qitem { text-align: left; border: 1px solid var(--color-divider); border-left: 2px solid transparent; background: transparent; padding: 9px 11px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
    .qitem:hover { background: var(--color-accent-100); }
    .qitem.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .preview { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); border: 1px solid var(--color-divider); }
    .pv { background: var(--color-neutral-200); padding: 14px; cursor: zoom-in; display: flex; flex-direction: column; gap: 8px; }
    .pv-sheet { display: block; padding: 16px 18px; height: 200px; overflow: hidden; position: relative; }
    .pv-hdr { display: block; text-align: center; font-size: 8px; letter-spacing: .18em; color: var(--color-neutral-700); }
    .pv-ttl { display: block; text-align: center; font-family: var(--font-heading); font-weight: 600; font-size: 15px; text-transform: uppercase; margin: 4px 0 8px; }
    .pv-p { display: block; font-size: 10px; line-height: 1.6; text-align: justify; margin-bottom: 5px; }
    .fade { position: absolute; left: 0; right: 0; bottom: 0; height: 40px; background: linear-gradient(transparent, var(--color-neutral-100)); }
    .cand { padding: 14px 16px; }
    .cand.top { background: var(--color-accent-100); }
    .cand-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 14px; align-items: center; }
    .score { font-size: 30px; line-height: 1; color: var(--color-accent-800); }
    .empty { padding: 28px; text-align: center; font-size: 14px; color: var(--color-neutral-700); border-style: dashed; }
    .check { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--color-divider); }
    @media (max-width: 700px) { .cand-row { grid-template-columns: 1fr; } }
  `]
})
export class LinkComponent {
  store = inject(RegistryStore);
  viewer = inject(ViewerService);
  router = inject(Router);
  mode = signal<'timeline' | 'queue'>('timeline');
  qsel = signal<string | null>(null);
  base = BASE;
  docs = DOCS;
  barColors = ['var(--color-accent-700)', 'var(--color-accent-500)', 'var(--color-accent-300)'];

  label(st: LinkState) { return LABEL[st]; }
  events = computed(() => {
    this.store.filed(); this.store.linked(); this.store.rejected();
    const rows = [
      ...BASE.map(b => ({ ...b, st: 'base' as LinkState, match: '', reasons: '' })),
      ...DOCS.map(d => ({ id: d.id, iso: d.iso!, ref: d.ref, edrms: this.store.filed()[d.id] ? d.edrms : 'Not filed', st: this.store.linkState(d.id), ...NEW[d.id] }))
    ].sort((a, b) => a.iso.localeCompare(b.iso));
    return rows.map(r => { const [y, m, d] = r.iso.split('-'); return { ...r, year: y, day: +d + ' ' + MONTHS[+m - 1] }; });
  });
  qdoc = computed(() => {
    const open = this.store.openSuggestions();
    return open.find(d => d.id === this.qsel()) || open[0] || null;
  });
  candidates = computed(() => this.qdoc() ? CANDS[this.qdoc()!.id] : []);
  previewText = computed(() => {
    const q = this.qdoc(); if (!q) return [];
    return q.paras.slice(0, 3).map(p => p.map(s => { const f = q.fields.find(x => x.k === s); return f ? this.store.value(q, f) : s; }).join(''));
  });
  previewKeys = computed(() => (this.qdoc()?.fields || []).filter(f => ['property', 'regDiv', 'priorTitle', 'transferor', 'tee1', 'tee2', 'share', 'extent', 'sgNo'].includes(f.k)));
  pickQueue(id: string) {
    const st = this.store.linkState(id);
    if (st === 'suggested') this.qsel.set(id);
    else if (st === 'pending') this.router.navigate(['/verify'], { queryParams: { doc: id } });
    else this.store.undo(id);
  }
}
