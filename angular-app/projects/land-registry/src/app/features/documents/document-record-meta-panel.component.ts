import {
  Component,
  computed,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import {DocDetail} from './documents.types';

/** Documents: the ISO 23081 record metadata of the open document. */
@Component({
  selector: 'app-document-record-meta-panel',
  imports: [],
  template: `
    <div class="panel">
      <div class="panel-head"><h3>Record metadata</h3><span class="small muted">ISO 23081</span></div>
      <div class="panel-body"><div class="kv">
        @for (m of recordMeta(); track m.k) { <span>{{ m.k }}</span><span>{{ m.v }}</span> }
      </div></div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    :host { display: contents; }
  `,
  ],
})
export class DocumentRecordMetaPanelComponent {
  doc = input.required<DocDetail>();
  recordMeta = computed(() => {
    const m = this.doc().recordMetadata || {};
    return Object.entries(m).map(([k, v]) => ({
      k,
      // a list of agents shows as "role: name"; any other list item as JSON
      v: Array.isArray(v)
        ? v
            .map((x: {role?: string; name?: string}) =>
              x.name ? `${x.role}: ${x.name}` : JSON.stringify(x),
            )
            .join(', ')
        : String(v),
    }));
  });
}
