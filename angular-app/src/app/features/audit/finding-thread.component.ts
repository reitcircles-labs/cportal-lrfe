import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { Finding } from '../../api/audit.api';
import { findingNumber, findingState, shortDateTime } from './audit-wording';

/** What the auditor asks for in a finding's answer box. */
export interface FindingReply {
  finding: Finding;
  text: string;
  close: 'agreed' | 'mistake' | null;
}

/** One message in the thread as the screen shows it. */
interface Message {
  by: string;
  role: string;
  at: string;
  kind: string;
  text: string;
  closing: boolean;
}

/**
 * A finding as a thread (API-680): why it was raised, every auditor's answer, and how it ended.
 * While it is open, an auditor may answer it, or answer and close it as resolved by agreement or
 * raised by mistake. Only auditors answer and close; others read it.
 */
@Component({
  selector: 'app-finding-thread',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="finding" [class.open]="isOpen()">
      <strong>Finding {{ number() }} · {{ state() }}</strong>
      <ol class="thread">
        @for (m of messages(); track $index) {
          <li class="msg" [class.closing]="m.closing">
            <span class="small muted"><strong class="who">{{ m.by }}</strong> · {{ m.role }} · {{ m.at }} · {{ m.kind }}</span>
            <span>{{ m.text }}</span>
          </li>
        }
      </ol>
      @if (isOpen() && canAnswer()) {
        <div class="reply">
          <label class="field">
            <span class="small" style="font-weight:600">Your answer</span>
            <textarea class="input" rows="3" [value]="text()" (input)="typeText($event)"
                      placeholder="Answer the issue. To close the finding, say why: who agreed, when, and what was decided."></textarea>
          </label>
          <fieldset class="outcome">
            <legend class="small muted">If you close it</legend>
            <label class="small"><input type="radio" name="outcome-{{ finding().id }}" [checked]="outcome() === 'agreed'" (change)="outcome.set('agreed')" />
              Resolved by agreement outside the portal, for example in a meeting</label>
            <label class="small"><input type="radio" name="outcome-{{ finding().id }}" [checked]="outcome() === 'mistake'" (change)="outcome.set('mistake')" />
              Raised by mistake, no change needed</label>
          </fieldset>
          <div class="row" style="gap:10px">
            <button type="button" class="btn btn-secondary" [disabled]="empty() || busy()" (click)="send(null)">Add answer</button>
            <button type="button" class="btn btn-primary" [disabled]="empty() || busy()" (click)="send(outcome())">Answer and close</button>
          </div>
          <span class="small muted">Only auditors can answer and close a finding, also auditors appointed by another institution. Closing needs your answer. Your name, role and answer go into the audit.</span>
        </div>
      }
    </article>
  `,
  styles: [`
    .finding { display: flex; flex-direction: column; gap: 8px; border-radius: 8px; padding: 12px 14px; background: var(--color-neutral-100, #f7f9fb); border: 1px solid var(--color-divider); }
    .finding.open { background: var(--warn-bg); border-color: var(--warn-bd); }
    .thread { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .msg { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 6px; background: var(--color-surface); border: 1px solid var(--color-divider); font-size: 13px; }
    .msg.closing { border-color: var(--color-accent); }
    .who { color: var(--color-neutral-900, inherit); }
    .reply { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--warn-bd); }
    .outcome { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .outcome label { display: flex; gap: 8px; align-items: flex-start; }
  `]
})
export class FindingThreadComponent {
  readonly finding = input.required<Finding>();
  /** Whether the signed-in user may answer and close findings (an auditor). */
  readonly canAnswer = input(false);
  /** True while a reply is being sent. */
  readonly busy = input(false);
  readonly reply = output<FindingReply>();

  protected readonly text = signal('');
  protected readonly outcome = signal<'agreed' | 'mistake'>('agreed');

  protected readonly isOpen = computed(() => this.finding().status === 'open');
  protected readonly number = computed(() => findingNumber(this.finding().id));
  protected readonly state = computed(() => findingState(this.finding()));
  protected readonly empty = computed(() => this.text().trim().length < 3);

  protected readonly messages = computed<Message[]>(() => {
    const f = this.finding();
    const out: Message[] = [{ by: f.raisedByName ?? 'An auditor', role: 'Auditor', at: shortDateTime(f.raisedAt), kind: 'raised the finding', text: f.description, closing: false }];
    for (const a of f.answers || []) {
      out.push({ by: a.byName ?? 'An auditor', role: a.role ?? 'Auditor', at: shortDateTime(a.at), kind: 'answered', text: a.text, closing: false });
    }
    if (f.status === 'closed') {
      out.push({ by: f.closedByName ?? 'An auditor', role: 'Auditor', at: shortDateTime(f.closedAt), kind: `answered and closed: ${findingState(f)}`, text: f.closeReason ?? '', closing: true });
    }
    if (f.status === 'resolved') {
      out.push({ by: 'System', role: 'Land records', at: shortDateTime(f.closedAt), kind: findingState(f), text: 'A corrected version was reviewed and committed.', closing: true });
    }
    return out;
  });

  protected typeText(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  protected send(close: 'agreed' | 'mistake' | null): void {
    this.reply.emit({ finding: this.finding(), text: this.text().trim(), close });
    this.text.set('');
  }
}
