import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../state/auth.service';
import { ThemeService } from '../../state/theme.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
    selector: 'app-login',
    imports: [IconComponent],
    template: `
    <div class="wrap">
      <section class="hero">
        <div class="flag" aria-hidden="true"></div>
        <div class="hero-in">
          <div class="brand">
            <span class="arms">Coat of<br>arms</span>
            <span class="stack" style="gap:0"><b>Deeds Registry</b><span>Ministry of Agriculture, Fisheries, Water and Land Reform</span></span>
          </div>
          <div class="pitch">
            <span class="eyebrow">National land records programme</span>
            <h1>Every erf, every owner, one verified record.</h1>
            <p>Scan and verify historical deeds, link them into land records, and prepare each record for tokenization, with a complete audit trail at every step.</p>
          </div>
          <ul class="facts">
            <li><app-icon name="scan" [size]="18" /><span><b>Capture</b> deeds, grants and SG diagrams</span></li>
            <li><app-icon name="inbox" [size]="18" /><span><b>Verify</b> extracted metadata against the image</span></li>
            <li><app-icon name="link" [size]="18" /><span><b>Link</b> documents into the erf's chain of title</span></li>
            <li><app-icon name="shield" [size]="18" /><span><b>Audit</b> every action, hash-chained</span></li>
          </ul>
          <span class="legal">Restricted system. Access is logged under the Deeds Registries Act 14 of 2015.</span>
        </div>
      </section>

      <section class="formside">
        <button class="btn btn-ghost btn-icon theme" (click)="theme.toggle()" aria-label="Toggle dark mode"><app-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="19" /></button>

        @if (step() === 'password') {
          <form class="card" (submit)="$event.preventDefault(); submitPassword()">
            <div class="stack" style="gap:4px">
              <h2 style="margin:0">Sign in</h2>
              <span class="muted" style="font-size:14px">Use your registry email and password.</span>
            </div>
            @if (notice()) { <div class="note" [class.warn]="noticeWarn()">{{ notice() }}</div> }
            <div class="field"><label for="uid">Email</label><input id="uid" class="input" type="email" autocomplete="username" [value]="email()" (input)="email.set($any($event.target).value)" required autofocus></div>
            <div class="field"><label for="pw">Password</label><input id="pw" class="input" type="password" autocomplete="current-password" [value]="password()" (input)="password.set($any($event.target).value)" required></div>
            @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
            <button class="btn btn-primary" type="submit" [disabled]="busy() || !email() || !password()" style="min-height:44px;font-size:15px"><app-icon name="lock" [size]="17" />{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
            <div class="or"><span>or</span></div>
            <button class="btn btn-secondary" type="button" disabled title="National eID sign-in is not connected yet" style="min-height:44px"><app-icon name="idcard" [size]="18" />Continue with national eID</button>
            <p class="small muted" style="margin:0;text-align:center">New here? Open the invitation link your administrator sent you.</p>
          </form>
        }

        @if (step() === 'mfa' || step() === 'mfa-enroll') {
          <form class="card" (submit)="$event.preventDefault(); submitCode()">
            <div class="stack" style="gap:4px">
              <h2 style="margin:0">{{ step() === 'mfa-enroll' ? 'Set up your authenticator' : 'Enter your code' }}</h2>
              <span class="muted" style="font-size:14px">{{ step() === 'mfa-enroll' ? 'Multi-factor authentication is required. Add this account to an authenticator app (Google Authenticator, Microsoft Authenticator, …), then enter the 6-digit code it shows.' : 'Open your authenticator app and enter the 6-digit code for the Deeds Registry.' }}</span>
            </div>
            @if (step() === 'mfa-enroll') {
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
            }
            <div class="field"><label for="code">6-digit code</label><input id="code" class="input code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" [value]="code()" (input)="onCode($any($event.target))" required autofocus></div>
            @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
            <button class="btn btn-primary" type="submit" [disabled]="busy() || code().length !== 6" style="min-height:44px;font-size:15px">{{ busy() ? 'Checking…' : 'Verify and sign in' }}</button>
            <button class="btn btn-ghost" type="button" (click)="restart()">Use a different account</button>
          </form>
        }
      </section>
    </div>
  `,
    styles: [`
    .wrap { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); }
    .hero { position: relative; background: radial-gradient(120% 90% at 0% 0%, #123a6b 0%, var(--sidebar-bg) 55%, #081a33 100%); color: #dbe5f2; display: flex; flex-direction: column; overflow: hidden; }
    .hero::after { content: ""; position: absolute; right: -120px; bottom: -120px; width: 420px; height: 420px; border-radius: 50%; border: 1px solid rgba(255,206,0,.18); box-shadow: 0 0 0 40px rgba(255,206,0,.04), 0 0 0 80px rgba(255,206,0,.03); pointer-events: none; }
    .flag { height: 8px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); }
    .hero-in { flex: 1; display: flex; flex-direction: column; gap: 40px; padding: 44px 56px; max-width: 640px; position: relative; z-index: 1; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand b { color: #fff; font-size: 18px; }
    .brand span span { font-size: 13px; color: #aebfd6; }
    .arms { width: 56px; height: 56px; flex: none; border-radius: 12px; border: 1px dashed rgba(255,255,255,.4); display: grid; place-items: center; text-align: center; font-size: 10px; line-height: 1.1; background: rgba(255,206,0,.08); }
    .pitch { margin-top: auto; }
    .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--nam-gold); }
    .pitch h1 { color: #fff; font-size: 42px; line-height: 1.1; letter-spacing: -.02em; margin: 12px 0 14px; text-wrap: balance; }
    .pitch p { font-size: 16px; color: #c3d1e4; max-width: 50ch; margin: 0; }
    .facts { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
    .facts li { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: #c3d1e4; }
    .facts app-icon { color: var(--nam-gold); margin-top: 1px; }
    .facts b { color: #fff; }
    .legal { font-size: 12px; color: #8ea3c0; }
    .formside { position: relative; display: grid; place-items: center; padding: 40px 24px; background: var(--color-bg); }
    .theme { position: absolute; top: 16px; right: 16px; }
    .card { width: min(420px, 100%); padding: 32px; gap: 18px; box-shadow: var(--shadow-md); }
    .or { display: flex; align-items: center; gap: 12px; color: var(--color-neutral-600); font-size: 12px; }
    .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--color-divider); }
    .err { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
    .note { padding: 10px 12px; border-radius: 8px; background: var(--color-accent-100); font-size: 13.5px; }
    .note.warn { background: var(--warn-bg); }
    .enrol { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px dashed var(--color-neutral-400); border-radius: 10px; }
    .key { font-family: ui-monospace, monospace; font-size: 17px; letter-spacing: .06em; overflow-wrap: anywhere; }
    /* always dark on white with a quiet zone, also in dark mode, so every camera can read it */
    .qr { align-self: center; width: 200px; height: 200px; background: #fff; padding: 8px; border-radius: 8px; box-sizing: content-box; image-rendering: pixelated; }
    .manual summary { cursor: pointer; color: var(--color-accent-700); }
    .code { font-size: 22px; letter-spacing: .3em; text-align: center; font-variant-numeric: tabular-nums; }
    @media (max-width: 960px) {
      .wrap { grid-template-columns: 1fr; }
      .hero-in { padding: 28px 24px; gap: 24px; }
      .pitch h1 { font-size: 30px; }
      .facts, .legal { display: none; }
    }
  `]
})
export class LoginComponent {
  auth = inject(AuthService);
  theme = inject(ThemeService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  step = signal<'password' | 'mfa' | 'mfa-enroll'>('password');
  email = signal('');
  password = signal('');
  code = signal('');
  busy = signal(false);
  error = signal('');
  notice = signal('');
  noticeWarn = signal(false);
  private challenge = '';
  private secret = signal('');
  otpauthUrl = signal('');
  groupedSecret = computed(() => this.secret().replace(/(.{4})/g, '$1 ').trim());
  /** The otpauth:// link as a QR image (data: URL), drawn in the browser: the secret never leaves it. */
  qr = signal<string | null>(null);
  copied = signal(false);

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('email')) this.email.set(q.get('email')!);
    if (q.get('expired')) { this.notice.set('Your session ended. Sign in again to continue.'); this.noticeWarn.set(true); }
    else if (q.get('activated')) this.notice.set('Your account is active. Sign in with your new password.');
    if (this.auth.signedIn()) this.router.navigateByUrl(this.auth.role()!.home);
  }

  async submitPassword() {
    this.busy.set(true); this.error.set('');
    try {
      const res = await this.auth.login(this.email().trim(), this.password());
      if (res.next === 'done') return this.enter();
      this.challenge = res.challenge;
      if (res.next === 'mfa-enroll') { this.secret.set(res.secret); this.otpauthUrl.set(res.otpauthUrl); this.drawQr(res.otpauthUrl); }
      this.code.set(''); this.password.set('');
      this.step.set(res.next);
    } catch (e: any) {
      this.error.set(e?.message || 'Sign-in failed');
    } finally { this.busy.set(false); }
  }

  async submitCode() {
    this.busy.set(true); this.error.set('');
    try {
      await this.auth.verifyMfa(this.challenge, this.code());
      this.enter();
    } catch (e: any) {
      this.error.set(e?.status === 401 && /expired/i.test(e.message) ? 'That took too long. Start again.' : e?.message || 'Invalid code');
      this.code.set('');
    } finally { this.busy.set(false); }
  }

  onCode(input: HTMLInputElement) {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = digits;
    this.code.set(digits);
  }

  restart() {
    this.step.set('password'); this.code.set(''); this.error.set(''); this.challenge = ''; this.secret.set('');
    this.otpauthUrl.set(''); this.qr.set(null); this.copied.set(false);
  }

  /** If the QR code cannot be drawn, the setup key is shown open instead. */
  private async drawQr(url: string) {
    this.qr.set(null);
    try {
      const { toDataURL } = await import('qrcode');   // loaded only for enrolment, not with the app
      const image = await toDataURL(url, { errorCorrectionLevel: 'M', margin: 0, width: 400, color: { dark: '#000000', light: '#ffffff' } });
      if (this.otpauthUrl() === url) this.qr.set(image);
    } catch { /* fallback: the setup key */ }
  }

  async copyKey() {
    try {
      await navigator.clipboard.writeText(this.secret());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch { /* clipboard blocked (e.g. plain http on a non-localhost address): the key stays visible to copy by hand */ }
  }

  private enter() {
    const target = this.route.snapshot.queryParamMap.get('returnUrl');
    this.router.navigateByUrl(target && !target.startsWith('/login') ? target : this.auth.role()!.home);
  }
}
