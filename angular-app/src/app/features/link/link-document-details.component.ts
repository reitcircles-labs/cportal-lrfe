import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {ApiError} from '../../api/api.service';
import {DocumentField, Mismatch, RecordsApi} from '../../api/records.api';
import {ToastService} from '../../state/toast.service';
import {IconComponent} from '../../shared/icon.component';

/** The fields that link a document to a parcel and its chain of title, shown first. */
const LINKING = [
  'property',
  'regDiv',
  'deedNo',
  'sgNo',
  'bondNo',
  'sgRef',
  'priorTitle',
];

/**
 * A document's Details button and popover (API-765): its verified metadata, the fields that link
 * it to the parcel first, with the labels of the Documents screen; why it does not describe the
 * parcel, when it does not; and a link to the scan. With `pinned`, the values pinned in a record
 * version; otherwise the document's current values (`fields`, or read when it opens).
 */
@Component({
  selector: 'app-link-document-details',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button #trigger type="button" class="btn btn-ghost btn-icon" [class.on]="open()" [attr.aria-expanded]="open()"
            [attr.aria-label]="'Details of ' + name()" title="Details" (click)="toggle()"><app-icon name="info" [size]="17" /></button>
    @if (open()) {
      <div #panel class="pop" role="dialog" tabindex="-1" [attr.aria-label]="'Details of ' + name()"
           [style.top.px]="place().top" [style.bottom.px]="place().bottom" [style.right.px]="place().right" [style.max-height.px]="place().maxHeight"
           (keydown.escape)="close(true)">
        <div class="pop-head">
          <span class="stack" style="gap:2px;min-width:0"><b>{{ name() }}{{ typeLabel() ? ' · ' + typeLabel() : '' }}</b>
            <span class="small muted num">{{ edrmsNo() }}{{ version() ? ' · v' + version() + '.0, as in this record' : '' }}</span></span>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="Close" (click)="close(true)"><app-icon name="x" [size]="16" /></button>
        </div>
        @if (mismatch(); as m) {
          <div class="why">
            <b>Not this parcel</b>
            @if (m.missing.length) { <span>Its property doesn't name: {{ m.missing.join(', ') }}.</span> }
            @if (m.otherPortion) { <span>It names a portion that this parcel does not have.</span> }
          </div>
        }
        @if (failed()) {
          <div class="small muted" style="padding:12px 16px">The details could not be loaded.</div>
        } @else if (!rows().length) {
          <div class="small muted" style="padding:12px 16px">{{ loading() ? 'Loading…' : 'No metadata.' }}</div>
        } @else {
          <div class="grp">For linking</div>
          <dl class="kv">
            @for (f of linking(); track f.k) {
              <dt>{{ f.label }}</dt><dd [class.bad]="f.k === 'property' && !!mismatch()">{{ f.v }} @if (f.edited) { <span class="tag tag-outline">corrected</span> }</dd>
            } @empty { <dt>—</dt><dd class="muted">None of these fields</dd> }
          </dl>
          @if (others().length) {
            <div class="grp">Other fields</div>
            <dl class="kv">
              @for (f of others(); track f.k) {
                <dt>{{ f.label }}</dt><dd>{{ f.v }} @if (f.edited) { <span class="tag tag-outline">corrected</span> }</dd>
              }
            </dl>
          }
        }
        <div class="pop-foot"><button type="button" class="btn btn-ghost" (click)="openScan()"><app-icon name="eye" [size]="15" />Open the scan</button></div>
      </div>
    }
  `,
  styles: [
    `
    :host { display: inline-flex; }
    .on { background: var(--color-accent-100); color: var(--color-accent-700); }
    .pop { position: fixed; z-index: 60; width: min(440px, calc(100vw - 32px)); overflow-y: auto; text-align: left; white-space: normal;
           background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-divider); border-radius: 10px; box-shadow: var(--shadow-md); }
    .pop:focus { outline: none; }
    .pop-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; padding: 12px 12px 10px 16px; border-bottom: 1px solid var(--color-divider); }
    .why { display: flex; flex-direction: column; gap: 2px; margin: 12px 16px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
           background: var(--warn-bg); color: var(--warn-fg); border: 1px solid var(--warn-bd); }
    .grp { padding: 12px 16px 2px; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--color-neutral-600); }
    .kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 12px; margin: 0; padding: 4px 16px 0; font-size: 13.5px; }
    dt { color: var(--color-neutral-600); }
    dd { margin: 0; overflow-wrap: anywhere; }
    dd.bad { background: var(--warn-bg); border-radius: 4px; padding: 0 4px; margin-left: -4px; }
    .pop-foot { display: flex; justify-content: flex-end; padding: 10px 12px 12px; }
  `,
  ],
  // pointerdown, not click: the dialogs stop clicks from reaching the document
  host: {
    '(document:pointerdown)': 'outside($event)',
    '(focusout)': 'leave($event)',
    '(window:resize)': 'close(false)',
  },
})
export class LinkDocumentDetailsComponent {
  private records$ = inject(RecordsApi);
  private toast = inject(ToastService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly documentId = input.required<string>();
  /** The document's reference or EDRMS number, for its title and the screen reader. */
  readonly name = input.required<string>();
  readonly edrmsNo = input('');
  readonly typeLabel = input('');
  /** The version pinned in a record, and its field values; none: the document's current values. */
  readonly version = input<number | null>(null);
  readonly pinned = input<Record<string, string> | null>(null);
  /** The document's labelled fields when already known (search results, the create dialog). */
  readonly fields = input<DocumentField[] | null>(null);
  /** Why the document does not describe the parcel, when it does not. */
  readonly mismatch = input<Mismatch | null>(null);

  protected readonly open = signal(false);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  private readonly loaded = signal<DocumentField[] | null>(null);
  protected readonly place = signal<{
    top: number | null;
    bottom: number | null;
    right: number;
    maxHeight: number;
  }>({top: 0, bottom: null, right: 0, maxHeight: 400});
  private readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  /** The rows shown: pinned values with the document's labels, or its current fields. */
  protected readonly rows = computed<DocumentField[]>(() => {
    const known = this.fields() ?? this.loaded() ?? [];
    const pinned = this.pinned();
    if (!pinned) return known;
    const byKey = new Map(known.map(f => [f.k, f]));
    return Object.entries(pinned).map(([k, v]) => {
      const f = byKey.get(k);
      return {k, label: f?.label ?? k, v, edited: !!f?.edited && f.v === v};
    });
  });
  protected readonly linking = computed(() =>
    LINKING.map(k => this.rows().find(f => f.k === k)).filter(
      (f): f is DocumentField => !!f,
    ),
  );
  protected readonly others = computed(() =>
    this.rows().filter(f => !LINKING.includes(f.k)),
  );

  toggle() {
    if (this.open()) {
      this.close(false);
      return;
    }
    this.position();
    this.open.set(true);
    // it stays where it opened: scrolling the page or a list under it closes it
    document.addEventListener('scroll', this.onScroll, true);
    setTimeout(() => this.panel()?.nativeElement.focus());
    if (!this.fields() && !this.loaded()) this.load();
  }

  close(refocus: boolean) {
    if (!this.open()) return;
    this.open.set(false);
    document.removeEventListener('scroll', this.onScroll, true);
    if (refocus) this.trigger()?.nativeElement.focus();
  }

  /** Focus moved to something outside the button and the popover (Tab). */
  protected leave(event: FocusEvent) {
    const to = event.relatedTarget as Node | null;
    if (to && !this.host.nativeElement.contains(to)) this.close(false);
  }

  private readonly onScroll = (event: Event) => {
    if (!this.panel()?.nativeElement.contains(event.target as Node | null)) {
      this.close(false);
    }
  };

  protected outside(event: Event) {
    if (
      this.open() &&
      !this.host.nativeElement.contains(event.target as Node | null)
    ) {
      this.close(false);
    }
  }

  protected async openScan() {
    try {
      const {url} = await this.records$.contentLink(
        this.documentId(),
        this.version() ?? undefined,
      );
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      this.toast.show(
        'danger',
        'Could not open the document',
        e instanceof ApiError ? e.message : String(e),
      );
    }
  }

  private async load() {
    this.loading.set(true);
    this.failed.set(false);
    try {
      this.loaded.set(
        (await this.records$.documentDetails(this.documentId())).fields,
      );
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Under the button, right-aligned with it; above it when there is more room there. */
  private position() {
    const r = this.trigger()!.nativeElement.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const right = Math.max(16, window.innerWidth - r.right);
    this.place.set(
      below >= 320 || below >= above
        ? {top: r.bottom + 6, bottom: null, right, maxHeight: below}
        : {
            top: null,
            bottom: window.innerHeight - r.top + 6,
            right,
            maxHeight: above,
          },
    );
  }
}
