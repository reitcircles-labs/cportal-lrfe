import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import {ApiError} from '../api/api.service';
import {AuthService} from '../state/auth.service';
import {ThemeService} from '../state/theme.service';
import {IconComponent} from '../shared/icon.component';
import {SiteConfigService} from '../state/site-config.service';
import {PRODUCT_CONFIG} from '../product';
import {AuthenticatorEnrolComponent} from './authenticator-enrol.component';
import {hasLogoPlace} from './logo-place';

/** The steps of the sign-in form. */
type Step = 'password' | 'setup-code' | 'mfa' | 'mfa-enroll';

/**
 * Sign-in: password, then the authenticator code. A user without an authenticator enters the
 * setup code an administrator gave, then sets one up (CB-102): the password alone never does.
 */
@Component({
  selector: 'app-login',
  imports: [AuthenticatorEnrolComponent, IconComponent],
  template: `
    <div class="wrap">
      <section class="hero">
        <div class="flag" aria-hidden="true"></div>
        <div class="hero-in">
          <div class="brand">
            @if (showLogoPlace) {
              <span class="arms">@for (line of pitch.logoPlaceholder; track $index) {@if (!$first) {<br>}{{ line }}}</span>
            }
            <span class="stack" style="gap:0"><b>{{ site.config().orgName }}</b>@if (site.config().orgParent) { <span>{{ site.config().orgParent }}</span> }</span>
          </div>
          <div class="pitch">
            <span class="eyebrow">{{ pitch.eyebrow }}</span>
            <h1>{{ pitch.title }}</h1>
            <p>{{ pitch.text }}</p>
          </div>
          <ul class="facts">
            @for (fact of pitch.facts; track fact.lead) {
              <li><app-icon [name]="fact.icon" [size]="18" /><span><b>{{ fact.lead }}</b> {{ fact.text }}</span></li>
            }
          </ul>
          <span class="legal">{{ pitch.legal }}</span>
        </div>
        @if (pitch.picture; as picture) {
          <picture class="picture" aria-hidden="true">
            <source media="(max-width: 960px)" [srcset]="picture.narrow" [width]="picture.narrowSize[0]" [height]="picture.narrowSize[1]">
            <img [src]="picture.wide" [width]="picture.wideSize[0]" [height]="picture.wideSize[1]" alt="">
          </picture>
        }
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
            @if (hasProofCheck) {
              <p class="small muted" style="margin:0;text-align:center">Given a proof by the registry? <a href="#/check-a-proof">Check it yourself</a></p>
            }
          </form>
        }

        @if (step() === 'setup-code') {
          <form class="card" (submit)="$event.preventDefault(); submitSetupCode()">
            <div class="stack" style="gap:4px">
              <h2 style="margin:0">Enter your setup code</h2>
              <span class="muted" style="font-size:14px">Your authenticator isn't set up yet. Enter the setup code your administrator gave you.</span>
            </div>
            <div class="field"><label for="setup-code">Setup code</label><input id="setup-code" class="input code setup" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" [value]="setupCode()" (input)="setupCode.set($any($event.target).value)" required autofocus></div>
            @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
            <button class="btn btn-primary" type="submit" [disabled]="busy() || !setupCode().trim()" style="min-height:44px;font-size:15px">{{ busy() ? 'Checking…' : 'Continue' }}</button>
            <p class="small muted" style="margin:0;text-align:center">No code? Ask your administrator for one.</p>
            <button class="btn btn-ghost" type="button" (click)="restart()">Use a different account</button>
          </form>
        }

        @if (step() === 'mfa' || step() === 'mfa-enroll') {
          <form class="card" (submit)="$event.preventDefault(); submitCode()">
            <div class="stack" style="gap:4px">
              <h2 style="margin:0">{{ step() === 'mfa-enroll' ? 'Set up your authenticator' : 'Enter your code' }}</h2>
              <span class="muted" style="font-size:14px">{{ step() === 'mfa-enroll' ? 'Multi-factor authentication is required. Add this account to an authenticator app (Google Authenticator, Microsoft Authenticator, …), then enter the 6-digit code it shows.' : 'Open your authenticator app and enter the 6-digit code for the ' + site.config().orgName + '.' }}</span>
            </div>
            @if (step() === 'mfa-enroll') {
              <app-authenticator-enrol [secret]="secret()" [otpauthUrl]="otpauthUrl()" />
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
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
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
    /* a product's picture (CB-6): under the texts, as wide as the panel */
    .picture { position: relative; z-index: 1; display: block; line-height: 0; }
    .picture img { display: block; width: 100%; height: auto; }
    .formside { position: relative; display: grid; place-items: center; padding: 40px 24px; background: var(--color-bg); }
    .theme { position: absolute; top: 16px; right: 16px; }
    .card { width: min(420px, 100%); padding: 32px; gap: 18px; box-shadow: var(--shadow-md); }
    .or { display: flex; align-items: center; gap: 12px; color: var(--color-neutral-600); font-size: 12px; }
    .or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--color-divider); }
    .err { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
    .note { padding: 10px 12px; border-radius: 8px; background: var(--color-accent-100); font-size: 13.5px; }
    .note.warn { background: var(--warn-bg); }
    .code { font-size: 22px; letter-spacing: .3em; text-align: center; font-variant-numeric: tabular-nums; }
    .code.setup { letter-spacing: .14em; text-transform: uppercase; font-family: ui-monospace, monospace; }
    @media (max-width: 960px) {
      .wrap { grid-template-columns: 1fr; }
      .hero-in { padding: 28px 24px; gap: 24px; }
      .pitch h1 { font-size: 30px; }
      .facts, .legal { display: none; }
    }
  `,
  ],
})
export class LoginComponent {
  auth = inject(AuthService);
  theme = inject(ThemeService);
  site = inject(SiteConfigService);
  /** The product's presentation beside the form. */
  protected readonly pitch = inject(PRODUCT_CONFIG).signIn;
  /** The logo place, only for a product with lines to show in it (CB-48). */
  protected readonly showLogoPlace = hasLogoPlace(this.pitch);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  /** Whether the app has the public proof check page, which the form links to. */
  protected readonly hasProofCheck = this.router.config.some(
    r => r.path === 'check-a-proof',
  );

