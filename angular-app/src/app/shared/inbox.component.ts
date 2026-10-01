import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TaskDetail, TaskItem, TasksService } from '../state/tasks.service';
import { ToastService } from '../state/toast.service';
import { ApiError } from '../api/api.service';
import { fmtTime } from '../state/rbac.service';
import { IconComponent } from './icon.component';

/** Top-bar bell: the workflow inbox (bpm tasks), and the dialog to approve or reject a task. */
@Component({
  selector: 'app-inbox',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="wrap">
      <button class="btn btn-ghost btn-icon bell" (click)="open.set(!open()); tasks.refresh()" title="Tasks" aria-label="Tasks" [attr.aria-expanded]="open()">
        <app-icon name="bell" [size]="19" />
        @if (count()) { <span class="count" [class.overdue]="overdue()">{{ count() }}</span> }
      </button>
      @if (open()) {
        <div class="menu" role="menu">
          <div class="mh"><b>My tasks</b><span class="small muted">{{ count() }} open</span></div>
          @for (t of tasks.tasks(); track t.id) {
            <button class="item" role="menuitem" (click)="review(t)">
              <span class="stack" style="gap:2px;min-width:0">
                <span class="t">{{ t.title }}</span>
                <span class="small muted">{{ label(t) }} · {{ fmt(t.createdAt) }}@if (t.claimedByName) { · claimed by you }</span>
              </span>
              @if (t.overdue) { <span class="tag tag-danger">Overdue</span> } @else if (t.dueAt) { <span class="small muted">due {{ fmt(t.dueAt).slice(0, 6) }}</span> }
            </button>
          } @empty { <div class="small muted" style="padding:22px 16px;text-align:center">Nothing waiting for you.</div> }
        </div>
      }
    </div>

    @if (detail(); as d) {
      <div class="dialog-backdrop" (click)="close()">
        <form class="dialog" style="width:min(640px,100%)" (click)="$event.stopPropagation()" (submit)="$event.preventDefault()">
          <div class="dialog-title">{{ d.title }}</div>
          <div class="kv">
            <span>Requested by</span><span>{{ d.input.startedBy?.name }} · {{ fmt(d.createdAt) }}</span>
            @if (d.input.document; as doc) { <span>Document</span><span>{{ doc.edrmsNo }} · {{ doc.title }} · v{{ doc.currentVersion }}.0</span> }
            <span>Reason</span><span>{{ d.input.reason }}</span>
            @if (d.dueAt) { <span>Due</span><span [style.color]="d.overdue ? 'var(--danger)' : null">{{ fmt(d.dueAt) }}</span> }
          </div>
          @if (d.input.preview?.length) {
            <table class="table" style="font-size:13.5px">
              <thead><tr><th>Field</th><th>Current</th><th>Proposed</th></tr></thead>
              <tbody>@for (c of d.input.preview; track c.k) { <tr><td class="small muted">{{ c.label }}</td><td class="strike">{{ c.from }}</td><td><b>{{ c.to }}</b></td></tr> }</tbody>
            </table>
          }
          <div class="field"><label for="cm">Comment {{ outcome() === 'rejected' ? '(required to reject)' : '(optional)' }}</label>
            <textarea id="cm" class="input" rows="3" [value]="comment()" (input)="comment.set($any($event.target).value)"></textarea></div>
          @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
          <div class="dialog-actions">
            @if (d.input.document) { <button type="button" class="btn btn-ghost" style="margin-right:auto" (click)="openDoc(d.input.document!.id)"><app-icon name="file" [size]="15" />Open document</button> }
            <button type="button" class="btn btn-secondary" (click)="close()">Later</button>
            @if (d.outcomes?.includes('rejected')) { <button type="button" class="btn btn-danger" [disabled]="busy()" (click)="decide('rejected')">Reject</button> }
            @if (d.outcomes?.includes('approved')) { <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="decide('approved')">Approve</button> }
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    .wrap { position: relative; }
    .bell { position: relative; }
    .count { position: absolute; top: 3px; right: 2px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 99px; background: var(--color-accent); color: #fff; font-size: 10.5px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 0 0 2px var(--color-surface); }
    .count.overdue { background: var(--nam-red); }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); width: min(400px, calc(100vw - 24px)); max-height: 70vh; overflow-y: auto; background: var(--color-surface); border: 1px solid var(--color-divider); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); z-index: 60; }
    .mh { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--color-divider); }
    .item { width: 100%; display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 11px 16px; border: 0; border-bottom: 1px solid var(--color-divider); background: transparent; text-align: left; cursor: pointer; }
    .item:hover { background: var(--color-accent-100); }
    .item .t { font-weight: 600; font-size: 13.5px; }
    .kv { margin: 4px 0 12px; }
    .strike { text-decoration: line-through; color: var(--color-neutral-600); }
    .err { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
    textarea.input { min-height: 72px; resize: vertical; font: inherit; }
  `]
})
export class InboxComponent {
  tasks = inject(TasksService);
  private toast = inject(ToastService);
  private router = inject(Router);
  open = signal(false);
  detail = signal<TaskDetail | null>(null);
  comment = signal('');
  outcome = signal<string | null>(null);
  busy = signal(false);
  error = signal('');
  count = computed(() => this.tasks.tasks().length);
  overdue = computed(() => this.tasks.tasks().some(t => t.overdue));

  fmt = fmtTime;
  label(t: TaskItem) { return t.document ? t.document.edrmsNo : t.definitionKey; }

  async review(t: TaskItem) {
    this.open.set(false);
    try {
      this.detail.set(await this.tasks.get(t.id));
      this.comment.set(''); this.outcome.set(null); this.error.set('');
    } catch (e) {
      this.toast.show('danger', 'Could not open the task', e instanceof ApiError ? e.message : String(e));
      this.tasks.refresh();
    }
  }

  async decide(outcome: 'approved' | 'rejected') {
    const d = this.detail()!;
    this.outcome.set(outcome);
    if (outcome === 'rejected' && !this.comment().trim()) { this.error.set('Say why you reject the change.'); return; }
    this.busy.set(true); this.error.set('');
    try {
      const inst = await this.tasks.complete(d.id, outcome, this.comment().trim() || undefined);
      if (inst.status === 'error') this.toast.show('warn', 'Approved, but the change could not be applied', inst.errorMessage || 'See the process for details.', 9000);
      else this.toast.show(outcome === 'approved' ? 'success' : 'info', outcome === 'approved' ? 'Change approved and applied' : 'Change rejected', d.input.document?.edrmsNo);
      this.detail.set(null);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : String(e));
    } finally { this.busy.set(false); }
  }

  openDoc(id: string) { this.detail.set(null); this.router.navigate(['/documents'], { queryParams: { id } }); }
  close() { this.detail.set(null); }

  @HostListener('document:click', ['$event'])
  outside(e: Event) { if (this.open() && !(e.target as HTMLElement).closest('app-inbox')) this.open.set(false); }
}
