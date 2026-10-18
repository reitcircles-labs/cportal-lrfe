import {Injectable, inject} from '@angular/core';
import {RecordsApi} from '../../api/records.api';
import {ConfirmService} from '../../state/confirm.service';
import {LinkStore} from './link.store';

/** Land record: submitting a draft for review, withdrawing it, and opening a change. */
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

  // ---------------------------------------------------------------- history
}
