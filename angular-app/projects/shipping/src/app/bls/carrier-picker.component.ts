import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

import {
  carrierOptionLabel,
  filterCarriers,
  isKnownCarrier,
  type CarrierOption,
} from './carrier-picker';

/**
 * Searchable dropdown for picking an SMDG carrier code (CB-68): pairs a filter input with a
 * `<select>` so free text is never accepted while any of the 373 SMDG codes can be found quickly
 * by code or company name.
 */
@Component({
  selector: 'app-carrier-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (disabled()) {
      <input
        [id]="inputId()"
        type="text"
        class="input mono"
        [value]="value()"
        disabled
        [attr.aria-describedby]="describedBy()" />
    } @else {
      <div class="picker">
        <input
          type="search"
          class="input"
          autocomplete="off"
          [attr.aria-label]="'Search ' + searchLabel()"
          [placeholder]="searchPlaceholder()"
          [value]="query()"
          (input)="query.set($any($event.target).value)" />
        <select
          [id]="inputId()"
          class="input"
          [value]="selectedValue()"
          [attr.aria-invalid]="invalid() ? 'true' : null"
          [attr.aria-describedby]="describedBy()"
          (change)="onPick($any($event.target).value)">
          <option value="">{{ emptyLabel() }}</option>
          @for (c of options(); track c.code) {
            <option [value]="c.code" [selected]="c.code === selectedValue()">{{ labelOf(c) }}</option>
          }
        </select>
        @if (query().trim() !== '') {
          <span class="small muted">{{ options().length }} matching {{ options().length === 1 ? 'carrier' : 'carriers' }}</span>
        }
      </div>
    }
  `,
  styles: `
    .picker { display: flex; flex-direction: column; gap: 6px; }
  `,
})
export class CarrierPickerComponent {
  readonly inputId = input.required<string>();
  readonly carriers = input.required<readonly CarrierOption[]>();
  readonly value = input<string>('');
  readonly disabled = input<boolean>(false);
  readonly invalid = input<boolean>(false);
  readonly describedBy = input<string | null>(null);
  readonly emptyLabel = input<string>('Pick a carrier code');
  readonly searchLabel = input<string>('carrier codes');
  readonly searchPlaceholder = input<string>('Search by code or carrier name…');

  readonly picked = output<string>();

  protected readonly query = signal('');
  protected readonly labelOf = carrierOptionLabel;

  protected readonly selectedValue = computed(() => {
    const code = this.value().trim().toUpperCase();
    return isKnownCarrier(code, this.carriers()) ? code : '';
  });

  protected readonly options = computed(() =>
    filterCarriers(this.carriers(), this.query(), this.selectedValue()),
  );

  /**
   * Emits the selected SMDG carrier code (or '' when cleared).
   * @param code the selected option value
   */
  protected onPick(code: string): void {
    this.picked.emit(code.trim().toUpperCase());
  }
}