  readonly step = signal<Step>('password');
  email = signal('');
  password = signal('');
  /** The administrator's one-time setup code, as typed (CB-102). */
  readonly setupCode = signal('');
  code = signal('');
  busy = signal(false);
  error = signal('');
  notice = signal('');
  noticeWarn = signal(false);
  private challenge = '';
  protected readonly secret = signal('');
  otpauthUrl = signal('');

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('email')) this.email.set(q.get('email')!);
    if (q.get('expired')) {
      this.notice.set('Your session ended. Sign in again to continue.');
      this.noticeWarn.set(true);
    } else if (q.get('activated')) {
      this.notice.set(
        'Your account is active. Sign in with your new password.',
      );
    }
    if (this.auth.signedIn()) this.router.navigateByUrl(this.auth.role()!.home);
  }

  async submitPassword() {
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.auth.login(this.email().trim(), this.password());
      if (res.next === 'done') return this.enter();
      this.challenge = res.challenge;
      this.setupCode.set('');
      this.code.set('');
      this.password.set('');
      this.step.set(res.next);
    } catch (caught) {
      const e = caught as ApiError;
      this.error.set(e?.message || 'Sign-in failed');
    } finally {
      this.busy.set(false);
    }
  }

  /** The setup code (CB-102): the right one leads to setting up the authenticator. */
  async submitSetupCode() {
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.auth.verifySetupCode(
        this.challenge,
        this.setupCode().trim(),
      );
      this.challenge = res.challenge;
      this.secret.set(res.secret);
      this.otpauthUrl.set(res.otpauthUrl);
      this.setupCode.set('');
      this.code.set('');
      this.step.set('mfa-enroll');
    } catch (caught) {
      const e = caught as ApiError;
      if (e?.status === 401 && /expired, start again/i.test(e.message)) {
        this.error.set('That took too long. Start again.');
      } else {
        this.error.set(e?.message || 'Invalid setup code');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async submitCode() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.verifyMfa(this.challenge, this.code());
      this.enter();
    } catch (caught) {
      const e = caught as ApiError;
      this.error.set(
        e?.status === 401 && /expired/i.test(e.message)
          ? 'That took too long. Start again.'
          : e?.message || 'Invalid code',
      );
      this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }

  onCode(input: HTMLInputElement) {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = digits;
    this.code.set(digits);
  }

  restart() {
    this.step.set('password');
    this.code.set('');
    this.error.set('');
    this.challenge = '';
    this.setupCode.set('');
    this.secret.set('');
    this.otpauthUrl.set('');
  }

  private enter() {
    const target = this.route.snapshot.queryParamMap.get('returnUrl');
    this.router.navigateByUrl(
      target && !target.startsWith('/login') ? target : this.auth.role()!.home,
    );
  }
}
