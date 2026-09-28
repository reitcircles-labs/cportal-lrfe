import { Component, computed, inject, input, output } from '@angular/core';
import { LandDoc } from '../data/models';
import { RegistryStore } from '../state/registry.store';

export type HighlightMode = 'review' | 'audit' | 'none';

/** Renders one page of a scanned instrument. Page 0 carries the extracted text; later pages are continuation sheets. */
@Component({
  selector: 'app-doc-page',
  standalone: true,
  template: `
    <div class="blueprint sheet" [style.font-size.px]="13 * scale()" [style.padding]="pad()" [class.fixed]="fixedRatio()">
      <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
      <div class="hdr">{{ doc().header }}</div>
      @if (page() === 0) {
        <div class="title">{{ doc().title }}</div>
        @if (doc().isDiagram) {
          <div class="diagram">
            <svg viewBox="0 0 400 220" width="100%" fill="none" stroke="var(--color-neutral-800)" stroke-width="1">
              <polygon points="60,40 300,28 340,120 290,190 90,196 44,110"></polygon>
              <g font-size="10" fill="var(--color-neutral-800)" stroke="none" font-family="Barlow">
                <text x="50" y="34">A</text><text x="302" y="22">B</text><text x="346" y="122">C</text><text x="294" y="204">D</text><text x="82" y="210">E</text><text x="30" y="112">F</text>
                <text x="150" y="112" font-size="14">ERF 1873</text><text x="146" y="128">KLEIN WINDHOEK</text>
                <text x="160" y="28">31,42</text><text x="326" y="76">18,90</text><text x="320" y="160">16,05</text><text x="180" y="206">26,80</text><text x="46" y="160">13,70</text><text x="34" y="74">14,20</text>
                <text x="360" y="208">N ↑</text>
              </g>
            </svg>
          </div>
        }
        <div class="body">
          @for (p of segs(); track $index) {
            <p>@for (s of p; track $index) {<span [class.hl]="s.hl" [class.flag]="s.flag" [class.act]="s.active" [class.edit]="s.edited" [class.click]="!!s.key" (click)="s.key && segClick.emit(s.key)">{{ s.text }}</span>}</p>
          }
        </div>
        <div class="sig">
          <div>{{ doc().sigL || 'Signature' }}</div>
          <div class="r"><span>{{ doc().sigR || 'Registrar' }}</span><span class="seal">SEAL</span></div>
        </div>
      } @else {
        <div class="title sm">{{ contTitle() }}</div>
        <div class="cont">
          @for (w of lines(); track $index) { <span [style.width.%]="w.w" [style.margin-top.em]="w.gap"></span> }
        </div>
      }
      <div class="foot"><span>{{ doc().ref }}</span><span>Page {{ page() + 1 }} of {{ doc().pages }}</span></div>
    </div>
  `,
  styles: [`
    .sheet { background: var(--color-neutral-100); box-shadow: var(--shadow-sm); box-sizing: border-box; color: var(--color-neutral-900); }
    .sheet.fixed { aspect-ratio: 1 / 1.414; overflow: hidden; }
    .hdr { text-align: center; font-size: .72em; letter-spacing: .2em; color: var(--color-neutral-700); }
    .title { text-align: center; font-family: var(--font-heading); font-weight: 600; font-size: 1.9em; margin: .45em 0 1.2em; text-transform: uppercase; letter-spacing: .02em; line-height: 1.1; }
    .title.sm { font-size: 1.3em; }
    .diagram { border: 1px solid var(--color-neutral-500); padding: .6em; margin-bottom: 1.2em; }
    .diagram svg { display: block; }
    .body { display: flex; flex-direction: column; gap: .9em; line-height: 1.85; text-align: justify; }
    .body p { margin: 0; }
    .body span.click { cursor: pointer; padding: 1px 2px; }
    .body span.hl { background: var(--color-accent-100); }
    .body span.flag { box-shadow: inset 0 -1.5px 0 var(--color-accent-700); }
    .body span.edit { background: var(--color-accent-100); box-shadow: 0 0 0 1px var(--color-accent-700); }
    .body span.act { background: var(--color-accent-300); box-shadow: 0 0 0 1.5px var(--color-accent-700); }
    .cont { display: flex; flex-direction: column; gap: .55em; }
    .cont span { height: .45em; background: var(--color-neutral-300); display: block; }
    .sig { display: grid; grid-template-columns: 1fr 1fr; gap: 3em; margin-top: 3em; font-size: .8em; color: var(--color-neutral-700); }
    .sig > div { border-top: 1px solid var(--color-neutral-600); padding-top: .4em; }
    .sig .r { display: flex; justify-content: space-between; }
    .seal { border: 1px solid var(--color-accent-400); border-radius: 50%; width: 4em; height: 4em; margin-top: -2.4em; display: grid; place-items: center; font-size: .75em; color: var(--color-accent-700); }
    .foot { margin-top: 2em; display: flex; justify-content: space-between; font-size: .72em; color: var(--color-neutral-700); }
  `]
})
export class DocPageComponent {
  private store = inject(RegistryStore);
  doc = input.required<LandDoc>();
  page = input(0);
  scale = input(1);
  mode = input<HighlightMode>('none');
  activeKey = input<string | null>(null);
  showAll = input(false);
  fixedRatio = input(false);
  segClick = output<string>();

  pad = computed(() => Math.round(40 * this.scale()) + 'px ' + Math.round(46 * this.scale()) + 'px');
  segs = computed(() => {
    const d = this.doc(), th = this.store.threshold(), mode = this.mode();
    this.store.fs();
    return d.paras.map(p => p.map(s => {
      const idx = d.fields.findIndex(x => x.k === s);
      if (idx < 0) return { text: s, key: null as string | null, hl: false, flag: false, active: false, edited: false };
      const f = d.fields[idx];
      const done = this.store.status(d, f, idx) !== 'pending';
      const low = (f.c ?? 1) < th;
      return {
        text: mode === 'audit' ? f.v : this.store.value(d, f), key: mode === 'review' ? s : null,
        hl: mode === 'review' && (this.showAll() || low), flag: mode === 'review' && low && !done,
        active: mode === 'review' && this.activeKey() === s, edited: mode === 'audit' && this.store.isEdited(d, f)
      };
    }));
  });
  contTitle = computed(() => {
    const t = this.doc().isDiagram ? ['Coordinate list'] : ['Conditions of title', 'Annexure · power of attorney', 'Transfer duty receipt', 'Endorsements'];
    return t[(this.page() - 1) % t.length];
  });
  lines = computed(() => {
    const seed = this.page() * 31 + this.doc().ref.length * 7;
    return Array.from({ length: 22 }, (_, k) => ({ w: 62 + (((k + seed) * 9301 + 49297) % 233280) / 233280 * 38, gap: k % 6 === 5 ? 0.9 : 0 }));
  });
}
