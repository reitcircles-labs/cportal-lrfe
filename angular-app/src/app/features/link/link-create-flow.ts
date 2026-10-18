import {Injectable, computed, inject} from '@angular/core';
import {Router} from '@angular/router';
import {ApiError} from '../../api/api.service';
import {Parcel, RecordsApi} from '../../api/records.api';
import {ToastService} from '../../state/toast.service';
import {LinkStore} from './link.store';

/** Land records: creating a record from a filed document or for a parcel. */
@Injectable()
export class LinkCreateFlow {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);
  private toast = inject(ToastService);
  private router = inject(Router);

  kindFields = computed(() => {
    const k = this.store.kinds().find(x => x.id === this.store.ckind());
    if (!k) return [];
    const p = k.schema.properties.parcel;
    return Object.keys(p.properties)
      .filter(f => f !== 'kind')
      .map(f => ({k: f, required: (p.required || []).includes(f)}));
  });

  canCreate = computed(() =>
    this.store.cmode() === 'doc'
      ? !!this.store.cpick()
      : this.kindFields()
          .filter(f => f.required)
          .every(f => (this.store.cparcel()[f.k] || '').trim()),
  );

  openCreate() {
    this.store.cmode.set('doc');
    this.store.cq.set('');
    this.store.cfound.set([]);
    this.store.cpick.set(null);
    this.store.cparcel.set({});
    if (!this.store.kinds().length) {
      this.records$
        .catalogue()
        .then(c => this.store.kinds.set(c.parcelKinds))
        .catch(e => this.store.fail('Could not load parcel kinds', e));
    }
    this.store.createOpen.set(true);
  }

  searchCreate(v: string) {
    this.store.cq.set(v);
    this.store.debounce('create', async () => {
      try {
        this.store.cfound.set(
          this.store.cq().trim()
            ? (await this.records$.searchDocuments(this.store.cq().trim()))
                .items
            : [],
        );
      } catch (e) {
        this.store.fail('Could not search the EDRMS', e);
      }
    });
  }

  setParcel(k: string, v: string) {
    this.store.cparcel.update(p => ({...p, [k]: v}));
  }

  async create() {
    if (!this.canCreate() || this.store.busy()) return;
    this.store.busy.set(true);
    try {
      let body: {parcel?: Parcel; edrmsDocumentId?: string};
      if (this.store.cmode() === 'doc') {
        body = {edrmsDocumentId: this.store.cpick()!};
      } else {
        const parcel: Parcel = {kind: this.store.ckind()};
        for (const f of this.kindFields()) {
          const v = (this.store.cparcel()[f.k] || '').trim();
          if (v) parcel[f.k] = f.k === 'participationQuota' ? Number(v) : v;
        }
        body = {parcel};
      }
      const r = await this.records$.create(body);
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
      this.router.navigate([], {queryParams: {record: r.id}, replaceUrl: true});
      this.toast.show('success', `${r.label} created`, r.recordNo);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409 && err.details?.recordId) {
        this.store.createOpen.set(false);
        this.store.select(err.details.recordId);
      }
      this.store.fail('Could not create the record', e);
    } finally {
      this.store.busy.set(false);
    }
  }
}
