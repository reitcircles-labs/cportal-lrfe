import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {Extract, ExtractsApi} from '../../api/extracts.api';
import {RecordsApi} from '../../api/records.api';
import {Anchoring} from '../../shared/anchoring';
import {ToastService} from '../../state/toast.service';
import {LinkStore} from './link.store';

/** An ID number as typed or recorded: its characters without spaces. */
const idOf = (v: string | undefined | null) =>
  String(v ?? '').replace(/\s/g, '');

/**
 * Land record, Extracts tab (API-692): the register of the record's ownership extracts, whether
 * one can be issued now (its current version confirmed on the blockchain), issuing one for a
 * registered owner at the counter, downloading or printing it again, and revoking one with a
 * reason. Loaded when a record is opened, for staff who may issue extracts.
 */
@Injectable()
export class LinkExtracts {
  private readonly store = inject(LinkStore);
  private extracts$ = inject(ExtractsApi);
  private records$ = inject(RecordsApi);
  private toast = inject(ToastService);

  readonly items = signal<Extract[]>([]);
  readonly loaded = signal(false);
  readonly failed = signal(false);
  /** The blockchain status of the record's current version (from its history). */
  readonly anchoring = signal<Anchoring | null>(null);
  /** The history could not be read: whether the version is on the blockchain is not known. */
  readonly statusUnknown = signal(false);
  readonly dialog = signal<'issue' | 'issued' | 'revoke' | null>(null);
  readonly ownerIndex = signal<number | null>(null);
  readonly idNo = signal('');
  readonly idSeen = signal(false);
  readonly issued = signal<Extract | null>(null);
  readonly revoking = signal<Extract | null>(null);
  readonly reason = signal('');
  readonly busy = signal(false);

  /** Who may issue: the tab exists only for them. */
  readonly allowed = computed(() => this.store.rbac.can('extract.issue'));
  readonly validCount = computed(
    () => this.items().filter(e => e.status === 'valid').length,
  );
  /** The record's current (committed) version. */
  readonly current = computed(() => this.store.rec()?.current ?? null);
  readonly owners = computed(() => this.current()?.data.owners ?? []);
  /**
   * Whether an extract can be issued now: `ready` (current version confirmed on the blockchain),
   * `anchoring` (on the blockchain, not yet confirmed), `waiting` (not on it yet), `none` (no
   * approved version), `unknown` (its status could not be read now).
   */
  readonly readiness = computed<
    'ready' | 'anchoring' | 'waiting' | 'none' | 'unknown'
  >(() => {
    if (!this.current()) return 'none';
    if (this.statusUnknown()) return 'unknown';
    const a = this.anchoring();
    if (a?.status === 'confirmed') return 'ready';
    return a?.status === 'anchored' ? 'anchoring' : 'waiting';
  });
  /** Which load is the latest: an older answer arriving later is dropped. */
  private loadSeq = 0;
  /** The record and current version the register is for: a reload only when one of them changes. */
  private readonly loadKey = computed(() => {
    const r = this.store.rec();
    return r && this.allowed() ? `${r.id}:${r.currentVersion ?? ''}` : null;
  });
  readonly owner = computed(() => {
    const i = this.ownerIndex();
    return i === null ? null : (this.owners()[i] ?? null);
  });
  /** The typed ID number against the owner's on the record: null until something is typed. */
  readonly idMatches = computed(() => {
    const typed = idOf(this.idNo());
    if (!typed || !this.owner()) return null;
    return typed === idOf(this.owner()!.idNo);
  });
  readonly canIssue = computed(
    () =>
      this.readiness() === 'ready' &&
      this.idMatches() === true &&
      this.idSeen() &&
      !this.busy(),
  );

  constructor() {
    // a record opened, or its current version changed: its register and that version's status
    effect(() => {
      const key = this.loadKey();
      if (!key) return;
      untracked(() => {
        const r = this.store.rec()!;
        this.load(r.id, r.currentVersion ?? null);
      });
    });
  }

