import {Component, inject, ChangeDetectionStrategy} from '@angular/core';
import {IconComponent} from '../../shared/icon.component';
import {CanDirective} from '../../shared/can.directive';
import {VerifyStore} from './verify.store';

/** Verify: the open document, its scan and its extracted fields, with the review actions. */
@Component({
  selector: 'app-verify-document',
  imports: [IconComponent, CanDirective],
  template: `
    <section class="main">
      @if (store.doc(); as d) {
        <header class="doc-head">
          <div class="stack" style="gap:2px;min-width:0;margin-right:auto">
            <span class="card-kicker">{{ d.batchId }} · {{ store.posLabel() }}</span>
            <span class="row" style="gap:10px;align-items:baseline"><span class="h-cond" style="font-size:28px;line-height:1.05">{{ d.ref || d.fileName }}</span>
              <span style="font-size:13px;color:var(--color-neutral-800)" [title]="d.docTypeReason || ''">{{ d.docTypeLabel || 'Type not recognised' }}{{ d.property ? ' · ' + d.property : '' }}</span></span>
          </div>
          <button class="btn btn-secondary" (click)="store.openFile()"><app-icon name="eye" [size]="15" />Open scan</button>
          @if (d.status === 'ready' || d.status === 'failed') {
            <button class="btn btn-secondary" appCan="verify.edit" [disabled]="store.busy()" (click)="store.reread()" title="Read the document again with the stronger model">Re-read</button>
            <button class="btn btn-secondary" appCan="verify.file" [disabled]="store.busy() || !!store.lockedBy()" (click)="store.rejectDraft.set('')">Reject</button>
          }
          <div class="row" style="gap:4px">
            <button class="btn btn-secondary btn-icon" [disabled]="store.pos() <= 0" (click)="store.move(-1)" title="Previous document"><app-icon name="up" /></button>
            <button class="btn btn-secondary btn-icon" [disabled]="store.pos() < 0 || store.pos() >= store.flat().length - 1" (click)="store.move(1)" title="Next document"><app-icon name="down" /></button>
          </div>
        </header>

        @if (store.lockedBy()) {
          <div class="banner"><app-icon name="lock" [size]="18" /><span>{{ store.lockedBy() }}. You can look, but not change it.</span></div>
        }
        @for (n of d.notes; track n.code) {
          <div class="banner" [class.err]="n.level === 'error'" [class.quiet]="n.level === 'info'"><app-icon [name]="n.level === 'info' ? 'info' : 'alert'" [size]="18" /><span class="small">{{ n.message }}</span></div>
        }

        @switch (d.status) {
          @case ('queued') { <div class="panel state">Waiting to be read by the AI. This page updates by itself.</div> }
          @case ('extracting') { <div class="panel state">The AI is reading this document. This page updates by itself.</div> }
          @case ('failed') {
            <div class="banner err"><app-icon name="alert" [size]="18" /><span class="stack" style="gap:2px"><b>Reading failed</b><span class="small">{{ d.extractionError }}</span></span>
              <span class="spacer"></span><button class="btn btn-secondary" appCan="verify.edit" [disabled]="store.busy()" (click)="store.retry()">Retry</button></div>
          }
          @case ('rejected') { <div class="banner err"><app-icon name="x" [size]="18" /><span class="stack" style="gap:2px"><b>Rejected</b><span class="small">{{ d.rejectedReason }}</span></span></div> }
          @case ('filed') {
            <div class="banner ok"><app-icon name="checkCircle" [size]="18" /><span><b>Filed as {{ d.edrmsNo }}</b></span><span class="spacer"></span>
              @if (d.filedDocumentId) { <button class="btn btn-secondary" (click)="store.router.navigate(['/documents'], { queryParams: { id: d.filedDocumentId } })">Open in Documents →</button> }</div>
          }
        }

        @if (d.status === 'ready' || d.status === 'filed' || d.status === 'rejected') {
          <div class="review">
            <div class="stack" style="gap:8px;min-width:0">
              <div class="row small muted" style="justify-content:space-between"><span>Scan{{ d.pages ? ' · ' + d.pages + ' page' + (d.pages === 1 ? '' : 's') : '' }}{{ store.isPdf() ? ' · showing page ' + store.page() : '' }}</span><span>Selecting a field opens the page its evidence is on</span></div>
              <div class="scan">
                @if (store.src(); as s) {
                  @if (store.isPdf()) { <iframe [src]="s" title="Scanned document"></iframe> } @else { <img [src]="store.rawUrl()" alt="Scanned document"> }
                } @else { <div class="small muted" style="padding:40px;text-align:center">Loading the scan…</div> }
              </div>
              @if (store.pageText(); as t) {
                <details class="transcript"><summary class="small">AI transcription of page {{ store.page() }}</summary><p class="small">{{ t }}</p></details>
              }
            </div>

            <div class="stack sticky" style="gap:10px">
              <div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">Extracted metadata</h3><span class="small muted">{{ store.reviewed() }} of {{ d.fields.length }} reviewed</span></div>
              <div class="row" style="gap:8px;flex-wrap:wrap">
                <span class="tag tag-neutral">{{ d.docTypeLabel || 'Unknown type' }}</span>
                @if (d.flags.conflict) { <span class="tag tag-danger">{{ d.flags.conflict }} conflict</span> }
                @if (d.flags.check + d.flags.missing) { <span class="tag tag-outline">{{ d.flags.check + d.flags.missing }} to check</span> }
                @if (d.escalated) { <span class="tag tag-info">read by two models</span> }
              </div>
              @if (!d.fields.length) {
                <div class="small muted">No fields: the document type was not recognised. Re-read it with the stronger model, or reject it.</div>
              }
              <div class="fields">
                @for (f of d.fields; track f.k) {
                  <div class="frow" [class.on]="f.k === store.activeKey()" (click)="store.activate(f)">
                    <div class="row small" style="gap:8px;min-width:0"><span class="muted">{{ f.label }}{{ f.required ? ' *' : '' }}</span>
                      @if (f.flag !== 'ok' && f.status === 'pending') { <span class="flag" [class.bad]="f.flag === 'conflict'">· {{ f.flag }}</span> }
                      @if (f.status === 'edited') { <span class="flag ok">· corrected</span> }</div>
                    <span></span>
                    <input class="input" [id]="'f-' + f.k" [readonly]="!store.editable()" [value]="f.value" (focus)="store.activate(f)"
                           (change)="store.save(f, $any($event.target).value)" (keydown.enter)="store.enter(f, $any($event.target).value)">
                    <button class="btn btn-icon" [class.btn-primary]="f.status !== 'pending'" [class.btn-secondary]="f.status === 'pending'" style="width:40px;height:32px"
                            [title]="f.status === 'pending' ? 'Accept' : 'Undo accept'" appCan="verify.edit" [disabled]="!store.editable()" (click)="store.toggleAccept(f, $event)"><app-icon name="check" /></button>
                    @if (f.k === store.activeKey()) {
                      <div class="detail">
                        @if (f.evidence?.text) { <div class="small"><span class="muted">Evidence{{ f.evidence?.page ? ', page ' + f.evidence?.page : '' }}:</span> “{{ f.evidence?.text }}”</div> }
                        @else if (f.extracted === null) { <div class="small muted">Not found by the AI{{ f.value ? '; entered by a reviewer' : '' }}.</div> }
                        @if (f.status === 'edited' && f.extracted !== null && f.extracted !== f.value) { <div class="small muted">AI read “{{ f.extracted }}”</div> }
                        @for (c of f.checks; track $index) { <div class="small chk" [class.err]="c.level === 'error'" [class.warn]="c.level === 'warn'">{{ c.message }}</div> }
                        @if (f.alt; as a) {
                          <div class="small row" style="gap:8px">{{ a.reading === 'first' ? 'First' : a.reading === 'second' ? 'Second' : 'Other' }} reading: “{{ a.value }}”
                            @if (store.editable()) { <button class="btn btn-ghost small" (click)="store.save(f, a.value); $event.stopPropagation()">Use this reading</button> }</div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
              @if (store.editable() && store.missingFields().length) {
                <select class="input" style="font-size:13px" (change)="store.addField($any($event.target).value); $any($event.target).value = ''">
                  <option value="">Add a field the AI did not find…</option>
                  @for (m of store.missingFields(); track m.k) { <option [value]="m.k">{{ m.label }}</option> }
                </select>
              }
              @if (d.status === 'ready') {
                @if (store.blockers().length) { <ul class="blockers small">@for (b of store.blockers(); track b) { <li>{{ b }}</li> }</ul> }
                <div class="row" style="margin-top:4px">
                  <button class="btn btn-secondary" appCan="verify.edit" [disabled]="!store.editable() || store.busy() || !store.cleanPending()" (click)="store.acceptClean()">Accept {{ store.cleanPending() || '' }} clean field{{ store.cleanPending() === 1 ? '' : 's' }}</button>
                  <span class="spacer"></span>
                  <button class="btn btn-primary" appCan="verify.file" [disabled]="!store.editable() || store.busy() || store.blockers().length > 0" (click)="store.file()">{{ store.busy() ? 'Working…' : 'Approve & file to EDRMS' }}</button>
                </div>
              }
            </div>
          </div>
        }
      } @else {
        <div class="panel muted" style="padding:40px;text-align:center">{{ store.loading() ? 'Loading…' : store.list().length ? 'Select a document from the queue.' : 'Nothing to review yet. Upload scans on the Capture screen.' }}</div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
    .main { padding: 16px 24px 32px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .doc-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 16px 18px; background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
    .banner { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-radius: var(--radius-lg); background: var(--warn-bg); border: 1px solid var(--warn-bd); color: var(--warn-fg); flex-wrap: wrap; }
    .banner.quiet { background: var(--color-surface); border-color: var(--color-divider); color: var(--color-text); }
    .banner.ok { background: var(--success-bg); border-color: var(--success); color: var(--color-text); }
    .banner.err { background: var(--danger-bg); border-color: var(--danger-bd); color: var(--danger-fg); }
    .state { padding: 40px; text-align: center; color: var(--color-neutral-700); }
    .review { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 440px); gap: 24px; align-items: start; }
    .sticky { position: sticky; top: calc(var(--topbar-h) + 16px); }
    .scan { height: calc(100vh - var(--topbar-h) - 220px); min-height: 420px; border: 1px solid var(--color-divider); border-radius: var(--radius-lg); background: var(--color-surface-2); overflow: auto; }
    .scan iframe { width: 100%; height: 100%; border: 0; display: block; }
    .scan img { width: 100%; display: block; }
    .transcript summary { cursor: pointer; color: var(--color-neutral-700); }
    .transcript p { white-space: pre-wrap; margin: 8px 0 0; max-height: 220px; overflow-y: auto; }
    .fields { border-top: 1px solid var(--color-divider); max-height: calc(100vh - var(--topbar-h) - 300px); overflow-y: auto; }
    .frow { display: grid; grid-template-columns: minmax(0, 1fr) 40px; gap: 4px 10px; padding: 10px 14px; border-bottom: 1px solid var(--color-divider); border-left: 3px solid transparent; background: var(--color-surface); }
    .frow.on { background: var(--color-accent-100); border-left-color: var(--color-accent); }
    .frow .input { min-height: 32px; padding: 4px 8px; background: transparent; }
    .flag { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-accent-800); }
    .flag.bad { color: var(--danger-fg); }
    .flag.ok { color: var(--success-fg); }
    .detail { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
    .chk { padding-left: 8px; border-left: 2px solid var(--color-divider); color: var(--color-neutral-800); }
    .chk.warn { border-left-color: var(--warn-bd); }
    .chk.err { border-left-color: var(--danger-bd); color: var(--danger-fg); }
    .blockers { margin: 4px 0 0; padding-left: 18px; color: var(--color-neutral-800); }
    @media (max-width: 1180px) { .review { grid-template-columns: 1fr; } .sticky { position: static; } .fields { max-height: none; } }
    @media (max-width: 900px) { .scan { height: 60vh; } }
  `,
  ],
})
export class VerifyDocumentComponent {
  protected readonly store = inject(VerifyStore);
}
