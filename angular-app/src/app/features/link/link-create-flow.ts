import {Injectable, computed, inject, signal} from '@angular/core';
import {Router} from '@angular/router';
import {ApiError} from '../../api/api.service';
import {
  CreatePreview,
  FoundDocument,
  LandRecord,
  Parcel,
  RecordsApi,
} from '../../api/records.api';
import {ToastService} from '../../state/toast.service';
import {LinkStore} from './link.store';

/** The words of a value as the parcel check compares them (the backend's normalizeSearch). */
const wordsOf = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Land records: creating a record (API-765). One dialog: pick the filed document to start from;
 * its parcel is filled in, checked against the other documents for the property, and can be
 * corrected before the record is created. A parcel that already has a record offers that record
 * instead, or a change of it with the document. A parcel without a document is entered by hand.
 */
@Injectable()
export class LinkCreateFlow {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);
  private toast = inject(ToastService);
  private router = inject(Router);

  readonly step = signal<'document' | 'parcel'>('document');
  readonly q = signal('');
  readonly found = signal<FoundDocument[]>([]);
  readonly searching = signal(false);
  readonly picked = signal<FoundDocument | null>(null);
  /** No document: the parcel entered by hand. */
  readonly byHand = signal(false);
  /** The parcel's fields as the form holds them. */
  readonly form = signal<Record<string, string>>({});
  readonly preview = signal<CreatePreview | null>(null);
  readonly previewing = signal(false);
  /** The last check failed: creating is still possible, the backend checks again. */
  readonly previewFailed = signal(false);
  /** The parcel as read from the picked document, when it could be read. */
  readonly read = signal<Parcel | null>(null);
  private previewSeq = 0;

  kindFields = computed(() => {
    const k = this.store.kinds().find(x => x.id === this.store.ckind());
    if (!k) return [];
    const p = k.schema.properties.parcel;
    return Object.keys(p.properties)
      .filter(f => f !== 'kind')
      .map(f => ({k: f, required: (p.required || []).includes(f)}));
  });

  /** The parcel as filled in. */
  parcel = computed<Parcel>(() => {
    const parcel: Parcel = {kind: this.store.ckind()};
    for (const f of this.kindFields()) {
      const v = (this.form()[f.k] || '').trim();
      if (v) parcel[f.k] = f.k === 'participationQuota' ? Number(v) : v;
    }
    return parcel;
  });
  /** The required fields still empty. */
  missing = computed(() =>
    this.kindFields()
      .filter(f => f.required && !(this.form()[f.k] || '').trim())
      .map(f => f.k),
  );
  documents = computed(() => this.preview()?.documents ?? []);
  mismatching = computed(() => this.documents().filter(d => !d.matches));
  existing = computed(() => this.preview()?.existing ?? null);

  canCreate = computed(
    () =>
      !this.store.busy() &&
      !this.previewing() &&
      (!!this.preview() || this.previewFailed()) &&
      !this.missing().length &&
      !this.existing(),
  );

  /** What the existing record offers for the chosen document: a change, its open draft, or only opening it. */
  offer = computed<'change' | 'add' | 'open' | null>(() => {
    const e = this.existing();
    if (!e) return null;
    if (!this.picked() || e.hasDocument || e.draftState === 'in_review') {
      return 'open';
    }
    return e.draftVersion ? 'add' : 'change';
  });

  /** A field's value as the document gave it, when the officer changed it; null otherwise. */
  readValue(k: string): string | null {
    const read = this.read();
    if (!read || this.byHand()) return null;
    const was = read[k] === undefined ? '' : String(read[k]);
    return was !== (this.form()[k] || '').trim() ? was : null;
  }

  /** How many documents for the property do not name the words of this field. */
  notNamedBy(k: string): number {
    const words = new Set(wordsOf(this.form()[k] || ''));
    return this.mismatching().filter(d =>
      (d.mismatch?.missing ?? []).some(w => words.has(w)),
    ).length;
  }

  openCreate() {
    this.step.set('document');
    this.q.set('');
    this.found.set([]);
    this.picked.set(null);
    this.byHand.set(false);
    this.form.set({});
    this.clearCheck();
    if (!this.store.kinds().length) {
      this.records$
        .catalogue()
        .then(c => this.store.kinds.set(c.parcelKinds))
        .catch(e => this.store.fail('Could not load parcel kinds', e));
    }
    this.store.createOpen.set(true);
  }

  searchCreate(v: string) {
    this.q.set(v);
    this.store.debounce('create', async () => {
      const q = this.q().trim();
      this.searching.set(true);
      try {
        this.found.set(q ? (await this.records$.searchDocuments(q)).items : []);
      } catch (e) {
        this.store.fail('Could not search the EDRMS', e);
      } finally {
        this.searching.set(false);
      }
    });
  }

  pick(d: FoundDocument) {
    this.picked.set(d);
  }

  /** Step 2 from the picked document: its parcel, as read, in the form. */
  async next() {
    const d = this.picked();
    if (!d) return;
    this.byHand.set(false);
    this.step.set('parcel');
    this.clearCheck();
    this.form.set({});
    const p = await this.runPreview({edrmsDocumentId: d.edrmsDocumentId});
    this.read.set(p?.read ?? null);
    if (p?.read) {
      this.store.ckind.set(p.read.kind);
      this.form.set(
        Object.fromEntries(
          Object.entries(p.read)
            .filter(([k]) => k !== 'kind')
            .map(([k, v]) => [k, String(v)]),
        ),
      );
    }
  }

  /** Step 2 without a document: the parcel entered by hand. */
  enterByHand() {
    this.picked.set(null);
    this.byHand.set(true);
    this.form.set({});
    this.clearCheck();
    this.step.set('parcel');
    this.refresh();
  }

  back() {
    this.step.set('document');
    this.clearCheck();
  }

  setKind(kind: string) {
    this.store.ckind.set(kind);
    this.form.set({});
    this.refresh();
  }

  setField(k: string, v: string) {
    this.form.update(f => ({...f, [k]: v}));
    this.previewing.set(true);
    this.store.debounce('create-preview', () => this.refresh(), 300);
  }

  undo(k: string) {
    const was = this.readValue(k);
    if (was !== null) this.setField(k, was);
  }

  useSuggested(k: string) {
    const s = this.preview()?.suggested[k];
    if (s) this.setField(k, s.value);
  }

  /** Check the parcel as filled in again: the documents about it, and an existing record. */
  refresh() {
    const d = this.picked();
    return this.runPreview({
      parcel: this.parcel(),
      ...(d ? {edrmsDocumentId: d.edrmsDocumentId} : {}),
    });
  }

  async create() {
    if (!this.canCreate()) return;
    this.store.busy.set(true);
    try {
      const d = this.picked();
      const r = await this.records$.create({
        parcel: this.parcel(),
        ...(d ? {edrmsDocumentId: d.edrmsDocumentId} : {}),
      });
      this.store.createOpen.set(false);
      this.store.sf.set('all');
      this.store.show(r);
      this.store.selId.set(r.id);
      this.store.tab.set('documents');
      this.store.mode.set('match');
      this.store.addOpen.set(true);
      this.store.loadFound();
      this.store.comments.set([]);
      this.store.versions.set([]);
      this.navigate(r.id);
      this.toast.show('success', `${r.label} created`, r.recordNo);
    } catch (e) {
      // someone created a record for the parcel meanwhile: the dialog shows it
      if (e instanceof ApiError && e.status === 409) this.refresh();
      this.store.fail('Could not create the record', e);
    } finally {
      this.store.busy.set(false);
    }
  }

  /** Open the record the parcel already has. */
  openExisting() {
    const e = this.existing();
    if (!e) return;
    this.store.createOpen.set(false);
    this.store.sf.set('all');
    this.store.select(e.id);
    this.navigate(e.id);
  }

  /**
   * Update the existing record with the chosen document: a change (draft vN+1) with the document
   * added, or the document added to its open draft.
   */
  async changeWithDocument() {
    const e = this.existing();
    const d = this.picked();
    const offer = this.offer();
    if (!e || !d || (offer !== 'change' && offer !== 'add')) return;
    if (this.store.busy()) return;
    this.store.busy.set(true);
    let draft: LandRecord | null = null;
    try {
      draft =
        offer === 'change'
          ? await this.records$.openDraft(e.id)
          : await this.records$.get(e.id);
      const r = await this.records$.link(
        e.id,
        draft.draft!.revision,
        d.edrmsDocumentId,
      );
      this.store.createOpen.set(false);
      this.store.sf.set('all');
      this.store.select(r.id);
      this.navigate(r.id);
      const n = r.draft!.versionNumber;
      this.toast.show(
        'success',
        offer === 'change'
          ? `Draft version ${n} opened with ${d.ref || d.edrmsNo}`
          : `${d.ref || d.edrmsNo} added to draft version ${n}`,
        r.recordNo,
      );
    } catch (err) {
      // the draft was opened, but the document not added: show the record as it is
      if (draft && offer === 'change') {
        this.store.createOpen.set(false);
        this.store.select(e.id);
        this.navigate(e.id);
      }
      this.store.fail('Could not add the document', err);
    } finally {
      this.store.busy.set(false);
    }
  }

  private navigate(id: string) {
    this.router.navigate([], {queryParams: {record: id}, replaceUrl: true});
  }

  /** Forget the last check, and any check still on its way. */
  private clearCheck() {
    this.previewSeq++;
    this.preview.set(null);
    this.previewing.set(false);
    this.previewFailed.set(false);
    this.read.set(null);
  }

  private async runPreview(body: {parcel?: Parcel; edrmsDocumentId?: string}) {
    const seq = ++this.previewSeq;
    this.previewing.set(true);
    try {
      const p = await this.records$.preview(body);
      if (seq !== this.previewSeq) return null; // a newer check is on its way
      this.preview.set(p);
      this.previewFailed.set(false);
      return p;
    } catch (e) {
      if (seq === this.previewSeq) {
        this.preview.set(null);
        this.previewFailed.set(true);
        this.store.fail('Could not check the parcel', e);
      }
      return null;
    } finally {
      if (seq === this.previewSeq) this.previewing.set(false);
    }
  }
}