  /** Read the record's extracts and its current version's blockchain status. */
  async load(recordId: string, currentVersion: number | null) {
    const seq = ++this.loadSeq;
    // another record: nothing of the previous one is shown meanwhile
    if (this.items()[0]?.recordId !== recordId) {
      this.items.set([]);
      this.loaded.set(false);
      this.anchoring.set(null);
    }
    this.failed.set(false);
    const [list, history] = await Promise.allSettled([
      this.extracts$.list(recordId),
      currentVersion ? this.records$.history(recordId) : Promise.resolve(null),
    ]);
    if (seq !== this.loadSeq) return; // a newer load is on its way
    if (list.status === 'fulfilled') {
      this.items.set(list.value.items);
    } else {
      this.items.set([]);
      this.failed.set(true);
    }
    this.statusUnknown.set(history.status === 'rejected');
    const versions =
      history.status === 'fulfilled' ? (history.value?.versions ?? []) : [];
    this.anchoring.set(
      versions.find(v => v.versionNumber === currentVersion)?.anchoring ?? null,
    );
    this.loaded.set(true);
  }

  openIssue() {
    this.ownerIndex.set(this.owners().length === 1 ? 0 : null);
    this.idNo.set('');
    this.idSeen.set(false);
    this.dialog.set('issue');
  }

  pickOwner(i: number) {
    this.ownerIndex.set(i);
    this.idNo.set('');
  }

  async issue() {
    const r = this.store.rec();
    const current = this.current();
    if (!r || !current || !this.canIssue()) return;
    this.busy.set(true);
    try {
      const extract = await this.extracts$.issue({
        recordId: r.id,
        versionNumber: current.versionNumber,
        ownerIndex: this.ownerIndex()!,
        idNo: idOf(this.idNo()),
        documentSeen: true,
      });
      this.items.update(list => [extract, ...list]);
      this.issued.set(extract);
      this.dialog.set('issued');
    } catch (e) {
      this.store.fail(
        'The extract could not be issued, and nothing was recorded',
        e,
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Save the extract's PDF. */
  async download(e: Extract) {
    const pdf = await this.fetchPdf(e);
    if (!pdf) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(pdf);
    // an extract issued before numbers existed (development data only) by its id
    link.download = `${e.extractNo ?? e.id}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  }

  /** Open the extract's PDF in a new tab, where it can be printed. */
  async print(e: Extract) {
    // opened at once, while the click still counts, then pointed at the PDF
    const tab = window.open('', '_blank');
    const pdf = await this.fetchPdf(e);
    if (!pdf) {
      tab?.close();
      return;
    }
    if (!tab) {
      // the browser blocked the new tab
      this.toast.show(
        'warn',
        'The PDF could not be opened in a new tab',
        'Allow pop-ups for this site, or use Download PDF and print it from there.',
      );
      return;
    }
    const url = URL.createObjectURL(pdf);
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  openRevoke(e: Extract) {
    this.revoking.set(e);
    this.reason.set('');
    this.dialog.set('revoke');
  }

  async revoke() {
    const e = this.revoking();
    const why = this.reason().trim();
    if (!e || !why || this.busy()) return;
    this.busy.set(true);
    try {
      const revoked = await this.extracts$.revoke(e.id, why);
      this.items.update(list =>
        list.map(x => (x.id === revoked.id ? {...x, ...revoked} : x)),
      );
      this.dialog.set(null);
      this.toast.show(
        'success',
        `Extract ${e.extractNo} revoked. The check page now says the registry withdrew it.`,
      );
    } catch (err) {
      this.store.fail('The extract could not be revoked', err);
    } finally {
      this.busy.set(false);
    }
  }

  close() {
    this.dialog.set(null);
  }

  private async fetchPdf(e: Extract): Promise<Blob | null> {
    try {
      return await this.extracts$.pdf(e.id);
    } catch (err) {
      this.store.fail('The extract’s PDF could not be opened', err);
      return null;
    }
  }
}
