import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

/**
 * An (i) button that opens a short explanation on click or keyboard focus and closes when focus
 * leaves it, so it also works on touch screens, where hover tooltips don't (API-678).
 *
 *   <app-info-tip label="proof status" [text]="tips.proofStatus" />
 */
@Component({
  selector: 'app-info-tip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="tip">
      <button type="button" class="dot" [class.on]="open()" [attr.aria-expanded]="open()" [attr.aria-label]="'Explain: ' + label()"
              (click)="open.set(!open())" (blur)="open.set(false)"><span class="ring" aria-hidden="true">i</span></button>
      @if (open()) {
        <span class="box" role="tooltip" [class.right]="align() === 'right'">{{ text() }}</span>
      }
    </span>
  `,
  styles: [`
    .tip { position: relative; display: inline-flex; vertical-align: middle; }
    .dot { width: 32px; height: 32px; padding: 0; border: 0; background: transparent; cursor: pointer; display: inline-grid; place-items: center; }
    .ring { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--color-accent); background: var(--color-surface);
            display: inline-grid; place-items: center; font: italic 700 12px Georgia, serif; color: var(--color-accent-800); }
    .dot.on .ring { background: var(--color-accent); color: #fff; }
    .box { position: absolute; top: 34px; left: -4px; z-index: 40; width: 300px; padding: 12px 14px; border-radius: 8px;
           background: var(--color-neutral-900, #0e1a2b); color: #fff; font: 400 13px/1.45 var(--font-body, inherit);
           text-align: left; text-transform: none; letter-spacing: 0; white-space: pre-line; box-shadow: var(--shadow-md); }
    .box.right { left: auto; right: -4px; }
  `]
})
export class InfoTipComponent {
  /** The term explained, for screen readers ("Explain: …"). */
  readonly label = input.required<string>();
  /** The explanation. */
  readonly text = input.required<string>();
  /** Open the box to the left of the button, near the right edge of a page. */
  readonly align = input<'left' | 'right'>('left');
  protected readonly open = signal(false);
}
