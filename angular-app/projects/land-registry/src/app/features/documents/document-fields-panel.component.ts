import {Component, input, ChangeDetectionStrategy} from '@angular/core';
import {DocDetail} from './documents.types';

/** Documents: the verified metadata of the open document. */
@Component({
  selector: 'app-document-fields-panel',
  imports: [],
  template: `
    @let d = doc();
    <section class="panel">
      <div class="panel-head"><h3>Verified metadata</h3><span class="small muted">{{ d.fields.length }} fields</span></div>
      <table class="table" style="font-size:13.5px">
        <tbody>
          @for (f of d.fields; track f.k) {
            <tr><td class="small muted" style="width:40%">{{ f.label }}</td><td>{{ f.v }} @if (f.edited) { <span class="tag tag-outline" style="margin-left:6px">corrected</span> }</td></tr>
          }
        </tbody>
      </table>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
  `,
  ],
})
export class DocumentFieldsPanelComponent {
  doc = input.required<DocDetail>();
}
