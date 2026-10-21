import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {DocumentField, FoundDocument} from '../../api/records.api';
import {IconComponent} from '../../shared/icon.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';
import {LinkCreateFlow} from './link-create-flow';
import {LinkDocumentDetailsComponent} from './link-document-details.component';
import {linkedText, parcelLabel, statusOf} from './link-format';

/**
 * Land records: the New record dialog (API-765). Step 1, the filed document to start from; step 2,
 * its parcel to check and correct, with the other documents for the property and whether they
 * match it, before the record is created. A parcel that already has a record offers that record.
 */
@Component({
  selector: 'app-link-create-dialog',
  imports: [IconComponent, LinkDocumentDetailsComponent],
  template: `
    @if (store.createOpen()) {
      <div class="dialog-backdrop" (click)="store.createOpen.set(false)">
        <form class="dialog" style="width:min(680px,100%)" aria-labelledby="create-title" (click)="$event.stopPropagation()"
              (submit)="$event.preventDefault(); creating.step() === 'document' ? creating.next() : creating.create()">
          <div class="dialog-title" id="create-title">New land record</div>
          <div class="steps" aria-label="Steps">
            <span class="small muted">Step {{ creating.step() === 'document' ? 1 : 2 }} of 2</span>
            <span class="stp" [class.on]="creating.step() === 'document'" [attr.aria-current]="creating.step() === 'document' ? 'step' : null">Document</span>
            <span class="stp" [class.on]="creating.step() === 'parcel'" [attr.aria-current]="creating.step() === 'parcel' ? 'step' : null">Parcel</span>
          </div>

          @if (creating.step() === 'document') {
            <div class="dialog-body">Pick the filed document to start from. Its parcel is filled in on the next step, where you can check and correct it.</div>
            <div class="search"><app-icon name="search" [size]="15" /><input class="input" placeholder="Deed no., erf, party name or EDRMS ID" [value]="creating.q()" (input)="creating.searchCreate($any($event.target).value)" aria-label="Find a filed document"></div>
            <div class="results" style="max-height:320px;overflow-y:auto;margin-top:10px">
              @for (p of creating.found(); track p.edrmsDocumentId) {
                <div class="res pick-row" [class.match]="creating.picked()?.edrmsDocumentId === p.edrmsDocumentId">
                  <label class="pick">
                    <input type="radio" name="cpick" [checked]="creating.picked()?.edrmsDocumentId === p.edrmsDocumentId" (change)="creating.pick(p)">
                    <span class="stack" style="gap:2px;min-width:0"><b class="num">{{ p.ref || p.edrmsNo }}</b><span class="small muted ell">{{ store.typeLabel(p.docType) }} · {{ p.property || p.title }}</span>
                      @if (p.linkedTo.length) { <span class="small muted">Already in {{ linkedText(p) }}</span> }</span>
                  </label>
                  <app-link-document-details [documentId]="p.edrmsDocumentId" [name]="p.ref || p.edrmsNo" [edrmsNo]="p.edrmsNo" [typeLabel]="store.typeLabel(p.docType)" [fields]="p.fields" />
                </div>
              } @empty { <div class="small muted" style="padding:12px;text-align:center">{{ creating.searching() ? 'Searching…' : creating.q().trim() ? 'No documents match.' : 'Type to search the EDRMS.' }}</div> }
            </div>
            <button type="button" class="linkish" (click)="creating.enterByHand()">No document? Enter the parcel by hand</button>
            <div class="dialog-actions">
              <button type="button" class="btn btn-secondary" (click)="store.createOpen.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="!creating.picked()">Next: check the parcel</button>
            </div>
          } @else {
            @let doc = creating.preview()?.document;
            @if (creating.byHand()) {
              <div class="dialog-body">Enter the parcel. The filed documents with its number are listed below, with whether they match it.</div>
            } @else {
              <div class="dialog-body">Check the parcel read from the document and correct it where needed.</div>
              @if (doc) {
                <div class="says">
                  <span class="small muted up">The document says · {{ store.typeLabel(doc.docType) }}{{ doc.ref ? ' ' + doc.ref : '' }} · {{ doc.edrmsNo }}</span>
                  <span>“{{ doc.property || '—' }}” · {{ regDivOf(doc) ? regDivOf(doc)!.label + ' ' + regDivOf(doc)!.v : 'no ' + parcelLabel('regDiv').toLowerCase() + ' on this document' }}</span>
                </div>
                @if (!creating.read() && !creating.previewing()) {
                  <div class="note warn" style="margin-top:10px">The parcel could not be read from this document's property. Enter it below.</div>
                }
              }
            }

            <div class="form-grid" style="margin-top:12px">
              <div class="field" style="grid-column:1/-1"><label for="kind">Kind of parcel</label>
                <select id="kind" class="input" (change)="creating.setKind($any($event.target).value)">
                  @for (k of store.kinds(); track k.id) { <option [value]="k.id" [selected]="k.id === store.ckind()">{{ k.label }}</option> }
                </select></div>
              @for (f of creating.kindFields(); track f.k) {
                @let needed = f.required && creating.missing().includes(f.k);
                @let notNamed = creating.notNamedBy(f.k);
                <div class="field" [style.grid-column]="f.k === 'township' || f.k === 'farmName' || f.k === 'schemeName' ? '1/-1' : null">
                  <label [for]="'pf-' + f.k">{{ parcelLabel(f.k) }}{{ f.required ? '' : ' (optional)' }}@if (needed) { <span class="need"> · needed</span> }</label>
                  <input class="input" [class.warn]="needed || notNamed" [id]="'pf-' + f.k" [value]="creating.form()[f.k] || ''" (input)="creating.setField(f.k, $any($event.target).value)"
                         [attr.aria-invalid]="needed || notNamed ? true : null" [attr.aria-describedby]="'pf-' + f.k + '-help'">
                  <span class="small help" [id]="'pf-' + f.k + '-help'">
                    @if (notNamed) { <span class="warn-text">{{ notNamed }} {{ notNamed === 1 ? 'document' : 'documents' }} for this property {{ notNamed === 1 ? "doesn't" : "don't" }} name this {{ parcelLabel(f.k).toLowerCase() }}.</span> }
                    @if (creating.readValue(f.k); as was) { <span class="muted">Changed from the document: “{{ was || 'empty' }}”. <button type="button" class="linkish" (click)="creating.undo(f.k)">Undo</button></span> }
                    @if (needed && creating.preview()?.suggested?.[f.k]; as s) {
                      <span class="muted">Not on this document. {{ s.from }} other {{ s.from === 1 ? 'document' : 'documents' }} for this parcel {{ s.from === 1 ? 'says' : 'say' }} {{ s.value }}.
                        <button type="button" class="linkish" (click)="creating.useSuggested(f.k)">Use {{ s.value }}</button></span>
                    }
                  </span>
                </div>
              }
            </div>

            @if (creating.existing(); as e) {
              <div class="note info existing" role="status">
                <b>{{ e.label }} already has a land record{{ creating.offer() === 'change' || creating.offer() === 'add' ? ': update it with this document' : '' }}</b>
                <div class="row" style="gap:24px">
                  <span class="stack" style="gap:1px"><span class="small muted">Record</span><span class="num">{{ e.recordNo }}</span></span>
                  <span class="stack" style="gap:1px"><span class="small muted">Status</span><span>{{ statusOf(e).label }}</span></span>
                  <span class="stack" style="gap:1px"><span class="small muted">Version</span><span>{{ versionText(e) }}</span></span>
                </div>
                <span class="small">
                  @switch (creating.offer()) {
                    @case ('change') { Draft version {{ (e.currentVersion ?? 0) + 1 }} opens with this document added. Version {{ e.currentVersion }} stays the current version until the new one is approved. }
                    @case ('add') { Draft version {{ e.draftVersion }} is open: the document is added to it. }
                    @default {
                      @if (e.hasDocument) { This document is already in it. }
                      @else if (e.draftState === 'in_review') { Version {{ e.draftVersion }} is in review: it cannot be changed until it is approved or returned. }
                      @else { One land record per parcel: open it to add documents there, or correct the parcel above if it is a different one. }
                    }
                  }
                </span>
              </div>
            }

            <div class="docs-head">
              <h3>Other documents for this property</h3>
              @if (creating.documents().length) {
                <span class="small" [class.warn-text]="creating.mismatching().length">{{ creating.mismatching().length ? (creating.documents().length - creating.mismatching().length) + ' match · ' + creating.mismatching().length + " don't" : 'All ' + creating.documents().length + ' match' }}</span>
              }
            </div>
            <div class="docs" aria-live="polite">
              @for (d of creating.documents(); track d.edrmsDocumentId) {
                <div class="doc-row">
                  <b class="num">{{ d.ref || d.edrmsNo }}</b>
                  <span class="small muted ell" style="flex:1;min-width:0">{{ store.typeLabel(d.docType) }}{{ d.chosen ? ' (chosen)' : '' }} · “{{ d.property || '—' }}”</span>
                  <span class="tag" [class.tag-accent]="d.matches" [class.tag-outline]="!d.matches">{{ d.matches ? 'Matches' : "Doesn't match" }}</span>
                  <app-link-document-details [documentId]="d.edrmsDocumentId" [name]="d.ref || d.edrmsNo" [edrmsNo]="d.edrmsNo" [typeLabel]="store.typeLabel(d.docType)" [fields]="d.fields" [mismatch]="d.mismatch ?? null" />
                </div>
              } @empty {
                <div class="small muted" style="padding:10px 12px">{{ creating.previewing() ? 'Checking…' : 'No filed documents with this number yet.' }}</div>
              }
            </div>

            <div class="dialog-actions">
              @if (creating.existing()) {
                <button type="button" class="btn btn-secondary" (click)="creating.back()">Back</button>
                @if (creating.offer() === 'change' || creating.offer() === 'add') {
                  <button type="button" class="btn btn-secondary" (click)="creating.openExisting()">Open the record</button>
                  <button type="button" class="btn btn-primary" [disabled]="store.busy()" (click)="creating.changeWithDocument()">{{ creating.offer() === 'change' ? 'Open a change with this document' : 'Add to draft version ' + creating.existing()!.draftVersion }}</button>
                } @else {
                  <button type="button" class="btn btn-primary" (click)="creating.openExisting()">Open {{ creating.existing()!.recordNo }}</button>
                }
              } @else {
                <span class="small hint" [class.warn-text]="creating.missing().length || creating.mismatching().length">{{ hint() }}</span>
                <button type="button" class="btn btn-secondary" (click)="creating.byHand() ? store.createOpen.set(false) : creating.back()">{{ creating.byHand() ? 'Cancel' : 'Back' }}</button>
                <button type="submit" class="btn btn-primary" [disabled]="!creating.canCreate()">Create record</button>
              }
            </div>
          }
        </form>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .steps { display: flex; gap: 8px; align-items: center; margin: 2px 0 12px; }
    .stp { font-size: 12.5px; padding: 3px 10px; border-radius: 99px; background: var(--color-neutral-100); color: var(--color-neutral-700); }
    .stp.on { background: var(--color-accent); color: #fff; font-weight: 600; }
    .pick-row { grid-template-columns: minmax(0, 1fr) auto; padding: 4px 6px 4px 12px; }
    .pick { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: center; cursor: pointer; min-height: 44px; }
    .linkish { border: 0; background: transparent; padding: 0; font: inherit; color: var(--color-accent-700); text-decoration: underline; cursor: pointer; }
    form > .linkish { margin-top: 12px; align-self: flex-start; font-size: 14px; }
    .says { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: var(--color-neutral-100); font-size: 14.5px; }
    .up { text-transform: uppercase; letter-spacing: .04em; font-weight: 600; font-size: 11.5px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .help { display: flex; flex-direction: column; gap: 2px; }
    .help:empty { display: none; }
    .need, .warn-text { color: var(--warn-fg); font-weight: 600; }
    .input.warn { border-color: var(--warn-bd); box-shadow: 0 0 0 1px var(--warn-bd); }
    .existing { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
    .docs-head { display: flex; justify-content: space-between; align-items: baseline; margin-top: 16px; }
    .docs-head h3 { margin: 0; font-size: 14.5px; }
    .docs { margin-top: 6px; border: 1px solid var(--color-divider); border-radius: 8px; max-height: 220px; overflow-y: auto; }
    .doc-row { display: flex; gap: 10px; align-items: center; padding: 2px 6px 2px 12px; border-top: 1px solid var(--color-divider); }
    .doc-row:first-child { border-top: 0; }
    /* at least the width of a deed number, wider for a document named by its EDRMS number (API-778) */
    .doc-row b { min-width: 130px; flex: none; white-space: nowrap; }
    .hint { flex: 1 1 auto; margin-right: auto; }
    @media (max-width: 600px) { .doc-row b { min-width: 0; } }
  `,
  ],
})
export class LinkCreateDialogComponent {
  protected readonly store = inject(LinkStore);
  protected readonly creating = inject(LinkCreateFlow);
  protected readonly parcelLabel = parcelLabel;
  protected readonly linkedText = linkedText;
  protected readonly statusOf = statusOf;

