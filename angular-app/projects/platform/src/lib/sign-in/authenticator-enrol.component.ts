import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
} from '@angular/core';

/**
 * Adding an account to an authenticator app: the QR code, a link for an app on this device and
 * the setup key to type. Shared by the sign-in screen and the invitation page (CB-102). The QR
 * code is drawn in the browser, so the secret never leaves it; if it cannot be drawn, the setup
 * key is shown open instead.
 */
@Component({
  selector: 'app-authenticator-enrol',
  template: `
    <div class="enrol">
      @if (qr()) {
        <span class="small"><b>1.</b> In your authenticator app, add an account and <b>scan this QR code</b>.</span>
        <img class="qr" [src]="qr()" width="200" height="200" alt="QR code that adds this account to an authenticator app">
        <a class="small" [href]="otpauthUrl()">On this phone? Open it in the authenticator app instead</a>
      }
      <details class="manual" [open]="!qr()">
        <summary class="small">{{ qr() ? "Can't scan? Type the setup key instead" : 'Type this setup key into your authenticator app' }}</summary>
        <div class="stack" style="gap:6px;margin-top:8px">
          <span class="small muted">Choose “enter a setup key”; type: time-based</span>
          <div class="row" style="gap:8px;align-items:center;flex-wrap:nowrap">
            <code class="key">{{ groupedSecret() }}</code>
            <button class="btn btn-secondary" type="button" style="flex:none" (click)="copyKey()">{{ copied() ? 'Copied' : 'Copy' }}</button>
          </div>
          @if (!qr()) { <a class="small" [href]="otpauthUrl()">Open in an authenticator app on this device</a> }
        </div>
      </details>
      <span class="small"><b>2.</b> Enter the 6-digit code the app shows.</span>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .enrol { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px dashed var(--color-neutral-400); border-radius: 10px; }
    .key { font-family: ui-monospace, monospace; font-size: 17px; letter-spacing: .06em; overflow-wrap: anywhere; }
    /* always dark on white with a quiet zone, also in dark mode, so every camera can read it */
    .qr { align-self: center; width: 200px; height: 200px; background: #fff; padding: 8px; border-radius: 8px; box-sizing: content-box; image-rendering: pixelated; }
    .manual summary { cursor: pointer; color: var(--color-accent-700); }
  `,
  ],
})
export class AuthenticatorEnrolComponent {
  /** The authenticator secret (base32). */
  readonly secret = input.required<string>();
  /** The otpauth:// link of the secret, which the QR code holds. */
  readonly otpauthUrl = input.required<string>();

  /** The secret in groups of four, easier to type. */
  protected readonly groupedSecret = computed(() =>
    this.secret()
      .replace(/(.{4})/g, '$1 ')
      .trim(),
  );
  /** The otpauth:// link as a QR image (data: URL), or null while (or if not) drawn. */
  protected readonly qr = signal<string | null>(null);
  protected readonly copied = signal(false);

  constructor() {
    effect(() => {
      void this.drawQr(this.otpauthUrl());
    });
  }

  /**
   * Draws the QR code of `url`; if it cannot be drawn, the setup key is shown open instead.
   * @param url the otpauth:// link
   */
  private async drawQr(url: string): Promise<void> {
    this.qr.set(null);
    try {
      // loaded only for enrolment, not with the app. qrcode is a CommonJS package: depending on how it
      // is bundled its functions are named exports or sit on `default` (the dev server in CI mode).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qrcode: any = await import('qrcode');
      const toDataURL: typeof import('qrcode').toDataURL =
        qrcode.toDataURL ?? qrcode.default?.toDataURL;
      const image = await toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 0,
        width: 400,
        color: {dark: '#000000', light: '#ffffff'},
      });
      if (this.otpauthUrl() === url) {
        this.qr.set(image);
      }
    } catch {
      /* fallback: the setup key */
    }
  }

  /** Copies the setup key to the clipboard. */
  protected async copyKey(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.secret());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      /* clipboard blocked (e.g. plain http on a non-localhost address): the key stays visible to copy by hand */
    }
  }
}
