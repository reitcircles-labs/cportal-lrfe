import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';

import {VersionRow} from './audit-record.types';
import {AUDIT_SHARED_STYLES} from './audit-shared.styles';

/** One land record's audit: the list of its versions, newest first; picking one shows it. */
@Component({
  selector: 'app-audit-versions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <h2 class="panel-title">Versions <span class="muted small">· newest first</span></h2>
      @for (v of versionRows(); track v.n) {
        <button type="button" class="ver" [class.on]="v.on" [attr.aria-pressed]="v.on" (click)="pickVersion(v.n)">
          <span class="stack" style="gap:0">
            <strong>v{{ v.n }}@if (v.n === current()) { <span class="muted"> · current</span> }</strong>
            <span class="small muted">{{ v.summary }}</span>
          </span>
          <span class="row" style="gap:8px">
            @if (v.proofLabel) { <span [class]="v.proofClass">{{ v.proofLabel }}</span> }
            <span [class]="v.stateClass">{{ v.state.label }}</span>
          </span>
        </button>
      }
    </section>
  `,
  styles: [
    AUDIT_SHARED_STYLES,
    `
    :host {
      display: contents;
    }
    .ver {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      width: 100%;
      text-align: left;
      cursor: pointer;
      font: inherit;
      color: inherit;
      background: var(--color-surface);
      min-height: 56px;
      padding: 8px 16px;
      border: 0;
      border-top: 1px solid var(--color-divider);
    }
    .ver.on {
      background: var(--color-accent-100);
      box-shadow: inset 3px 0 0 var(--color-accent);
    }
  `,
  ],
})
export class AuditVersionsComponent {
  readonly versionRows = input.required<VersionRow[]>();
  /** The current version of the land record. */
  readonly current = input.required<number>();
  /** A version was picked: its number. */
  readonly picked = output<number>();

  protected pickVersion(n: number): void {
    this.picked.emit(n);
  }
}
