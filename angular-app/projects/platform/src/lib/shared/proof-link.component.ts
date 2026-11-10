import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {RouterLink} from '@angular/router';

/**
 * A proof status that names its batch and links to it (API-699, design API-688 board 4). A status
 * without a batch (Waiting for next batch) links to the Anchorings list, where the next batch time
 * is shown.
 *
 *   <app-proof-link label="Confirmed" tagClass="tag tag-accent" [batch]="1412" />          Confirmed in batch 1,412 →
 *   <app-proof-link label="Confirmed" tagClass="tag tag-accent" [batch]="1412" stacked />  Confirmed / batch 1,412
 */
@Component({
  selector: 'app-proof-link',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="proof" [class.stacked]="stacked()" [routerLink]="target()" [attr.aria-label]="ariaLabel()">
      <span [class]="tagClass()">{{ label() }}</span>
      <span class="where">{{ where() }}</span>
    </a>
  `,
  styles: [
    `
    .proof { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: 32px; text-decoration: none; }
    .proof.stacked { flex-direction: column; align-items: flex-start; gap: 2px; }
    .where { font-size: 13px; color: var(--color-accent-700); text-decoration: underline; }
    .stacked .where { font-size: 12px; }
  `,
  ],
})
export class ProofLinkComponent {
  /** The status in words, as the screen shows it. */
  readonly label = input.required<string>();
  /** The status's tag class. */
  readonly tagClass = input.required<string>();
  /** The batch the item is in; null or undefined while it waits for the next batch. */
  readonly batch = input<number | null | undefined>(null);
  /** The batch under the status instead of after it (table cells). */
  readonly stacked = input(false, {
    transform: (v: boolean | string) => v !== false,
  });

  protected readonly target = computed(() =>
    this.batch() ? ['/anchorings', this.batch()] : ['/anchorings'],
  );

  protected readonly where = computed(() => {
    const batch = this.batch();
    if (!batch) {
      return this.stacked() ? 'see when' : 'see when →';
    }
    const n = batch.toLocaleString('en');
    return this.stacked() ? `batch ${n}` : `in batch ${n} →`;
  });

  protected readonly ariaLabel = computed(() => {
    const batch = this.batch();
    return batch
      ? `${this.label()}, in batch ${batch.toLocaleString('en')}: open the batch`
      : `${this.label()}, see when: open the Anchorings list`;
  });
}
