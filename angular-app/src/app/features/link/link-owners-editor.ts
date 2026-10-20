import {Injectable, computed, inject} from '@angular/core';
import {Owner, RecordsApi} from '../../api/records.api';
import {LinkStore} from './link.store';

/** Owners as one comparable key: names, shares and ID numbers, sorted. */
const ownerKey = (list: Owner[] | null | undefined) =>
  JSON.stringify(
    (list || [])
      .map(o => [o.name.toLowerCase(), o.share, o.idNo ?? null])
      .sort(),
  );

/** Land record: editing the registered owners of a draft, and the owners the documents suggest. */
@Injectable()
export class LinkOwnersEditor {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);

  suggestedOwnersDiffer = computed(() => {
    const s = this.store.shown()?.derived?.owners;
    return !!s?.length && ownerKey(s) !== ownerKey(this.store.owners());
  });

  suggestedOwnersText = computed(() =>
    (this.store.shown()?.derived?.owners || [])
      .map(o => `${o.name} ${o.share}`)
      .join(', '),
  );

  editOwners() {
    this.store.ownerForm.set({
      owners: structuredClone(
        this.store.owners().length
          ? this.store.owners()
          : (this.store.shown()?.derived?.owners ?? []),
      ),
      reason: '',
    });
  }

  setOwner(i: number, k: 'name' | 'idNo' | 'share', v: string) {
    this.store.ownerForm.update(
      f =>
        f && {
          ...f,
          owners: f.owners.map((o, j) => (j === i ? {...o, [k]: v} : o)),
        },
    );
  }

  addOwner() {
    this.store.ownerForm.update(
      f => f && {...f, owners: [...f.owners, {name: '', share: ''}]},
    );
  }

  removeOwner(i: number) {
    this.store.ownerForm.update(
      f => f && {...f, owners: f.owners.filter((_, j) => j !== i)},
    );
  }

  setOwnerReason(v: string) {
    this.store.ownerForm.update(f => f && {...f, reason: v});
  }

  async saveOwners() {
    const f = this.store.ownerForm()!;
    const owners = f.owners
      .filter(o => o.name.trim())
      .map(o => ({
        ...o,
        name: o.name.trim(),
        share: o.share.trim(),
        ...(o.idNo?.trim() ? {idNo: o.idNo.trim()} : {idNo: undefined}),
      }))
      .map(({idNo, ...o}) => (idNo ? {...o, idNo} : o));
    if (
      await this.store.act(
        r =>
          this.records$.edit(r.id, {
            revision: r.draft!.revision,
            changes: {owners},
            ...(f.reason.trim() ? {reason: f.reason.trim()} : {}),
          }),
        'Owners saved',
      )
    ) {
      this.store.ownerForm.set(null);
    }
  }
}
