import {Injectable, computed, inject} from '@angular/core';
import {RecordsApi} from '../../api/records.api';
import {ToastService} from '../../state/toast.service';
import {
  EncumbranceOffer,
  encumbranceKey,
  encumbranceOffer,
} from './encumbrance-suggestion';
import {LinkStore} from './link.store';

/** Land record, Details tab: the form for tenure, extent, encumbrances and attributes, and what the documents suggest for them. */
@Injectable()
export class LinkDetailsForm {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);
  private toast = inject(ToastService);

  // dropdown options: each <option> is marked [selected] (API-612/614), so the shown value is the one held
  readonly tenures = [
    {id: '', label: '—'},
    {id: 'freehold', label: 'Freehold'},
    {id: 'leasehold', label: 'Leasehold'},
    {id: 'other', label: 'Other'},
  ];

  readonly units = [
    {id: 'm2', label: 'm²'},
    {id: 'ha', label: 'ha'},
  ];

  readonly encumbranceTypes = [
    {id: 'bond', label: 'Bond'},
    {id: 'servitude', label: 'Servitude'},
    {id: 'other', label: 'Other'},
  ];

  parcelKeys = computed(() =>
    Object.keys(this.store.data()?.parcel || {}).filter(
      k =>
        k !== 'kind' &&
        this.store.data()!.parcel[k] !== null &&
        this.store.data()!.parcel[k] !== '',
    ),
  );

  suggestedExtentDiffers = computed(() => {
    const s = this.store.shown()?.derived?.extent;
    const e = this.store.data()?.extent;
    return !!s && (!e || s.value !== e.value || s.unit !== e.unit);
  });

  /** Bonds the linked mortgage bonds suggest that the saved draft does not have yet. */
  offeredEncumbrances = computed(() =>
    encumbranceOffer(
      this.store.shown()?.derived?.encumbrances,
      this.store.data()?.encumbrances,
    ),
  );

  extentByHand = computed(() => {
    const f = this.store.df();
    const s = this.store.shown()?.derived?.extent;
    const e = this.store.data()?.extent;
    const v = Number(String(f.extent).replace(/\s/g, '').replace(',', '.'));
    if (!f.extent || (e && e.value === v && e.unit === f.unit)) return false;
    return !s || s.value !== v || s.unit !== f.unit;
  });

  /** Take the offered bonds from the documents; encumbrances entered by hand, saved or not, stay. */
  async acceptEncumbrances(o: EncumbranceOffer) {
    const done = await this.store.act(
      r =>
        this.records$.edit(
          r.id,
          o.accept
            ? {revision: r.draft!.revision, accept: ['encumbrances']}
            : {
                revision: r.draft!.revision,
                changes: {encumbrances: o.encumbrances},
              },
        ),
      'Encumbrances taken from the documents',
    );
    if (!done) return;
    // add them to the form without losing rows the officer has not saved yet
    this.store.df.update(f => {
      const have = new Set(f.encumbrances.map(encumbranceKey));
      return {
        ...f,
        encumbrances: [
          ...f.encumbrances,
          ...o.missing
            .filter(e => !have.has(encumbranceKey(e)))
            .map(e => ({...e})),
        ],
      };
    });
  }

  setDf(k: string, v: string) {
    this.store.df.update(f => ({...f, [k]: v}));
  }

  setEnc(i: number, k: string, v: string) {
    this.store.df.update(f => ({
      ...f,
      encumbrances: f.encumbrances.map((e, j) =>
        j === i ? {...e, [k]: v} : e,
      ),
    }));
  }

  addEnc() {
    this.store.df.update(f => ({
      ...f,
      encumbrances: [...f.encumbrances, {type: 'servitude', ref: ''}],
    }));
  }

  removeEnc(i: number) {
    this.store.df.update(f => ({
      ...f,
      encumbrances: f.encumbrances.filter((_, j) => j !== i),
    }));
  }

  setAttr(i: number, k: 'k' | 'v', v: string) {
    this.store.df.update(f => ({
      ...f,
      attributes: f.attributes.map((a, j) => (j === i ? {...a, [k]: v} : a)),
    }));
  }

  addAttr() {
    this.store.df.update(f => ({
      ...f,
      attributes: [...f.attributes, {k: '', v: ''}],
    }));
  }

  removeAttr(i: number) {
    this.store.df.update(f => ({
      ...f,
      attributes: f.attributes.filter((_, j) => j !== i),
    }));
  }

  async saveDetails() {
    const f = this.store.df();
    const d = this.store.data()!;
    const changes: Record<string, unknown> = {};
    if ((f.tenure || null) !== (d.tenure ?? null)) {
      changes['tenure'] = f.tenure || null;
    }
    const value = Number(String(f.extent).replace(/\s/g, '').replace(',', '.'));
    if (
      f.extent &&
      (!d.extent || d.extent.value !== value || d.extent.unit !== f.unit)
    ) {
      changes['extent'] = {value, unit: f.unit};
    }
    if (!f.extent && d.extent) changes['extent'] = null;
    const enc = f.encumbrances
      .filter(e => (e.ref || '').trim())
      .map(e => ({
        type: e.type,
        ref: e.ref.trim(),
        ...(e.inFavourOf?.trim() ? {inFavourOf: e.inFavourOf.trim()} : {}),
        ...(e.note ? {note: e.note} : {}),
      }));
    if (JSON.stringify(enc) !== JSON.stringify(d.encumbrances ?? [])) {
      changes['encumbrances'] = enc;
    }
    // a value shown as JSON and left unchanged keeps its type (number, list, object)
    const attributes = Object.fromEntries(
      f.attributes
        .filter(a => a.k.trim())
        .map(a => [
          a.k.trim(),
          a.orig !== undefined &&
          typeof a.orig !== 'string' &&
          a.v === JSON.stringify(a.orig)
            ? a.orig
            : a.v,
        ]),
    );
    if (JSON.stringify(attributes) !== JSON.stringify(d.attributes ?? {})) {
      changes['attributes'] = Object.keys(attributes).length
        ? attributes
        : null;
    }
    if (!Object.keys(changes).length) {
      this.toast.show('info', 'Nothing to save');
      return;
    }
    if (
      await this.store.act(
        r =>
          this.records$.edit(r.id, {
            revision: r.draft!.revision,
            changes,
            ...(f.reason.trim() ? {reason: f.reason.trim()} : {}),
          }),
        'Details saved',
      )
    ) {
      this.store.resetDetails();
    }
  }

  // ---------------------------------------------------------------- lifecycle
}
