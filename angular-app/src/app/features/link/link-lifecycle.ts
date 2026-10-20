import {Injectable, inject} from '@angular/core';
import {Flag, RecordsApi} from '../../api/records.api';
import {ConfirmService} from '../../state/confirm.service';
import {LinkStore} from './link.store';

/**
 * Land record: submitting a draft for review, withdrawing it, opening a change, adding or dismissing
 * a new document (API-766), and the bin (API-767).
 */
@Injectable()
export class LinkLifecycle {
  private readonly store = inject(LinkStore);
  private records$ = inject(RecordsApi);
  private confirm = inject(ConfirmService);

  async submit() {
    const r = this.store.rec()!;
    const owners =
      this.store
        .owners()
        .map(o => `${o.name} ${o.share}`)
        .join(', ') || 'none';
    if (
      !(await this.confirm.ask({
        title: `Submit ${r.label} for review?`,
        body: `Owners: ${owners}. A second person who can finalize records approves or returns it. It cannot be edited while in review.`,
        confirmLabel: 'Submit for review',
      }))
    ) {
      return;
    }
    if (
      await this.store.act(
        x => this.records$.submit(x.id, x.draft!.revision),
        `${r.label} submitted for review`,
      )
    ) {
      this.store.loadDiscussion();
      this.store.refreshReview();
    }
  }

  async withdraw() {
    const r = this.store.rec()!;
    if (
      !(await this.confirm.ask({
        title: `Withdraw ${r.label} from review?`,
        body: 'The approval task is removed and the draft can be edited again.',
        confirmLabel: 'Withdraw',
      }))
    ) {
      return;
    }
    if (
      await this.store.act(
        x => this.records$.withdraw(x.id),
        'Withdrawn from review',
      )
    ) {
      this.store.loadFound();
      this.store.loadDiscussion();
      this.store.refreshReview();
    }
  }

  async change() {
    if (
      await this.store.act(
        r => this.records$.openDraft(r.id),
        'A new draft is open; the committed version stays current until the change is approved',
      )
    ) {
      this.store.addOpen.set(true);
      this.store.loadFound();
    }
  }

  // ---------------------------------------------------------------- new documents (API-766)

  /**
   * A document filed for the parcel, into the record: added to the open draft, or a change opened
   * with it (the current version stays current until the change is approved).
   */
  async addFiled(f: Flag) {
    const name = f.ref || f.edrmsNo;
    let r = this.store.rec()!;
    if (!r.draftVersion) {
      const opened = await this.store.act(
        x => this.records$.openDraft(x.id),
        `Draft version ${(r.currentVersion ?? 0) + 1} opened`,
      );
      if (!opened) return;
      r = opened;
    }
    if (
      await this.store.act(
        x => this.records$.link(x.id, x.draft!.revision, f.edrmsDocumentId),
        `${name} added to draft version ${r.draft!.versionNumber}`,
      )
    ) {
      this.store.addOpen.set(true);
      this.store.loadFound();
    }
  }

  // ---------------------------------------------------------------- the bin (API-767)

  /** Open the bin dialog: to discard the open draft of an approved record, else to move the record to the bin. */
  askBin() {
    this.store.binReason.set('');
    this.store.binning.set(
      this.store.rec()?.currentVersion ? 'draft' : 'record',
    );
  }

  /** Move the record to the bin, or discard its open draft: what the bin dialog was opened for. */
  async bin() {
    const what = this.store.binning();
    const reason = this.store.binReason().trim();
    if (!what || !reason) return;
    const r = this.store.rec()!;
    const done = await this.store.act(
      x =>
        what === 'record'
          ? this.records$.moveToBin(x.id, reason)
          : this.records$.discardDraft(x.id, reason),
      what === 'record'
        ? `${r.label} moved to the bin`
        : `Draft version ${r.draftVersion} discarded; version ${r.currentVersion} stays current`,
    );
    if (done) {
      this.store.binning.set(null);
      this.store.binReason.set('');
      this.store.loadFound();
      if (this.store.history()) this.store.loadHistory();
    }
  }

  /** Take the record out of the bin, as it was. */
  async restore() {
    const r = this.store.rec()!;
    if (
      await this.store.act(
        x => this.records$.restore(x.id),
        `${r.label} restored`,
      )
    ) {
      this.store.loadFound();
      if (this.store.history()) this.store.loadHistory();
    }
  }

  /** Dismiss the "new document" flag being dismissed, with the reason typed in. */
  async dismissFiled() {
    const f = this.store.dismissing();
    const reason = this.store.dismissReason().trim();
    if (!f || !reason) return;
    if (
      await this.store.act(
        x => this.records$.dismissFlag(x.id, f.edrmsDocumentId, reason),
        `${f.ref || f.edrmsNo} dismissed`,
      )
    ) {
      this.store.dismissing.set(null);
      this.store.dismissReason.set('');
      if (this.store.history()) this.store.loadHistory();
    }
  }
}
