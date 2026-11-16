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
import {
  AMEND_FIELDS,
  type AmendField,
  type AmendForm,
  amendChanges,
  amendConfirmation,
  amendDone,
  amendFormOf,
  amendProblems,
  amendQuestion,
  amendRequest,
} from './bl-amend';
import {type Refusal, refusalOf} from './bl-change';
import {DRAFT_FORMAT} from './bl-draft';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {NO_PORTS, PortOptions, portLabel} from './bl-ports';

/**
 * The "Amend" panel of a B/L's page (CB-50, first version, from the CB-14 design): the carrier of
 * a B/L held for a change sees its current version and the next one side by side, the B/L number
 * and carrier code locked, changes the fields it may (bl-amend.ts) and sees each change marked,
 * the old value struck through and the new one highlighted; "Amend and give back", once
 * confirmed, commits the next version and gives the B/L back to the holder who asked. A refusal of
 * the record service is shown in the panel, with each problem it names; when the B/L moved on
 * since it was read, the page reads it again (`stale`).
 */
@Component({
  selector: 'app-bl-amend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-label="Amend">
      <div class="panel-head"><h2 tabindex="-1">Amend: version {{ version() }} to version {{ version() + 1 }}</h2></div>
      <div class="panel-body stack" style="gap:14px">
        <div class="grid">
          <div class="field">
            <label for="amend-reference">B/L number</label>
            <input id="amend-reference" class="input mono" [value]="recordNo()" disabled aria-describedby="amend-locked" />
          </div>
          <div class="field">
            <label for="amend-carrier">Carrier code</label>
            <input id="amend-carrier" class="input mono" [value]="carrierCode()" disabled aria-describedby="amend-locked" />
          </div>
        </div>
        <p id="amend-locked" class="small muted" style="margin:0">The B/L keeps its number and carrier code: the same B/L, a new version.</p>
        <table class="table amend-table">
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Version {{ version() }}</th><th scope="col">Version {{ version() + 1 }}</th></tr>
          </thead>
          <tbody>
            @for (f of fields; track f.key) {
              <tr [class.changed]="changed().has(f.key)">
                <th scope="row"><label [for]="'amend-' + f.key">{{ f.label }}</label></th>
                <td>
                  @if (changed().has(f.key)) {
                    <del>{{ before(f) }}</del>
                  } @else {
                    {{ before(f) }}
                  }
                </td>
                <td>
                  @if (f.kind === 'long') {
                    <textarea [id]="'amend-' + f.key" class="input" rows="2" [value]="form()[f.key]" (input)="set(f.key, $any($event.target).value)"></textarea>
                  } @else {
                    <input [id]="'amend-' + f.key" [type]="f.kind === 'date' ? 'date' : 'text'" [class]="f.kind === 'code' ? 'input mono' : 'input'" autocomplete="off" [value]="form()[f.key]" (input)="set(f.key, $any($event.target).value)" [attr.list]="isPort(f.key) ? 'amend-' + f.key + '-ports' : null" />
                    @if (isPort(f.key)) {
                      <datalist [id]="'amend-' + f.key + '-ports'">
                        @for (p of ports.options(f.key); track p.code) {
                          <option [value]="p.code">{{ portName(p) }}</option>
                        }
                      </datalist>
                      @if (ports.nameOf(form()[f.key]); as picked) {
                        <span class="small">{{ picked }}</span>
                      }
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
        <div role="status" aria-live="polite">
          @if (changes().length === 0) {
            <p class="muted" style="margin:0">No change yet.</p>
          } @else {
            <ul class="changes" aria-label="Changes">
              @for (c of changes(); track c.key) {
                <li>{{ c.label }}: <del>{{ c.before || '—' }}</del> → <ins>{{ c.after || '—' }}</ins></li>
              }
            </ul>
          }
        </div>
        @if (changes().length > 0 && problems().length > 0) {
          <ul class="problems" aria-label="Problems">
            @for (p of problems(); track $index) {
              <li>{{ p }}</li>
            }
          </ul>
        }
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
          <button type="button" class="btn btn-primary" [disabled]="busy() || problems().length > 0" (click)="send()">Amend and give back</button>
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
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .amend-table th[scope='row'] { font-weight: 600; white-space: nowrap; }
    .amend-table tr.changed td:nth-child(3) { background: var(--success-bg, #e6f4ea); }
    .amend-table tr.changed td:nth-child(3) .input { outline: 2px solid var(--color-accent, #2f6fde); }
    .changes, .problems { margin: 0; padding-left: 18px; }
    ins { background: var(--success-bg, #e6f4ea); text-decoration: none; padding: 0 2px; }
    del { color: var(--danger-fg); }
  `,
  ],
})
export class BlAmendComponent {
  /** The B/L's id, number and carrier code. */
  readonly recordId = input.required<string>();
  readonly recordNo = input.required<string>();
  readonly carrierCode = input.required<string>();
  /** The current version's number and its DCSA document. */
  readonly version = input.required<number>();
  readonly document = input.required<Record<string, unknown>>();
  /** The name of the holder the B/L goes back to. */
  readonly holderName = input.required<string>();

  /** The B/L is amended: the page reads it again and closes the panel. */
  readonly amended = output<void>();
  /**
   * A refusal says the B/L moved on: the page reads it again, and says why when the panel
   * closes (CB-54).
   */
  readonly stale = output<string>();
  /** The carrier closes the panel without amending. */
  readonly cancelled = output<void>();

  private readonly bls = inject(BlApi);
  /** The ports offered in the port fields (CB-63). */
  protected readonly ports = new PortOptions(
    query => this.bls.ports(query),
    signal(NO_PORTS),
  );
  protected readonly portName = portLabel;
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  protected readonly fields: readonly AmendField[] = AMEND_FIELDS;
  protected readonly form = signal<AmendForm>({});
  protected readonly busy = signal(false);
  protected readonly refusal = signal<Refusal | null>(null);

  protected readonly changes = computed(() =>
    amendChanges(this.document(), this.form()),
  );
  protected readonly changed = computed(
    () => new Set(this.changes().map(c => c.key)),
  );
  protected readonly problems = computed(() =>
    amendProblems(this.document(), this.form()),
  );

  constructor() {
    // the form starts again from each version the page reads
    effect(() => {
      const document = this.document();
      untracked(() => {
        this.form.set(amendFormOf(document));
      });
    });
  }

  /**
   * A field's value in the current version.
   * @param field the field
   * @return its value, a dash for none
   */
  protected before(field: AmendField): string {
    return amendFormOf(this.document())[field.key] || '—';
  }

  /**
   * Keeps a field as typed.
   * @param key the field's key
   * @param value as typed
   */
  protected set(key: string, value: string): void {
    this.form.update(form => ({...form, [key]: value}));
    if (this.isPort(key)) {
      void this.ports.search(key, value);
    }
  }

  /**
   * Whether a field names a port, offered from the port list (CB-63).
   * @param key the field
   * @return true for the ports of loading and discharge
   */
  protected isPort(key: string): boolean {
    return key === 'portOfLoading' || key === 'portOfDischarge';
  }

  /**
   * Amends the B/L once the carrier confirms what happens; a refusal is shown in the panel.
   * @return when it is done or refused
   */
  protected async send(): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: amendQuestion(this.recordNo()),
      body: amendConfirmation(
        this.version(),
        this.recordNo(),
        this.holderName(),
      ),
      confirmLabel: 'Amend',
    });
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    this.refusal.set(null);
    try {
      await this.bls.amend(
        this.recordId(),
        amendRequest(DRAFT_FORMAT, this.document(), this.form()),
      );
      this.toast.show(
        'success',
        amendDone(this.version(), this.holderName()),
        this.recordNo(),
      );
      this.amended.emit();
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
