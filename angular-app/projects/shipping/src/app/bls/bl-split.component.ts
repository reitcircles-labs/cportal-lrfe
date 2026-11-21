import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {ConfirmService, ToastService, toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {type Refusal, refusalOf} from './bl-change';
import {DRAFT_FORMAT} from './bl-draft';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {
  DEFAULT_MAX_SPLIT_PARTS,
  type SplitPart,
  addPart,
  cargoRows,
  firstParts,
  partLetter,
  partSummary,
  removeLastPart,
  rowAssigned,
  setPartCount,
  splitConfirmation,
  splitDone,
  splitLabel,
  splitProblems,
  splitQuestion,
  splitRequest,
} from './bl-split';

/** Which number of a share is typed. */
type ShareField = 'packages' | 'weight';

/**
 * The "Split" panel of a B/L's page (CB-50, first version, from the CB-14 design): the carrier of
 * a B/L held for a change sees the B/L's cargo, one row per cargo item with its container, seal,
 * packages and weight, and assigns it to new B/Ls (A and B, more with "Add a B/L"): each its own
 * number, its share of each row, its running total against the B/L's. "Split into N B/Ls" waits
 * until every row adds up, each new B/L carries cargo and has its own number (bl-split.ts); once
 * confirmed, the B/L is closed and the new B/Ls are issued to the holder who asked. A refusal of
 * the record service is shown in the panel; when the B/L moved on since it was read, the page
 * reads it again (`stale`).
 */
@Component({
  selector: 'app-bl-split',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-label="Split">
      <div class="panel-head"><h2 tabindex="-1">Split {{ recordNo() }} into new B/Ls</h2></div>
      <div class="panel-body stack" style="gap:14px">
        @if (changeReason(); as reason) {
          <div class="note info" role="note">
            <strong>Requested by {{ holderName() }}:</strong> {{ reason }}
          </div>
        }
        <p class="muted" style="margin:0">Give each new B/L its number and its share of the cargo. A container may be divided between them: its packages and weights must add up.</p>
        <div class="row" style="align-items:flex-end;gap:10px">
          <div class="field" style="max-width:180px">
            <label for="split-count">Number of new B/Ls</label>
            <input id="split-count" type="number" min="2" [max]="maxParts()" step="1" class="input num" [disabled]="busy()" [value]="parts().length" (change)="setCount($any($event.target))" />
          </div>
          <span class="small muted">Between 2 and {{ maxParts() }} new B/Ls.</span>
        </div>
        <div class="parts">
          @for (p of parts(); track $index; let i = $index) {
            <div class="field">
              <label [for]="'split-number-' + i">Number of B/L {{ letter(i) }}</label>
              <input [id]="'split-number-' + i" class="input mono" maxlength="20" autocomplete="off" [value]="p.reference" (input)="setReference(i, $any($event.target).value)" />
              <span class="small muted">{{ summary(p) }}</span>
            </div>
          }
        </div>
        <div style="overflow-x:auto">
          <table class="table" aria-label="Cargo">
            <thead>
              <tr>
                <th scope="col">Container</th>
                <th scope="col">Seal</th>
                <th scope="col">On the B/L</th>
                @for (p of parts(); track $index; let i = $index) {
                  <th scope="col">B/L {{ letter(i) }}</th>
                }
                <th scope="col">Assigned</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track $index; let r = $index) {
                <tr>
                  <td class="mono">{{ row.container }}</td>
                  <td class="mono">{{ row.seal || '—' }}</td>
                  <td class="num">{{ row.packages }} packages<br />{{ row.weight }} {{ row.unit }}</td>
                  @for (p of parts(); track $index; let i = $index) {
                    <td>
                      <div class="share">
                        <input type="number" min="0" step="1" class="input num" [attr.aria-label]="'B/L ' + letter(i) + ' packages of ' + row.container" [value]="p.shares[r].packages ?? ''" (input)="setShare(i, r, 'packages', $any($event.target).value)" />
                        <input type="number" min="0" class="input num" [attr.aria-label]="'B/L ' + letter(i) + ' weight of ' + row.container + ' (' + row.unit + ')'" [value]="p.shares[r].weight ?? ''" (input)="setShare(i, r, 'weight', $any($event.target).value)" />
                      </div>
                    </td>
                  }
                  <td class="num">{{ assigned(r).packages }} of {{ row.packages }}<br />{{ assigned(r).weight }} of {{ row.weight }} {{ row.unit }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div role="status" aria-live="polite">
          @if (problems().length > 0) {
            <ul class="problems" aria-label="Problems">
              @for (p of problems(); track $index) {
                <li>{{ p }}</li>
              }
            </ul>
          }
        </div>
        @if (refusal(); as r) {
          <div class="note danger" role="alert">
            {{ r.message }}
            @if (r.problems.length > 0) {
              <ul class="problems">
                @for (p of r.problems; track $index) {
                  <li>{{ p }}</li>
                }
              </ul>
            }
          </div>
        }
        <div class="row" style="gap:8px">
          <button type="button" class="btn btn-primary" [disabled]="busy() || problems().length > 0" (click)="send()">{{ label() }}</button>
          <button type="button" class="btn btn-secondary" [disabled]="busy() || parts().length >= maxParts()" (click)="add()">Add a B/L</button>
          <button type="button" class="btn btn-secondary" [disabled]="busy() || parts().length <= 2" (click)="shrink()">Remove last B/L</button>
          <button type="button" class="btn btn-secondary" [disabled]="busy()" (click)="cancelled.emit()">Cancel</button>
        </div>
      </div>
    </section>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .panel-head h2 { margin: 0; font-size: 18px; }
    .panel-body { padding: 16px; }
    .parts { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .share { display: grid; gap: 4px; min-width: 110px; }
    .problems { margin: 0; padding-left: 18px; color: var(--danger-fg); }
  `,
  ],
})
export class BlSplitComponent {
  /** The B/L's id and number. */
  readonly recordId = input.required<string>();
  readonly recordNo = input.required<string>();
  /** The current version's DCSA document. */
  readonly document = input.required<Record<string, unknown>>();
  /** The name of the holder the new B/Ls are issued to. */
  readonly holderName = input.required<string>();
  /** The holder's requested change reason, if given (CB-85). */
  readonly changeReason = input<string | null>(null);
  /** Maximum number of new B/Ls per split (CB-73, default 10). */
  readonly maxParts = input(DEFAULT_MAX_SPLIT_PARTS);

  /** The B/L is split: the page reads it again and closes the panel. */
  readonly split = output<void>();
  /**
   * A refusal says the B/L moved on: the page reads it again, and says why when the panel
   * closes (CB-54).
   */
  readonly stale = output<string>();
  /** The carrier closes the panel without splitting. */
  readonly cancelled = output<void>();

  private readonly bls = inject(BlApi);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  protected readonly rows = computed(() => cargoRows(this.document()));
  protected readonly parts = signal<SplitPart[]>([]);
  protected readonly busy = signal(false);
  protected readonly refusal = signal<Refusal | null>(null);

  protected readonly problems = computed(() =>
    splitProblems(this.rows(), this.parts(), this.recordNo(), this.maxParts()),
  );
  protected readonly label = computed(() => splitLabel(this.parts().length));

  constructor() {
    // the parts start again from each version the page reads
    effect(() => {
      const rows = this.rows();
      const recordNo = this.recordNo();
      untracked(() => {
        this.parts.set(firstParts(rows, recordNo));
      });
    });
  }

  /**
   * The letter of a part.
   * @param index its place
   * @return the letter
   */
  protected letter(index: number): string {
    return partLetter(index);
  }

  /**
   * A part's running total.
   * @param part the part
   * @return the text
   */
  protected summary(part: SplitPart): string {
    return partSummary(this.rows(), part);
  }

  /**
   * What the parts hold together of a cargo row.
   * @param row the row's place
   * @return its packages and weight
   */
  protected assigned(row: number): {packages: number; weight: number} {
    return rowAssigned(this.parts(), row);
  }

  /**
   * Keeps a part's number as typed; an earlier refusal no longer applies.
   * @param index the part's place
   * @param value as typed
   */
  protected setReference(index: number, value: string): void {
    this.refusal.set(null);
    this.parts.update(parts =>
      parts.map((part, i) =>
        i === index ? {...part, reference: value} : part,
      ),
    );
  }

  /**
   * Keeps a part's share of a cargo row as typed; an empty field is null.
   * @param index the part's place
   * @param row the row's place
   * @param field packages or weight
   * @param value as typed
   */
  protected setShare(
    index: number,
    row: number,
    field: ShareField,
    value: string,
  ): void {
    const number = value.trim() === '' ? null : Number(value);
    this.refusal.set(null);
    this.parts.update(parts =>
      parts.map((part, i) => {
        if (i !== index) {
          return part;
        }
        const shares = part.shares.map((share, r) =>
          r === row ? {...share, [field]: number} : share,
        );
        return {...part, shares};
      }),
    );
  }

  /** Adds an empty part ("Add a B/L"). */
  protected add(): void {
    this.refusal.set(null);
    this.parts.update(parts =>
      addPart(parts, this.rows(), this.recordNo(), this.maxParts()),
    );
  }

  /** Drops the last part with all its entries (CB-73). */
  protected shrink(): void {
    this.refusal.set(null);
    this.parts.update(parts => removeLastPart(parts));
  }

  /**
   * Sets the number of output B/Ls directly (CB-73); shrinking drops the last parts.
   * Restores the input value when blank, non-numeric, or clamped.
   * @param input count field element
   */
  protected setCount(input: HTMLInputElement): void {
    const trimmed = input.value.trim();
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      input.value = String(this.parts().length);
      return;
    }
    this.refusal.set(null);
    this.parts.update(parts =>
      setPartCount(
        parts,
        parsed,
        this.rows(),
        this.recordNo(),
        this.maxParts(),
      ),
    );
    input.value = String(this.parts().length);
  }

  /**
   * Splits the B/L once the carrier confirms what happens; a refusal is shown in the panel.
   * @return when it is done or refused
   */
  protected async send(): Promise<void> {
    const count = this.parts().length;
    const confirmed = await this.confirm.ask({
      title: splitQuestion(this.recordNo(), count),
      body: splitConfirmation(this.recordNo(), count, this.holderName()),
      confirmLabel: 'Split',
    });
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    this.refusal.set(null);
    try {
      await this.bls.split(
        this.recordId(),
        splitRequest(DRAFT_FORMAT, this.document(), this.rows(), this.parts()),
      );
      this.toast.show('success', splitDone(count), this.recordNo());
      this.split.emit();
    } catch (e) {
      const refusal = refusalOf(toApiError(e));
      this.refusal.set(refusal);
      if (refusal.reload) {
        this.stale.emit(refusal.message);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