  /** The document's registration division field, when it has one. */
  protected regDivOf(doc: FoundDocument): DocumentField | null {
    return doc.fields.find(f => f.k === 'regDiv' && f.v) ?? null;
  }

  protected versionText(e: {
    currentVersion: number | null;
    draftVersion: number | null;
    draftState: string | null;
  }): string {
    if (e.draftState === 'in_review') return `v${e.draftVersion} in review`;
    if (e.draftVersion && !e.currentVersion) {
      return `Draft v${e.draftVersion}, never approved`;
    }
    if (e.draftVersion) {
      return `v${e.currentVersion} current · draft v${e.draftVersion} open`;
    }
    return `v${e.currentVersion}, approved`;
  }

  /** Under the form, next to Create: what is still needed, or what creating does. */
  protected hint(): string {
    const c = this.creating;
    if (c.previewing()) return 'Checking the parcel…';
    const missing = c.missing();
    if (missing.length) {
      return `Fill in the ${missing.map(k => parcelLabel(k).toLowerCase()).join(', ')} to create the record.`;
    }
    if (c.mismatching().length) {
      return 'Correct the parcel, or create anyway: the record will show these documents as not matching.';
    }
    return c.picked()
      ? 'The document is added to the new draft.'
      : 'The record starts as an empty draft.';
  }
}
