import {Injectable, computed, inject} from '@angular/core';
import {ApiError} from '../../api/api.service';
import {ConfirmService} from '../../state/confirm.service';
import {ToastService} from '../../state/toast.service';
import {TasksService} from '../../state/tasks.service';
import {DiscussionEvent, isDecision} from './discussion';
import {LinkStore} from './link.store';

/** Land record, Review & approve tab: the version in review, its last decisions, and approving or returning it. */
@Injectable()
export class LinkReviewFlow {
  private readonly store = inject(LinkStore);
  private confirm = inject(ConfirmService);
  private toast = inject(ToastService);
  private tasks = inject(TasksService);

  versionEvents = computed<DiscussionEvent[]>(() => {
    const n = this.store.rec()?.draft?.versionNumber;
    return this.store.events().filter(e => e.versionNumber === n);
  });

  submissions = computed(
    () => this.versionEvents().filter(e => e.kind === 'submitted').length,
  );

  /** Who submitted and approved the current version, and the approver's comment. */
  lastApproval = computed(() => {
    const c = this.store.rec()?.current;
    if (!c) return null;
    return {
      versionNumber: c.versionNumber,
      submittedBy: `${c.submittedByName || '—'} · ${this.store.fmt(c.submittedAt)}`,
      approvedBy: `${c.approvedByName || '—'} · ${this.store.fmt(c.committedAt)}`,
      comment: c.reviewComment,
    };
  });

  /** Who returned the open draft, and why, when that was the last decision on it. */
  lastReturn = computed(() => {
    const last = this.versionEvents().filter(isDecision).at(-1);
    return last?.kind === 'returned' ? last : null;
  });

  /** Approve or return the version in review: the same approval task as in the task inbox. */
  async decide(outcome: 'approved' | 'rejected') {
    const t = this.store.myTask();
    const r = this.store.rec();
    if (!t || !r?.draft || this.store.busy()) return;
    const comment = this.store.decisionText().trim();
    const version = r.draft.versionNumber;
    if (outcome === 'rejected' && !comment) {
      this.store.decisionError.set('Say what the records officer should fix.');
      return;
    }
    if (
      outcome === 'approved' &&
      !(await this.confirm.ask({
        title: `Approve version ${version} of ${r.label}?`,
        body: 'It becomes the current version of the land record and is sealed.',
        confirmLabel: `Approve version ${version}`,
      }))
    ) {
      return;
    }
    this.store.busy.set(true);
    this.store.decisionError.set('');
    try {
      const inst = await this.tasks.complete(
        t.id,
        outcome,
        comment || undefined,
      );
      if (inst.status === 'error') {
        this.toast.show(
          'warn',
          'Decision recorded, but the change could not be applied',
          inst.errorMessage || 'See the process for details.',
          9000,
        );
      } else if (outcome === 'approved') {
        this.toast.show(
          'success',
          `${r.label} approved: version ${version} is now current`,
          r.recordNo,
        );
      } else {
        this.toast.show(
          'info',
          `${r.label} returned to the records officer`,
          r.recordNo,
        );
      }
      this.store.decisionText.set('');
    } catch (e) {
      // e.g. decided meanwhile in the bell or by someone else, or withdrawn: the error, and the record as it is now
      this.store.decisionError.set(
        e instanceof ApiError ? e.message : String(e),
      );
      this.store.fail('Could not record the decision', e); // the form, and the error in it, may be gone after the reload
      this.tasks.refresh();
    } finally {
      this.store.busy.set(false);
    }
    await this.store
      .reload()
      .catch(e => this.store.fail('Could not reload the land record', e));
    this.store.refreshReview();
    this.store.loadDiscussion();
  }

  // ---------------------------------------------------------------- new record
}
