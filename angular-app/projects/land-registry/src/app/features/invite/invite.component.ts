import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import {ActivatedRoute, Router, RouterLink} from '@angular/router';
import {
  ApiService,
  AuthenticatorEnrolComponent,
  IconComponent,
  SiteConfigService,
} from '@lrfe/platform';

const MIN_LENGTH = 12;

/** The steps of the page: the password, the authenticator (CB-102), done. */
type Step = 'password' | 'authenticator' | 'done';

/** What identity answers to the password: active, or the authenticator to set up first. */
interface Acceptance {
  email: string;
  next?: 'mfa-enroll';
  secret?: string;
  otpauthUrl?: string;
}

/**
 * #/invite?token=… — the link from an invitation: choose a password, then, when two-factor
 * sign-in is required, set up the authenticator on the same page before the link is used up
 * (CB-102: the link is the proof the password alone is not).
 */
@Component({
  selector: 'app-invite',
  imports: [AuthenticatorEnrolComponent, IconComponent, RouterLink],
  template: `
    <div class="wrap">
      @if (step() === 'password') {
        <form class="card" (submit)="$event.preventDefault(); submit()">
          <div class="flag" aria-hidden="true"></div>
          <div class="stack" style="gap:4px">
            <span class="card-kicker">{{ site.fullName() }}</span>
            <h2 style="margin:0">Activate your account</h2>
            <span class="muted" style="font-size:14px">Choose a password.</span>
          </div>
          @if (!token) {
            <div class="err">This link has no invitation token. Open the full link from your invitation, or ask an administrator to resend it.</div>
          } @else {
            <div class="field"><label for="pw">New password</label><input id="pw" class="input" type="password" autocomplete="new-password" [value]="pw()" (input)="pw.set($any($event.target).value)" required autofocus></div>
            <div class="field"><label for="pw2">Repeat password</label><input id="pw2" class="input" type="password" autocomplete="new-password" [value]="pw2()" (input)="pw2.set($any($event.target).value)" required></div>
            <span class="small" [style.color]="pw().length >= min ? 'var(--success)' : 'var(--color-neutral-700)'">At least {{ min }} characters · a short sentence works well</span>
            @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
            <button class="btn btn-primary" type="submit" [disabled]="!valid() || busy()" style="min-height:44px"><app-icon name="lock" [size]="17" />{{ busy() ? 'Checking…' : 'Continue' }}</button>
          }
          <a routerLink="/login" class="small" style="text-align:center">Back to sign in</a>
        </form>
      }

      @if (step() === 'authenticator') {
        <form class="card" (submit)="$event.preventDefault(); activate()">
          <div class="flag" aria-hidden="true"></div>
          <div class="stack" style="gap:4px">
            <span class="card-kicker">{{ site.fullName() }}</span>
            <h2 style="margin:0">Set up your authenticator</h2>
            <span class="muted" style="font-size:14px">Two-factor sign-in is required. Scan this code with your authenticator app, then enter the 6-digit code it shows.</span>
          </div>
          <app-authenticator-enrol [secret]="secret()" [otpauthUrl]="otpauthUrl()" />
          <div class="field"><label for="code">6-digit code</label><input id="code" class="input code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" [value]="code()" (input)="onCode($any($event.target))" required autofocus></div>
          @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
          <button class="btn btn-primary" type="submit" [disabled]="busy() || code().length !== 6" style="min-height:44px"><app-icon name="lock" [size]="17" />{{ busy() ? 'Activating…' : 'Activate account' }}</button>
        </form>
      }

      @if (step() === 'done') {
        <div class="card">
          <div class="flag" aria-hidden="true"></div>
          <div class="stack" style="gap:4px">
            <span class="card-kicker">{{ site.fullName() }}</span>
            <h2 style="margin:0">Your account is ready</h2>
            <span class="muted" style="font-size:14px">Password and authenticator are set. Sign in with both from now on.</span>
          </div>
          <button class="btn btn-primary" type="button" style="min-height:44px" (click)="toSignIn()">Go to sign-in</button>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--color-bg); }
    .card { width: min(440px, 100%); padding: 0 32px 28px; gap: 16px; box-shadow: var(--shadow-md); overflow: hidden; }
    .flag { height: 6px; margin: 0 -32px 8px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); }
    .err { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
    .code { font-size: 22px; letter-spacing: .3em; text-align: center; font-variant-numeric: tabular-nums; }
  `,
  ],
})
export class InviteComponent {
  private api = inject(ApiService);
  site = inject(SiteConfigService);
  private router = inject(Router);
  token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  min = MIN_LENGTH;
  pw = signal('');
  pw2 = signal('');
  readonly step = signal<Step>('password');
  /** The email of the account, for the sign-in screen. */
  private email = '';
  /** The authenticator to set up, from identity's answer to the password. */
  protected readonly secret = signal('');
  protected readonly otpauthUrl = signal('');
  readonly code = signal('');
  busy = signal(false);
  error = signal('');
  valid = computed(
    () => this.pw().length >= MIN_LENGTH && this.pw() === this.pw2(),
  );

  async submit() {
    if (!this.valid()) {
      this.error.set(
        this.pw() !== this.pw2()
          ? 'The passwords do not match.'
          : `Use at least ${MIN_LENGTH} characters.`,
      );
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const res = await this.api.post<Acceptance>(
        '/invitations/accept',
        {token: this.token, password: this.pw()},
        {noRetry: true},
      );
      this.email = res.email;
      if (res.next === 'mfa-enroll') {
        this.secret.set(res.secret ?? '');
        this.otpauthUrl.set(res.otpauthUrl ?? '');
        this.code.set('');
        this.step.set('authenticator');
        return;
      }
      // two-factor sign-in not required: active now, as before CB-102
      this.router.navigate(['/login'], {
        queryParams: {email: res.email, activated: 1},
      });
    } catch (e) {
      this.error.set((e as Error)?.message || 'Activation failed');
    } finally {
      this.busy.set(false);
    }
  }

  /** The authenticator's code activates the account, with the authenticator set up. */
  async activate() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post<Acceptance>(
        '/invitations/accept',
        {token: this.token, password: this.pw(), code: this.code()},
        {noRetry: true},
      );
      this.step.set('done');
    } catch (e) {
      this.error.set((e as Error)?.message || 'Activation failed');
      this.code.set('');
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Keeps only the digits of the code as typed.
   * @param input the code field
   */
  onCode(input: HTMLInputElement) {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = digits;
    this.code.set(digits);
  }

  /** The sign-in screen, with the account's email filled in. */
  toSignIn() {
    this.router.navigate(['/login'], {queryParams: {email: this.email}});
  }
}
