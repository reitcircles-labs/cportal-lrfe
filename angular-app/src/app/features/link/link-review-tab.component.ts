import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {RecordDiffComponent} from '../../shared/record-diff.component';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';

/** Land record, Review & approve tab: the version in review, its checks and changes, and the decision. */
@Component({
  selector: 'app-link-review-tab',
  imports: [RecordDiffComponent],
  template: `
    @let r = store.rec()!;
    @if (r.draftState === 'in_review' && r.draft; as d) {
      <div class="panel">
        <div class="panel-head"><h4>{{ store.myTask() ? 'Version ' + d.versionNumber + ' is waiting for your approval' : 'Version ' + d.versionNumber + ' is in review' }}</h4>
          @if (store.myTask(); as t) { @if (t.dueAt) { <span class="small" [class.muted]="!t.overdue" [style.color]="t.overdue ? 'var(--danger)' : null">Due {{ store.fmt(t.dueAt) }}</span> } }</div>
        <div class="panel-body stack" style="gap:14px">
          <div class="kv">
            <span>Submitted by</span><span>{{ d.submittedByName || '—' }} · {{ store.fmt(d.submittedAt) }}{{ store.submissions() > 1 ? ' (submission ' + store.submissions() + ')' : '' }}</span>
          </div>
          @if (store.review(); as rv) {
            <div class="stack" style="gap:8px">
              <b class="small">Checks</b>
              @for (c of rv.checks; track c.id) {
                <div class="chk"><span class="check-mark" aria-hidden="true" [class.ok]="c.ok" [class.bad]="!c.ok && c.level === 'error'">{{ c.ok ? '✓' : c.level === 'error' ? '✕' : '!' }}</span><span class="small"><span class="sr-only">{{ c.ok ? 'Passed: ' : c.level === 'error' ? 'Failed: ' : 'Warning: ' }}</span>{{ c.message }}</span></div>
              }
              @if (rv.overrides.length) {
                <b class="small">Entered by hand</b>
                @for (o of rv.overrides; track o.what) { <span class="small">{{ o.what }}{{ o.by ? ' (' + o.by + ')' : '' }}: {{ o.reason || 'no reason given' }}</span> }
              }
              <b class="small">{{ rv.currentVersion ? 'Changes since version ' + rv.currentVersion.versionNumber : 'What this version contains' }}</b>
              <app-record-diff [diff]="rv.diff" />
            </div>
          } @else { <span class="small muted">{{ store.reviewFailed() ? 'The review could not be loaded.' : 'Loading the review…' }}</span> }
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h4>Discussion on version {{ d.versionNumber }}</h4><button class="btn btn-ghost" style="min-height:30px" (click)="store.tab.set('discussion'); store.loadDiscussion()">Open the whole discussion</button></div>
        <ul class="thread">
          @for (e of store.versionEvents(); track e.key) { <li [class]="'dev ' + e.kind">
            <span class="av">{{ store.initials(e.byName) }}</span>
            <div class="stack" style="gap:3px;min-width:0">
              <span class="row" style="gap:8px;flex-wrap:wrap"><b>{{ e.byName }}</b>@if (e.what) { <span class="what">{{ e.what }}</span> }<span class="small muted">{{ store.fmt(e.at) }}</span></span>
              @if (e.text) { <span style="font-size:14px;white-space:pre-wrap">{{ e.text }}</span> }
            </div>
          </li> }
        </ul>
      </div>

      @if (store.myTask()) {
        <form class="panel decide" (submit)="$event.preventDefault()">
          <div class="panel-head"><h4>Your decision</h4></div>
          <div class="panel-body stack" style="gap:10px">
            <div class="field"><label for="dc">Comment <span class="muted">(needed to return it, optional to approve · kept in the Discussion)</span></label>
              <textarea id="dc" class="input" rows="3" [value]="store.decisionText()" (input)="store.decisionText.set($any($event.target).value)"></textarea></div>
            @if (store.decisionError()) { <div class="err" role="alert">{{ store.decisionError() }}</div> }
            <div class="row" style="justify-content:flex-end;gap:10px;flex-wrap:wrap">
              <button type="button" class="btn btn-danger" [disabled]="store.busy()" (click)="store.decide('rejected')">Return to records officer</button>
              <button type="button" class="btn btn-primary" [disabled]="store.busy()" (click)="store.decide('approved')">Approve version {{ d.versionNumber }}</button>
            </div>
          </div>
        </form>
      } @else if (store.checkingTasks()) {
        <div class="small muted">Checking your tasks…</div>
      } @else {
        <div class="note info" role="status">
          @if (store.isSubmitter()) { <b>You submitted this version.</b> Another person who can finalize records must approve it (four-eyes). }
          @else { <b>Another person must approve this version.</b> It is not among your tasks: with four-eyes finalization on, whoever filed one of its documents may not approve it, or someone else has the task. }
          You can still read the review and comment in the Discussion.
        </div>
      }
    } @else if (r.draft) {
      <div class="panel"><div class="panel-body stack" style="gap:6px">
        <b>Version {{ r.draft.versionNumber }} is a draft with the records officer</b>
        <span class="small muted">It comes here for approval once it is submitted.</span>
        @if (store.lastReturn(); as ret) { <span class="small">Returned by {{ ret.byName }}: {{ ret.text }}</span> }
      </div></div>
    } @else if (store.lastApproval(); as a) {
      <div class="panel"><div class="panel-body stack" style="gap:10px">
        <b>Version {{ a.versionNumber }} approved: nothing is waiting for approval</b>
        <div class="kv">
          <span>Submitted by</span><span>{{ a.submittedBy }}</span>
          <span>Approved by</span><span>{{ a.approvedBy }}</span>
          @if (a.comment) { <span>Comment</span><span style="white-space:pre-wrap">{{ a.comment }}</span> }
        </div>
        <button class="btn btn-ghost" style="align-self:flex-start;min-height:30px" (click)="store.tab.set('discussion'); store.loadDiscussion()">Open the whole discussion</button>
      </div></div>
    } @else {
      <div class="panel"><div class="panel-body small muted">Nothing is waiting for approval.</div></div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .decide textarea.input { min-height: 72px; resize: vertical; font: inherit; }
  `,
  ],
})
export class LinkReviewTabComponent {
  protected readonly store = inject(LinkStore);
}
