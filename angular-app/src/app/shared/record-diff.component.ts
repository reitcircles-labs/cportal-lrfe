import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { Diff } from '../api/records.api';

const FIELD_LABELS: Record<string, string> = {
  tenure: 'Tenure', 'extent.value': 'Extent', 'extent.unit': 'Extent unit',
  'parcel.number': 'Erf number', 'parcel.portion': 'Portion', 'parcel.township': 'Township', 'parcel.regDiv': 'Registration division', 'parcel.region': 'Region',
  'parcel.farmName': 'Farm name', 'parcel.farmNumber': 'Farm number', 'parcel.schemeName': 'Scheme name', 'parcel.schemeNumber': 'Scheme number', 'parcel.unit': 'Unit'
};

/**
 * What a land record version changes against the one before (GET /records/:id/review and
 * …/history): fields with before and after, owners, encumbrances and documents.
 */
@Component({
  selector: 'app-record-diff',
  template: `
    @if (diff(); as d) {
      @if (d.empty) { <div class="small muted">No changes.</div> }
      @else {
        @if (!d.against) { <div class="small muted" style="margin-bottom:6px">First version: everything is new.</div> }
        @if (d.fields.length) {
          <table class="table diff">
            <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
            <tbody>@for (f of d.fields; track f.path) { <tr><td class="small muted">{{ label(f.path) }}</td><td class="strike">{{ text(f.before) }}</td><td><b>{{ text(f.after) }}</b></td></tr> }</tbody>
          </table>
        }
        <ul class="chg">
          @for (o of d.owners.added; track o.name) { <li class="add"><span class="sr-only">Added: </span>Owner {{ o.name }} {{ o.share }}{{ o.idNo ? ' (' + o.idNo + ')' : '' }}</li> }
          @for (o of d.owners.removed; track o.name) { <li class="rem"><span class="sr-only">Removed: </span>Owner {{ o.name }} {{ o.share }}</li> }
          @for (o of d.owners.changed; track o.name) { <li class="mod"><span class="sr-only">Changed: </span>Owner {{ o.name }}: {{ ownerChange(o) }}</li> }
          @for (e of d.encumbrances.added; track e.ref) { <li class="add"><span class="sr-only">Added: </span>{{ e.type }} {{ e.ref }}{{ e.inFavourOf ? ' in favour of ' + e.inFavourOf : '' }}</li> }
          @for (e of d.encumbrances.removed; track e.ref) { <li class="rem"><span class="sr-only">Removed: </span>{{ e.type }} {{ e.ref }}</li> }
          @for (x of d.documents.added; track x.edrmsDocumentId) { <li class="add"><span class="sr-only">Added: </span>Document {{ x.ref || x.edrmsNo }} ({{ x.edrmsNo }} v{{ x.version }}.0)</li> }
          @for (x of d.documents.removed; track x.edrmsDocumentId) { <li class="rem"><span class="sr-only">Removed: </span>Document {{ x.ref || x.edrmsNo }} ({{ x.edrmsNo }})</li> }
          @for (x of d.documents.updated; track x.edrmsDocumentId) { <li class="mod"><span class="sr-only">Changed: </span>Document {{ x.ref || x.edrmsNo }}: v{{ x.fromVersion }}.0 → v{{ x.version }}.0</li> }
        </ul>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .diff { font-size: 13.5px; margin-bottom: 6px; }
    .strike { text-decoration: line-through; color: var(--color-neutral-600); }
    .chg { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13.5px; }
    .chg li::before { display: inline-block; width: 18px; font-weight: 700; }
    .chg .add::before { content: '+'; color: var(--success); }
    .chg .rem::before { content: '−'; color: var(--danger); }
    .chg .mod::before { content: '~'; color: var(--warn); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `]
})
export class RecordDiffComponent {
  diff = input<Diff | null>(null);
  label(path: string) { return FIELD_LABELS[path] || path.replace(/^attributes\./, ''); }
  text(v: any) { return v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
  ownerChange(o: { before: any; after: any }) {
    const parts = [];
    if (o.before.share !== o.after.share) parts.push(`share ${o.before.share} → ${o.after.share}`);
    if (o.before.idNo !== o.after.idNo) parts.push(`ID ${o.before.idNo ?? '—'} → ${o.after.idNo ?? '—'}`);
    return parts.join(', ');
  }
}
