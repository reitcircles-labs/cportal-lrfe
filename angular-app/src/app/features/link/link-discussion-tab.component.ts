import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {CanDirective} from '../../shared/can.directive';
import {LINK_SHARED_STYLES} from './link-shared.styles';
import {LinkStore} from './link.store';

/** Land record, Discussion tab: comments and review decisions by version, and the comment box. */
@Component({
  selector: 'app-link-discussion-tab',
  imports: [CanDirective],
  template: `
    @let r = store.rec()!;
    <div class="panel">
      <div class="panel-head">
        <div class="chips" role="group" aria-label="Show">
          @for (f of store.dfilters(); track f.id) {
            <button class="chip" [class.on]="store.dfilter() === f.id" [attr.aria-pressed]="store.dfilter() === f.id" (click)="store.dfilter.set(f.id)">{{ f.label }} <b>{{ f.n }}</b></button>
          }
        </div>
        <span class="small muted">Comments and review decisions, by version</span>
      </div>
      @for (g of store.groups(); track g.versionNumber) {
        <div class="vh"><b>{{ g.versionNumber ? 'Version ' + g.versionNumber : 'Before the first version' }}</b><i></i>
          @if (g.versionNumber && g.versionNumber === r.currentVersion) { <span class="tag tag-accent">Current</span> }
          @else if (g.versionNumber && g.versionNumber === r.draftVersion) { <span class="tag tag-neutral">{{ r.draftState === 'in_review' ? 'In review' : 'Draft' }}</span> }</div>
        <ul class="thread" [attr.aria-label]="g.versionNumber ? 'Version ' + g.versionNumber : 'Before the first version'">
          @for (e of g.events; track e.key) { <li [class]="'dev ' + e.kind">
            <span class="av">{{ store.initials(e.byName) }}</span>
            <div class="stack" style="gap:3px;min-width:0">
              <span class="row" style="gap:8px;flex-wrap:wrap"><b>{{ e.byName }}</b>@if (e.what) { <span class="what">{{ e.what }}</span> }<span class="small muted">{{ store.fmt(e.at) }}</span></span>
              @if (e.text) { <span style="font-size:14px;white-space:pre-wrap">{{ e.text }}</span> }
            </div>
          </li> }
        </ul>
      } @empty { <ul class="thread"><li class="muted small" style="justify-content:center">{{ store.dfilter() === 'all' ? 'No comments yet. Start the discussion for this record.' : 'Nothing of this kind yet.' }}</li></ul> }
      <div class="composer">
        <span class="av">{{ store.auth.role()?.initials }}</span>
        <div class="stack" style="gap:8px;flex:1;min-width:0">
          <textarea class="input" rows="3" aria-label="Comment" [readonly]="!store.rbac.can('record.comment')" placeholder="Add a comment for reviewers, the registrar or auditors…" [value]="store.draftText()" (input)="store.draftText.set($any($event.target).value)" (keydown.control.enter)="store.post()" (keydown.meta.enter)="store.post()"></textarea>
          <div class="row" style="justify-content:space-between"><span class="small muted">Visible to everyone with access to this record · Ctrl + Enter to post</span><button class="btn btn-primary" [disabled]="!store.draftText().trim()" appCan="record.comment" (click)="store.post()">Post comment</button></div>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    LINK_SHARED_STYLES,
    `
    :host { display: contents; }
    .composer { display: flex; gap: 12px; padding: 16px 18px; background: var(--color-surface-2); border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
  `,
  ],
})
export class LinkDiscussionTabComponent {
  protected readonly store = inject(LinkStore);
}
