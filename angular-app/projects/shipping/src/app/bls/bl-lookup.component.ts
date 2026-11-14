import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import {Router, RouterLink} from '@angular/router';
import {toApiError} from '@lrfe/platform';

import {BlApi} from './bl.api';
import {
  LOOKUP_NOT_FOUND,
  MAX_NUMBER_LENGTH,
  lookupOutcome,
  numberProblem,
  numberQuery,
} from './bl-lookup';
import type {BlListItem} from './bl.model';
import {BL_SHARED_STYLES} from './bl-shared.styles';
import {LatestRequest} from './latest';

/**
 * "Check a B/L by number" on the home (CB-47): the user types a B/L's number and the B/L opens,
 * when their organisation is party to it; when two carriers used the number, the user picks one.
 * Otherwise it is not found, in the same words whether the B/L does not exist or belongs to
 * others (bl-lookup.ts). Only for signed-in users: a check without sign-in is not in this release.
 */
@Component({
  selector: 'app-bl-lookup',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" aria-labelledby="bl-lookup-title">
      <form class="panel-body stack" style="gap:8px" (submit)="find($event)">
        <h2 id="bl-lookup-title">Check a B/L by number</h2>
        <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
          <label class="field">
            <span class="label">B/L number</span>
            <input class="input" name="bl-number" [value]="typed()" (input)="type($event)" [attr.maxlength]="maxLength" autocomplete="off" spellcheck="false" aria-describedby="bl-lookup-status" />
          </label>
          <button type="submit" class="btn btn-secondary" [disabled]="busy()">Check</button>
        </div>
        <!-- present from the start, filled after a search, so that it is read out -->
        <p id="bl-lookup-status" [class]="message() === '' ? 'small muted' : 'note'" role="status" aria-live="polite" style="margin:0">{{ message() || 'Among the B/Ls your organisation is party to.' }}</p>
        @if (choices().length > 0) {
          <ul class="choices" aria-label="B/Ls with that number">
            @for (c of choices(); track c.id) {
              <li><a [routerLink]="['/bls', c.id]">{{ c.label }}</a></li>
            }
          </ul>
        }
      </form>
    </section>
  `,
  styles: [
    BL_SHARED_STYLES,
    `
    .panel-body { padding: 16px; }
    h2 { margin: 0; font-size: 18px; }
    .field { display: grid; gap: 6px; flex: 1 1 260px; max-width: 420px; }
    .field .label { font-weight: 600; font-size: 13px; }
    .note { border: 1px solid var(--color-divider); }
    .choices { margin: 0; padding-left: 20px; }
  `,
  ],
})
export class BlLookupComponent {
  private readonly bls = inject(BlApi);
  private readonly router = inject(Router);
  private readonly latest = new LatestRequest();

  protected readonly maxLength = MAX_NUMBER_LENGTH;
  protected readonly typed = signal('');
  protected readonly busy = signal(false);
  /** What the box says after a search, '' before. */
  protected readonly message = signal('');
  /** The B/Ls to pick from when two carriers used the number. */
  protected readonly choices = signal<BlListItem[]>([]);

  /**
   * Keeps what the user typed.
   * @param event the input's event
   */
  protected type(event: Event): void {
    this.typed.set((event.target as HTMLInputElement).value);
  }

  /**
   * Looks for the B/L of the number typed: opens it, offers the choice, or says not found.
   * @param event the form's submission
   * @return when the answer is shown
   */
  protected async find(event: Event): Promise<void> {
    event.preventDefault();
    this.choices.set([]);
    const number = numberQuery(this.typed());
    if (number === null) {
      this.message.set(numberProblem(this.typed()) ?? '');
      return;
    }
    const request = this.latest.begin();
    this.busy.set(true);
    this.message.set('');
    try {
      const items = await this.bls.findByNumber(number);
      if (!this.latest.isCurrent(request)) {
        return;
      }
      const outcome = lookupOutcome(items);
      if (outcome.kind === 'open') {
        await this.router.navigate(['/bls', outcome.id]);
      } else if (outcome.kind === 'choose') {
        this.message.set(
          `${outcome.items.length} B/Ls have that number, from different carriers: pick one.`,
        );
        this.choices.set(outcome.items);
      } else {
        this.message.set(LOOKUP_NOT_FOUND);
      }
    } catch (e) {
      if (this.latest.isCurrent(request)) {
        this.message.set(toApiError(e).message);
      }
    } finally {
      if (this.latest.isCurrent(request)) {
        this.busy.set(false);
      }
    }
  }
}
