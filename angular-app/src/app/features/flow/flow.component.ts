import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { flowModel } from '../../data/mock-data';

@Component({
    selector: 'app-flow',
    imports: [RouterLink],
    template: `
    <div class="page">
      <section class="intro">
        <div>
          <div class="card-kicker">Phase 1 · Digitisation for tokenization</div>
          <h1 class="hero">From a scanned deed to a verified erf record</h1>
          <p class="lede">Scanners feed single instruments — deeds of transfer, deeds of grant, SG diagrams — into the EDRMS. Extraction proposes metadata; reviewers verify it against the image, then records officers link each document into the erf or farm record in the ERP, which holds the chain of title.</p>
          <div class="row" style="margin-top:18px">
            <a class="btn btn-primary blueprint" routerLink="/capture" style="padding:10px 18px;font-size:15px"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>Start with batch WDH-B017 →</a>
            <span class="small muted">Erf 1873, Klein Windhoek · 3 instruments · 9 pages</span>
          </div>
        </div>
        <div class="pair">
          <div class="blueprint cardx"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            <div class="card-kicker">EDRMS</div><div class="card-title">Document of record</div>
            <p class="small">One instrument, e.g. T 2210/2008. Page images, SHA-256 hash, verified metadata. Immutable once filed.</p>
          </div>
          <div class="blueprint cardx"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
            <div class="card-kicker">ERP</div><div class="card-title">Land record</div>
            <p class="small">One erf or farm portion. References many EDRMS documents: owners, undivided shares, bonds, diagram.</p>
          </div>
        </div>
      </section>

      <div class="scroll">
        <div class="lanes">
          <div class="cell"></div>
          @for (st of m.stages; track st.n) {
            <a class="cell stage" [routerLink]="'/' + st.route">
              <span class="small" style="letter-spacing:.08em;color:var(--color-accent-700)">{{ st.n }}</span>
              <span class="h-cond" style="font-size:22px">{{ st.label }}</span>
              <span class="small muted">{{ st.screen }}</span>
            </a>
          }
          @for (ln of m.lanes; track ln.name) {
            <div class="cell lane"><span class="h-cond" style="font-size:17px">{{ ln.name }}</span><span class="small muted">{{ ln.sub }}</span></div>
            @for (c of ln.cells; track $index) {
              <div class="cell box">
                @if (c.has) {
                  <div class="blueprint step" [style.background]="c.bg"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                    <div class="h-cond" style="font-size:15px;line-height:1.2;margin-bottom:3px">{{ c.title }}</div>
                    <div class="small" style="line-height:1.45;color:var(--color-neutral-800)">{{ c.body }}</div>
                  </div>
                }
              </div>
            }
          }
        </div>
      </div>

      <section class="schema">
        <div>
          <div class="card-kicker">Metadata schema</div>
          <h2 style="margin:6px 0 8px">What gets extracted</h2>
          <p class="small" style="color:var(--color-neutral-800)">Fields follow the Namibian Deeds Registries Act 14 of 2015 and Surveyor-General conventions (erf / farm, registration division, SG diagram, undivided shares, marital regime). The Dutch Kadaster (BRK) is a reference for how a mature registry separates parcel, right and right-holder.</p>
        </div>
        <div class="scroll">
          <table class="table" style="min-width:720px">
            <thead><tr><th>ERP attribute</th><th>Namibia — source on the document</th><th>Example</th><th>NL Kadaster reference</th></tr></thead>
            <tbody>
              @for (r of m.schema; track r.a) {
                <tr><td style="font-weight:500">{{ r.a }}</td><td style="font-size:13px">{{ r.na }}</td><td class="small muted num">{{ r.ex }}</td><td class="small muted">{{ r.nl }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
    styles: [`
    .intro { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 32px 40px; align-items: end; margin: 8px 0 30px; }
    .hero { font-size: 48px; margin: 6px 0 10px; text-wrap: balance; }
    .lede { max-width: 62ch; color: var(--color-neutral-800); text-wrap: pretty; margin: 0; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .cardx { padding: 14px 16px; }
    .cardx p { margin: 6px 0 0; color: var(--color-neutral-800); }
    .scroll { overflow-x: auto; }
    .lanes { display: grid; grid-template-columns: 130px repeat(5, minmax(170px, 1fr)); min-width: 1000px; border-top: 1px solid var(--color-divider); border-left: 1px solid var(--color-divider); }
    .cell { border-right: 1px solid var(--color-divider); border-bottom: 1px solid var(--color-divider); }
    .stage { display: flex; flex-direction: column; padding: 12px 14px; text-decoration: none; color: var(--color-text); }
    .stage:hover { background: var(--color-accent-100); }
    .lane { padding: 12px 14px; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
    .box { padding: 14px 12px; min-height: 104px; }
    .step { padding: 9px 11px; height: 100%; box-sizing: border-box; }
    .schema { margin-top: 40px; display: grid; grid-template-columns: minmax(260px, 1fr) minmax(0, 2.6fr); gap: 32px; align-items: start; }
    @media (max-width: 1000px) { .schema { grid-template-columns: 1fr; } }
  `]
})
export class FlowComponent {
  m = flowModel();
}
