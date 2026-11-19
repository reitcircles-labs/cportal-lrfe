import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import {NgTemplateOutlet} from '@angular/common';
import {Router, RouterLink} from '@angular/router';
import {AuthService, ToastService, toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {mayEdit} from './bl-actions';
import {
  applyPaperReading,
  draftFormOf,
  draftProblems,
  draftRequest,
  emptyDraftForm,
  problemMessages,
  type DraftForm,
  type DraftProblem,
} from './bl-draft';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {NO_PORTS, PortOptions, portLabel} from './bl-ports';
import type {PartyOrganisation} from './bl.model';
import {injectViewer} from './viewer';

/** A text, date or number field of the form, as the template draws it. */
interface FieldSpec {
  field: keyof DraftForm;
  label: string;
  type: 'text' | 'date' | 'number';
  /** Codes and numbers in a fixed-width font. */
  mono?: boolean;
  maxlength?: number;
  hint?: string;
  /** A port: offered from the port list as it is typed (CB-63). */
  port?: boolean;
  /** Locked once the B/L is created: number and carrier code (CB-70). */
  lockInEdit?: boolean;
}

/** The fields of each section, in order. */
const BL_FIELDS: readonly FieldSpec[] = [
  {
    field: 'reference',
    label: 'B/L number',
    type: 'text',
    mono: true,
    maxlength: 20,
    lockInEdit: true,
  },
  {
    field: 'carrierCode',
    label: 'Carrier code',
    type: 'text',
    mono: true,
    maxlength: 4,
    hint: 'The SMDG code of the carrier, e.g. ABCD.',
    lockInEdit: true,
  },
  {
    field: 'bookingReference',
    label: 'Booking reference',
    type: 'text',
    mono: true,
    maxlength: 35,
  },
];
const ISSUE_FIELDS: readonly FieldSpec[] = [
  {field: 'issuerStreet', label: 'Street', type: 'text', maxlength: 100},
  {field: 'issuerCity', label: 'City', type: 'text', maxlength: 35},
  {
    field: 'issuerCountry',
    label: 'Country code',
    type: 'text',
    mono: true,
    maxlength: 2,
    hint: 'Two letters (ISO 3166).',
  },
];
const VOYAGE_FIELDS: readonly FieldSpec[] = [
  {field: 'vesselName', label: 'Vessel', type: 'text', maxlength: 50},
  {
    field: 'voyageNumber',
    label: 'Voyage',
    type: 'text',
    mono: true,
    maxlength: 50,
  },
  {
    field: 'portOfLoading',
    label: 'Port of loading',
    type: 'text',
    mono: true,
    maxlength: 5,
    hint: 'Type a port name or its UN/LOCODE, e.g. Rotterdam or NLRTM.',
    port: true,
  },
  {
    field: 'portOfDischarge',
    label: 'Port of discharge',
    type: 'text',
    mono: true,
    maxlength: 5,
    hint: 'Type a port name or its UN/LOCODE, e.g. Rotterdam or NLRTM.',
    port: true,
  },
  {field: 'departureDate', label: 'Planned departure', type: 'date'},
  {field: 'arrivalDate', label: 'Planned arrival', type: 'date'},
];
const CARGO_FIELDS: readonly FieldSpec[] = [
  {
    field: 'containerNumber',
    label: 'Container number',
    type: 'text',
    mono: true,
    maxlength: 11,
  },
  {
    field: 'isoEquipmentCode',
    label: 'Container type',
    type: 'text',
    mono: true,
    maxlength: 4,
    hint: 'ISO size and type code, e.g. 22G1.',
  },
  {
    field: 'sealNumber',
    label: 'Seal number',
    type: 'text',
    mono: true,
    maxlength: 15,
  },
  {field: 'goods', label: 'Goods', type: 'text', maxlength: 5000},
  {field: 'hsCode', label: 'HS code', type: 'text', mono: true, maxlength: 10},
  {field: 'packages', label: 'Number of packages', type: 'number'},
  {
    field: 'packageDescription',
    label: 'Kind of packages',
    type: 'text',
    maxlength: 50,
  },
  {field: 'grossWeightKg', label: 'Gross weight (kg)', type: 'number'},
];

/**
 * A new B/L of the user's organisation, as a draft (`#/bls/new`, CB-44, from the CB-11 design):
 * the good-weather fields of one container's B/L, the shipper and the consignee picked from the
 * organisations registered on the platform. Saved, it opens its page, where it is submitted for
 * approval. The record service checks the document and names every problem.
 */
@Component({
  selector: 'app-bl-new',
  imports: [NgTemplateOutlet, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack" style="gap:18px">
      <a class="small" [routerLink]="backLink()">{{ isEdit() ? '← Back to B/L' : '← Bills of lading' }}</a>
      <header>
        <h1 style="margin:4px 0 4px;font-size:32px">{{ isEdit() ? 'Edit draft B/L' : 'New B/L' }}</h1>
        <p class="muted" style="margin:0">{{ isEdit() ? 'Edit this draft of ' + carrierName() + '. The B/L number and carrier code stay fixed.' : 'A draft of ' + carrierName() + '. A second person approves it before it is issued.' }}</p>
      </header>
      @if (loadError(); as e) {
        <div class="note danger" role="alert">{{ e }}</div>
      }
      @if (ready()) {
        @if (!isEdit()) {
          <section class="panel" aria-label="Read from paper B/L">
            <div class="panel-head"><h2>Read from paper B/L</h2></div>
            <div class="panel-body stack" style="gap:10px">
              <p class="small muted" style="margin:0">Upload a scanned paper B/L (PDF or image). An automatic check fills in the draft fields below for you to review and confirm before saving.</p>
              <div class="row" style="gap:10px;align-items:center">
                <label class="sr-only" for="paper-bl-file">Scanned paper B/L</label>
                <input id="paper-bl-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" (change)="pickPaper($any($event.target).files?.[0] ?? null)">
                <button type="button" class="btn btn-secondary" [disabled]="!selectedPaper() || readingPaper() || saving()" (click)="readPaper()">{{ readingPaper() ? 'Automatic check reading…' : 'Read paper B/L' }}</button>
              </div>
              @if (paperError(); as pe) {
                <div class="note danger" role="alert">{{ pe }}</div>
              }
              @if (paperSummary(); as summary) {
                <div class="note paper-note" role="status">
                  {{ summary }}
                  @if (paperWarnings().length > 0) {
                    <ul class="problems">
                      @for (w of paperWarnings(); track $index) {
                        <li>{{ w }}</li>
                      }
                    </ul>
                  }
                </div>
              }
            </div>
          </section>
        }
        <form class="stack" style="gap:18px" (submit)="$event.preventDefault(); save()" novalidate>
        <section class="panel">
          <div class="panel-head"><h2>B/L</h2></div>
          <div class="panel-body grid">
            @for (f of blFields; track f.field) {
              <ng-container *ngTemplateOutlet="input; context: {$implicit: f}" />
            }
            <fieldset class="field to-order">
              <legend>To order</legend>
              <div class="seg">
                <label class="seg-opt"><input type="radio" name="to-order" [checked]="form().toOrder" (change)="setToOrder(true)">Yes, negotiable</label>
                <label class="seg-opt"><input type="radio" name="to-order" [checked]="!form().toOrder" (change)="setToOrder(false)">No, to a named consignee</label>
              </div>
            </fieldset>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Parties</h2></div>
          <div class="panel-body grid">
            <div class="field" [class.uncertain]="isUncertain('shipperId')">
              <label for="bl-shipperId">
                Shipper
                @if (isUncertain('shipperId')) {
                  <span class="check-badge">Check value</span>
                }
              </label>
              <select id="bl-shipperId" class="input" [value]="form().shipperId" (change)="setText('shipperId', $any($event.target).value)" [attr.aria-invalid]="isInvalid('shipperId') ? 'true' : null">
                <option value="">Pick an organisation</option>
                @for (o of organisations(); track o.id) {
                  <option [value]="o.id" [selected]="o.id === form().shipperId">{{ o.name }}</option>
                }
              </select>
              <span class="small muted">The first holder of the B/L.</span>
            </div>
            @if (!form().toOrder) {
              <div class="field" [class.uncertain]="isUncertain('consigneeId')">
                <label for="bl-consigneeId">
                  Consignee
                  @if (isUncertain('consigneeId')) {
                    <span class="check-badge">Check value</span>
                  }
                </label>
                <select id="bl-consigneeId" class="input" [value]="form().consigneeId" (change)="setText('consigneeId', $any($event.target).value)" [attr.aria-invalid]="isInvalid('consigneeId') ? 'true' : null">
                  <option value="">Pick an organisation</option>
                  @for (o of organisations(); track o.id) {
                    <option [value]="o.id" [selected]="o.id === form().consigneeId">{{ o.name }}</option>
                  }
                </select>
              </div>
            }
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Place of issue</h2></div>
          <div class="panel-body grid">
            @for (f of issueFields; track f.field) {
              <ng-container *ngTemplateOutlet="input; context: {$implicit: f}" />
            }
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Voyage</h2></div>
          <div class="panel-body grid">
            @for (f of voyageFields; track f.field) {
              <ng-container *ngTemplateOutlet="input; context: {$implicit: f}" />
            }
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Container and cargo</h2></div>
          <div class="panel-body grid">
            @for (f of cargoFields; track f.field) {
              <ng-container *ngTemplateOutlet="input; context: {$implicit: f}" />
            }
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Terms and conditions</h2></div>
          <div class="panel-body">
            <div class="field" [class.uncertain]="isUncertain('termsAndConditions')">
              <label for="bl-terms">
                The carrier's terms
                @if (isUncertain('termsAndConditions')) {
                  <span class="check-badge">Check value</span>
                }
              </label>
              <textarea id="bl-terms" class="input" rows="3" [value]="form().termsAndConditions" (input)="setText('termsAndConditions', $any($event.target).value)" [attr.aria-invalid]="isInvalid('termsAndConditions') ? 'true' : null"></textarea>
            </div>
          </div>
        </section>
        @if (problems().length > 0) {
          <div class="note danger" role="alert">
            <strong>{{ problemTitle() }}</strong>
            <ul class="problems">
              @for (p of problems(); track $index) {
                <li>{{ p }}</li>
              }
            </ul>
          </div>
        }
        <div class="row" style="gap:10px;justify-content:flex-end">
          <a class="btn btn-secondary" [routerLink]="backLink()">Cancel</a>
          <button type="submit" class="btn btn-primary" [disabled]="saving()">{{ submitLabel() }}</button>
        </div>
        </form>
      }
    </div>
    <ng-template #input let-f>
      <div class="field" [class.uncertain]="isUncertain(f.field)">
        <label [for]="'bl-' + f.field">
          {{ f.label }}
          @if (isUncertain(f.field)) {
            <span class="check-badge">Check value</span>
          }
        </label>
        <input [id]="'bl-' + f.field" [type]="f.type" [class]="f.mono ? 'input mono' : 'input'" autocomplete="off" [attr.maxlength]="f.maxlength ?? null" [attr.min]="f.type === 'number' ? 0 : null" [disabled]="isEdit() && !!f.lockInEdit" [value]="valueOf(f.field)" (input)="setFrom(f, $any($event.target).value)" [attr.aria-invalid]="isInvalid(f.field) ? 'true' : null" [attr.aria-describedby]="f.hint ? 'bl-' + f.field + '-hint' : null" [attr.list]="f.port ? 'bl-' + f.field + '-ports' : null">
        @if (f.port) {
          <datalist [id]="'bl-' + f.field + '-ports'">
            @for (p of ports.options(f.field); track p.code) {
              <option [value]="p.code">{{ portName(p) }}</option>
            }
          </datalist>
          @if (ports.nameOf(valueOf(f.field)); as picked) {
            <span class="small" [attr.data-testid]="'bl-' + f.field + '-name'">{{ picked }}</span>
          }
        }
        @if (f.hint) {
          <span class="small muted" [id]="'bl-' + f.field + '-hint'">{{ f.hint }}</span>
        }
      </div>
    </ng-template>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .panel-head h2 { margin: 0; font-size: 18px; }
    .panel-body { padding: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; align-items: start; }
    .field { display: flex; flex-direction: column; gap: 4px; margin: 0; }
    fieldset.field { border: 0; padding: 0; }
    fieldset.field legend { font-size: 13px; font-weight: 600; margin-bottom: 4px; padding: 0; }
    .to-order { grid-column: 1 / -1; }
    .problems { margin: 6px 0 0; padding-left: 18px; }
    .field.uncertain .input { border-color: #d97706; background: #fffbeb; }
    .check-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; background: #fef3c7; color: #92400e; }
    .paper-note { background: #fffbeb; border: 1px solid #f59e0b; color: #78350f; }
  `,
  ],
})
export class BlNewComponent {
  /** Present when editing an existing draft (`/bls/:id/edit`, CB-70). */
  readonly id = input<string>();

  private readonly bls = inject(BlApi);
  /** The ports offered in the port fields (CB-63). */
  protected readonly ports = new PortOptions(
    query => this.bls.ports(query),
    signal(NO_PORTS),
  );
  protected readonly portName = portLabel;
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly viewer = injectViewer();

  protected readonly blFields = BL_FIELDS;
  protected readonly issueFields = ISSUE_FIELDS;
  protected readonly voyageFields = VOYAGE_FIELDS;
  protected readonly cargoFields = CARGO_FIELDS;

  protected readonly isEdit = computed(() => Boolean(this.id()));
  protected readonly backLink = computed(() => {
    const id = this.id();
    return id ? ['/bls', id] : ['/'];
  });
  protected readonly form = signal<DraftForm>(emptyDraftForm());
  protected readonly organisations = signal<PartyOrganisation[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly ready = signal(true);
  protected readonly saving = signal(false);
  protected readonly selectedPaper = signal<File | null>(null);
  protected readonly readingPaper = signal(false);
  protected readonly paperSummary = signal<string | null>(null);
  protected readonly paperWarnings = signal<string[]>([]);
  protected readonly paperError = signal<string | null>(null);
  private readonly uncertainFields = signal<Set<keyof DraftForm>>(new Set());
  private readonly draftRevision = signal<number | undefined>(undefined);
  /** The form's own problems, shown once it was sent. */
  private readonly formProblems = signal<DraftProblem[]>([]);
  /** The record service's refusal: its message and the problems it names. */
  private readonly refusal = signal<string[]>([]);

  protected readonly carrierName = computed(() => this.viewer().organisation);
  protected readonly problems = computed(() => {
    const own = this.formProblems().map(p => p.message);
    return own.length > 0 ? own : this.refusal();
  });
  protected readonly problemTitle = computed(() => {
    if (this.formProblems().length > 0) {
      return 'The draft cannot be saved yet:';
    }
    return 'The B/L was not saved:';
  });
  protected readonly submitLabel = computed(() => {
    if (this.saving()) {
      return 'Saving…';
    }
    return this.isEdit() ? 'Save changes' : 'Save draft';
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        void this.load(id);
      });
    });
  }

  /**
   * A field's value, for its input.
   * @param field the field
   * @return its text
   */
  protected valueOf(field: keyof DraftForm): string {
    const value = this.form()[field];
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  }

  /**
   * Whether a field has a problem, marked for screen readers.
   * @param field the field
   * @return true when it has one
   */
  protected isInvalid(field: keyof DraftForm): boolean {
    return this.formProblems().some(p => p.field === field);
  }

  /**
   * Whether the automatic paper B/L reader marked this field for review (CB-57).
   * @param field the field
   * @return true when highlighted for confirmation
   */
  protected isUncertain(field: keyof DraftForm): boolean {
    return this.uncertainFields().has(field);
  }

  /**
   * Remembers the chosen paper B/L scan file (CB-57).
   * @param file chosen file or null
   */
  protected pickPaper(file: File | null): void {
    this.selectedPaper.set(file);
    this.paperError.set(null);
  }

  /**
   * Sends the chosen paper B/L scan for automatic reading and fills the draft fields without
   * saving (CB-57).
   * @return when fields are filled
   */
  protected async readPaper(): Promise<void> {
    const file = this.selectedPaper();
    if (!file) {
      return;
    }
    this.readingPaper.set(true);
    this.paperError.set(null);
    this.paperSummary.set(null);
    this.paperWarnings.set([]);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const contentBase64 = btoa(binary);
      const mimeType = file.type || 'application/pdf';
      const reading = await this.bls.readPaper(
        file.name,
        mimeType,
        contentBase64,
      );
      const {form, uncertainFields} = applyPaperReading(
        this.form(),
        reading,
        this.organisations(),
      );
      this.form.set(form);
      this.uncertainFields.set(uncertainFields);
      this.paperSummary.set(reading.summary);
      this.paperWarnings.set(reading.warnings);
      if (form.portOfLoading) {
        void this.ports.search('portOfLoading', form.portOfLoading);
      }
      if (form.portOfDischarge) {
        void this.ports.search('portOfDischarge', form.portOfDischarge);
      }
      this.toast.show('info', 'Paper B/L read', 'Review highlighted fields');
    } catch (e) {
      this.paperError.set(toApiError(e).message);
    } finally {
      this.readingPaper.set(false);
    }
  }

  /**
   * Sets a text field and clears any uncertain highlight once edited.
   * @param field the field
   * @param value its new text
   */
  protected setText(field: keyof DraftForm, value: string): void {
    this.form.update(form => ({...form, [field]: value}));
    this.clearUncertain(field);
  }

  /**
   * Clears the uncertain highlight when a person edits or confirms a field (CB-57).
   * @param field the field
   */
  private clearUncertain(field: keyof DraftForm): void {
    if (!this.uncertainFields().has(field)) {
      return;
    }
    this.uncertainFields.update(prev => {
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }

  /**
   * Sets a field from its input: a number field gets a number, or null when empty.
   * @param spec the field
   * @param value the input's text
   */
  protected setFrom(spec: FieldSpec, value: string): void {
    if (spec.port) {
      void this.ports.search(spec.field, value);
    }
    if (spec.type !== 'number') {
      this.setText(spec.field, value);
      return;
    }
    const trimmed = value.trim();
    const number = trimmed === '' ? null : Number(trimmed);
    this.form.update(form => ({...form, [spec.field]: number}));
    this.clearUncertain(spec.field);
  }

  /**
   * Sets whether the B/L is to order.
   * @param toOrder true for a B/L to order
   */
  protected setToOrder(toOrder: boolean): void {
    this.form.update(form => ({...form, toOrder}));
  }

  /**
   * Saves the draft and opens its page; the form's problems, or the record service's, are shown
   * otherwise.
   * @return when it is done
   */
  protected async save(): Promise<void> {
    const form = this.form();
    this.formProblems.set(draftProblems(form, this.organisations()));
    this.refusal.set([]);
    if (this.formProblems().length > 0) {
      return;
    }
    const user = this.auth.me()?.user;
    const request = draftRequest(form, {
      carrierName: this.carrierName(),
      contact: {name: user?.name ?? '', email: user?.email ?? ''},
      organisations: this.organisations(),
    });
    this.saving.set(true);
    try {
      const editId = this.id();
      if (editId) {
        const record = await this.bls.saveDraft(editId, {
          ...request,
          revision: this.draftRevision(),
        });
        this.toast.show('success', 'Draft updated', `B/L ${record.recordNo}`);
        await this.router.navigate(['/bls', record.id]);
      } else {
        const record = await this.bls.create(request);
        this.toast.show('success', 'Draft saved', `B/L ${record.recordNo}`);
        await this.router.navigate(['/bls', record.id]);
      }
    } catch (e) {
      const error = toApiError(e);
      this.refusal.set([error.message, ...problemMessages(error.details)]);
    }
    this.saving.set(false);
  }

  /**
   * Loads the organisations and, when editing, the draft's current values (CB-70).
   * @param id the B/L's id when editing, undefined for a new B/L
   * @return when ready
   */
  private async load(id?: string): Promise<void> {
    this.loadError.set(null);
    this.formProblems.set([]);
    this.refusal.set([]);
    if (!id) {
      this.ready.set(true);
      this.form.set(emptyDraftForm());
      this.draftRevision.set(undefined);
      try {
        this.organisations.set(await this.bls.organisations());
      } catch (e) {
        this.loadError.set(toApiError(e).message);
      }
      return;
    }
    this.ready.set(false);
    try {
      const [organisations, record] = await Promise.all([
        this.bls.organisations(),
        this.bls.record(id),
      ]);
      this.organisations.set(organisations);
      const user = {
        id: this.auth.me()?.user.id ?? '',
        perms: this.auth.perms(),
      };
      if (record.status === 'archived') {
        this.loadError.set(
          'This B/L is archived and can no longer be changed.',
        );
        return;
      }
      if (!mayEdit(record.draft, user)) {
        this.loadError.set(
          record.draft === null
            ? 'This B/L can no longer be edited.'
            : 'Only the person who created this draft may edit it.',
        );
        return;
      }
      const hydrated = draftFormOf(record.draft);
      this.form.set(hydrated);
      this.draftRevision.set(record.draft?.revision);
      this.ready.set(true);
      void this.ports.search('portOfLoading', hydrated.portOfLoading);
      void this.ports.search('portOfDischarge', hydrated.portOfDischarge);
    } catch (e) {
      this.loadError.set(toApiError(e).message);
    }
  }
}
