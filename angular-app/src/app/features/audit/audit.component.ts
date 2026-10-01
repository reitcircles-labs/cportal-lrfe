import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { DOCS, VIEWDOCS, hash } from '../../data/mock-data';
import { LandDoc } from '../../data/models';
import { RegistryStore } from '../../state/registry.store';
import { ViewerService } from '../../state/viewer.service';
import { DocPageComponent } from '../../shared/doc-page.component';
import { IconComponent } from '../../shared/icon.component';
import { CanDirective } from '../../shared/can.directive';
import { RbacService } from '../../state/rbac.service';

import { ConfirmService } from '../../state/confirm.service';

const ORDER = ['g1', 'g2', 'b', 'a', 'c'];
const TAG: Record<string, string> = { Audited: 'tag-accent', Finding: 'tag-outline', Filed: 'tag-accent', Linked: 'tag-accent', Committed: 'tag-accent', Rejected: 'tag-outline' };

@Component({
    selector: 'app-audit',
    imports: [DocPageComponent, IconComponent, CanDirective],
    template: `
    <div class="page stack" style="gap:22px">
      <header class="row" style="justify-content:space-between;align-items:end">
        <div><div class="card-kicker">Read-only</div><h1 style="margin:4px 0 0;font-size:38px">Audit · Erf 1873, Klein Windhoek</h1></div>
        <div class="row small" style="gap:18px;color:var(--color-neutral-800);font-size:13px">
          <span>{{ store.trail().length }} entries</span><span>Hash chain intact</span><span>{{ auditedCount() }} of 5 documents audited</span>
          <button class="btn btn-secondary" appCan="audit.export">Export evidence pack</button>
        </div>
      </header>

      <div class="docs">
        @for (d of docList(); track d.doc.id) {
          <button class="dcell" [class.on]="d.doc.id === sel()?.id" [disabled]="!d.avail" (click)="selId.set(d.doc.id)">
            <span class="row" style="justify-content:space-between;gap:6px"><span class="small muted" style="font-size:11px">{{ d.year }}</span><span class="tag" [class]="'tag ' + d.tag" style="padding:1px 7px;font-size:10px">{{ d.state }}</span></span>
            <span class="h-cond" style="font-size:17px;line-height:1.1">{{ d.doc.ref }}</span>
            <span class="small muted">{{ d.doc.title }}{{ d.edits ? ' · ' + d.edits + ' corrected' : '' }}</span>
          </button>
        }
      </div>

      @if (sel(); as d) {
        <div class="auto-grid">
          <section class="stack" style="gap:8px;min-width:0">
            <div class="row" style="justify-content:space-between;align-items:baseline"><h4 style="margin:0">{{ d.title }} {{ d.ref }}</h4><span class="small muted">{{ d.pages }} pages · page 1 shown · corrected values outlined</span></div>
            <button class="bare evidence" (click)="viewer.open('audit', d.id, 0)" title="Open in viewer">
              <app-doc-page [doc]="d" mode="audit" [scale]="0.9" />
              <span class="row small" style="gap:6px;color:var(--color-accent-800);margin-top:10px"><app-icon name="eye" [size]="15" />Open all pages in viewer</span>
            </button>
          </section>
          <section class="stack" style="gap:18px;min-width:0">
            <div>
              <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:6px"><h4 style="margin:0">Metadata provenance</h4><span class="small muted">{{ d.isBase ? 'Verified in 2025 pilot' : editCount() + ' of ' + d.fields.length + ' fields corrected by reviewer' }}</span></div>
              <div style="overflow-x:auto">
                <table class="table" style="font-size:13px">
                  <thead><tr><th>Field</th><th>Extracted</th><th>Verified</th><th style="text-align:right">Conf.</th><th>Review</th></tr></thead>
                  <tbody>
                    @for (r of provenance(); track r.label) {
                      <tr [class.edited]="r.edited">
                        <td class="small muted">{{ r.label }}</td>
                        <td class="small" [class.strike]="r.edited" style="overflow-wrap:anywhere">{{ r.ex }}</td>
                        <td style="overflow-wrap:anywhere">{{ r.val }}</td>
                        <td class="small muted num" style="text-align:right">{{ r.conf }}</td>
                        <td class="small" [style.color]="r.edited ? 'var(--color-accent-800)' : 'var(--color-neutral-700)'">{{ r.rev }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px">
              <div><h4 style="margin:0 0 6px">Integrity</h4><div class="kv">@for (i of integrity(); track i.k) { <span>{{ i.k }}</span><span class="num">{{ i.v }}</span> }</div></div>
              <div><h4 style="margin:0 0 6px">Document trail</h4>
                <div class="dtrail">
                  @for (t of docTrail(); track $index) { <div class="small"><div style="font-weight:500">{{ t.action }} · {{ t.who }}</div><div class="muted">{{ t.time.slice(12) }} · {{ t.detail }}</div></div> }
                  @empty { <div class="small muted">No events in this session</div> }
                </div>
              </div>
            </div>
            <div class="row" style="padding-top:12px;border-top:1px solid var(--color-divider)">
              @if (store.audited()[d.id]; as a) { <span class="tag tag-accent" style="padding:8px 12px">{{ a === 'finding' ? 'Finding raised' : 'Audited' }} · Office of the Auditor-General</span> }
              @else {
                <button class="btn btn-secondary" appCan="audit.signoff" (click)="raise(d)">Raise finding</button>
                <button class="btn btn-primary" appCan="audit.signoff" (click)="signOff(d)">Mark document audited</button>
              }
              <button class="btn btn-ghost spacer" (click)="viewer.open('audit', d.id, 0)"><app-icon name="eye" [size]="15" />Open viewer</button>
            </div>
          </section>
        </div>
      }

      <section>
        <h4 style="margin:0 0 6px">Full audit trail</h4>
        <div style="overflow-x:auto">
          <table class="table" style="min-width:900px">
            <thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Object</th><th>Detail</th><th>Entry hash</th><th></th></tr></thead>
            <tbody>
              @for (a of reversed(); track a.hash) {
                <tr>
                  <td class="num" style="font-size:13px">{{ a.time }}</td><td>{{ a.who }}</td><td class="small muted">{{ a.role }}</td>
                  <td><span class="tag" [class]="'tag ' + (tag[a.action] || 'tag-neutral')">{{ a.action }}</span></td>
                  <td class="num" style="font-size:13px">{{ a.obj }}</td><td style="font-size:13px">{{ a.detail }}</td>
                  <td class="mono muted" style="font-size:11px">{{ a.hash }}</td>
                  <td style="text-align:right">@if (a.doc) { <button class="btn btn-secondary" style="padding:3px 8px;font-size:12px" (click)="selId.set(a.doc.id)"><app-icon name="eye" [size]="14" />Inspect</button> }</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
    changeDetection: ChangeDetectionStrategy.Eager,
    styles: [`
    .docs { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
    .dcell { text-align: left; border: 1px solid var(--color-divider); border-top: 3px solid var(--color-divider); border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-sm); padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
    .dcell:hover:not(:disabled) { background: var(--color-accent-100); }
    .dcell.on { background: var(--color-accent-100); border-top-color: var(--color-accent); }
    .dcell:disabled { opacity: .45; cursor: not-allowed; }
    .evidence { background: var(--color-neutral-200); border-radius: var(--radius-lg); border: 1px solid var(--color-divider); padding: 18px; cursor: zoom-in; display: block; width: 100%; }
    tr.edited { background: var(--color-accent-100); }
    .strike { text-decoration: line-through; color: var(--color-neutral-600); }
    .dtrail { border-left: 1px solid var(--color-divider); padding-left: 12px; display: flex; flex-direction: column; gap: 8px; }
  `]
})
export class AuditComponent {
  store = inject(RegistryStore);
  viewer = inject(ViewerService);
  private confirm = inject(ConfirmService);
  selId = signal('a');
  async raise(d: LandDoc) {
    if (await this.confirm.ask({ title: 'Raise a finding on ' + d.ref + '?', body: 'The records officer and registrar are notified. The document stays linked but is flagged until the finding is resolved.', confirmLabel: 'Raise finding', tone: 'danger' })) this.store.audit(d, 'finding', this.editCount());
  }
  async signOff(d: LandDoc) {
    if (await this.confirm.ask({ title: 'Mark ' + d.ref + ' as audited?', body: 'You confirm the page image, verified metadata and file hash reconcile. Your sign-off is added to the audit trail.', confirmLabel: 'Mark audited' })) this.store.audit(d, 'ok', this.editCount());
  }
  tag = TAG;

  private avail(d: LandDoc) { return d.isBase || !!this.store.filed()[d.id] || this.store.gotPages(d) === d.pages; }
  private stateOf(d: LandDoc) {
    const a = this.store.audited()[d.id];
    if (a) return a === 'finding' ? 'Finding' : 'Audited';
    const ls = this.store.linkState(d.id);
    return ls === 'base' || ls === 'linked' ? 'Linked' : ls === 'rejected' ? 'Rejected' : this.store.filed()[d.id] ? 'Filed' : this.avail(d) ? 'In review' : 'Not captured';
  }
  docList = computed(() => {
    this.store.pages(); this.store.filed(); this.store.linked(); this.store.audited(); this.store.fs();
    return ORDER.map(id => VIEWDOCS.find(v => v.id === id)!).map(doc => {
      const state = this.stateOf(doc);
      return { doc, avail: this.avail(doc), state, year: doc.isBase ? (doc.id === 'g1' ? '1978' : '1996') : doc.iso!.slice(0, 4),
        tag: state === 'Audited' || state === 'Linked' || state === 'Filed' ? 'tag-accent' : state === 'Finding' ? 'tag-outline' : 'tag-neutral',
        edits: doc.fields.filter(f => this.store.isEdited(doc, f)).length };
    });
  });
  sel = computed(() => { const l = this.docList(); return (l.find(x => x.doc.id === this.selId() && x.avail) || l.find(x => x.avail))?.doc || null; });
  provenance = computed(() => {
    const d = this.sel(); if (!d) return [];
    this.store.fs();
    return d.fields.map((f, i) => {
      const edited = !d.isBase && this.store.isEdited(d, f), st = this.store.status(d, f, i);
      return { label: f.label, ex: f.v, val: this.store.value(d, f), conf: f.c ? Math.round(f.c * 100) + '%' : '—', edited,
        rev: d.isBase ? 'Pilot verified' : edited ? 'Corrected · A. Mwandingi' : st === 'pending' ? 'Not reviewed' : 'Accepted · A. Mwandingi' };
    });
  });
  editCount = computed(() => this.provenance().filter(r => r.edited).length);
  integrity = computed(() => {
    const d = this.sel()!, ls = this.stateOf(d);
    return [
      { k: 'EDRMS ID', v: this.store.isFiled(d) ? d.edrms : 'Not yet filed' },
      { k: 'SHA-256', v: hash(d.ref + 'file') },
      { k: 'Captured', v: d.isBase ? 'PILOT-2025 · Vault 1' : 'WDH-B017 · ' + (this.store.src() === 'hot' ? 'hot folder' : 'SC-02') },
      { k: 'Classifier', v: Math.round(d.cls * 100) + '% · ' + d.type },
      { k: 'Record link', v: this.store.linkState(d.id) === 'base' ? 'Erf 1873 · v2' : this.store.linked()[d.id] ? 'Erf 1873 · ' + (this.store.committed() ? 'v3' : 'pending commit') : ls },
      { k: 'Retention', v: 'Permanent · Archives Act' }
    ];
  });
  docTrail = computed(() => this.store.trail().filter(a => a.doc && a.doc.id === this.sel()?.id).reverse());
  reversed = computed(() => [...this.store.trail()].reverse());
  auditedCount = computed(() => Object.keys(this.store.audited()).length);
}
