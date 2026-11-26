import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import {IconComponent} from './icon.component';

/** A one-time setup code as the administrator gets it from "Reset 2FA" or "Give setup code". */
export interface GivenSetupCode {
  /** The user's name. */
  name: string;
  /** The code, XXXX-XXXX. */
  setupCode: string;
  /** Until when it works (ISO time). */
  expiresAt: string;
}

/**
 * The one-time setup code an administrator gives a user (CB-102), shown once: it is gone when the
 * dialog closes. Shared by the land Users screen and the shipping organisation page.
 */
@Component({
  selector: 'app-setup-code-dialog',
  imports: [IconComponent],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="setup-code-title" style="width:min(460px,100%)">
        <div class="dialog-title" id="setup-code-title">Setup code for {{ given().name }}</div>
        <div class="code-row">
          <code class="code">{{ given().setupCode }}</code>
          <button class="btn btn-secondary" type="button" aria-label="Copy setup code" (click)="copy()">@if (copied()) { <app-icon name="check" [size]="16" /> }{{ copied() ? 'Copied' : 'Copy' }}</button>
        </div>
        <div class="note">Shown only once. Valid for {{ hours() }} hours and for one setup. Give it to {{ given().name }} yourself, in person or by phone. Don't send it by email.</div>
        <div class="dialog-actions"><button class="btn btn-primary" type="button" (click)="done.emit()">Done</button></div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .code-row { display: flex; align-items: center; gap: 10px; margin: 6px 0 2px; }
    .code { font-family: ui-monospace, monospace; font-size: 26px; font-weight: 600; letter-spacing: .14em; }
    .note { font-size: 13.5px; padding: 10px 12px; border-radius: 8px; background: var(--warn-bg); }
  `,
  ],
})
export class SetupCodeDialogComponent {
  /** The code to show. */
  readonly given = input.required<GivenSetupCode>();
  /** The administrator closed the dialog: the code is not shown again. */
  readonly done = output<void>();

  protected readonly copied = signal(false);
  /** How long the code works, in whole hours, from its expiry. */
  protected readonly hours = computed(() =>
    Math.round((Date.parse(this.given().expiresAt) - Date.now()) / 3_600_000),
  );

  @HostListener('document:keydown.escape') protected esc(): void {
    this.done.emit();
  }

  /** Copies the code to the clipboard. */
  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.given().setupCode);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      /* clipboard blocked: the code stays on the screen to copy by hand */
    }
  }
}
