import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../../api/api.service';
import { IconComponent } from '../../shared/icon.component';

const MIN_LENGTH = 12;

/** #/invite?token=… — the link from an invitation: choose a password, then sign in (and enrol MFA). */
@Component({
  selector: 'app-invite',
  standalone: true,
  imports: [IconComponent, RouterLink],
  template: `
    <div class="wrap">
      <form class="card" (submit)="$event.preventDefault(); submit()">
        <div class="flag" aria-hidden="true"></div>
        <div class="stack" style="gap:4px">
          <span class="card-kicker">Deeds Registry · Republic of Namibia</span>
          <h2 style="margin:0">Activate your account</h2>
          <span class="muted" style="font-size:14px">Choose a password. You will set up an authenticator app when you first sign in.</span>
        </div>
        @if (!token) {
          <div class="err">This link has no invitation token. Open the full link from your invitation, or ask an administrator to resend it.</div>
        } @else {
          <div class="field"><label for="pw">New password</label><input id="pw" class="input" type="password" autocomplete="new-password" [value]="pw()" (input)="pw.set($any($event.target).value)" required autofocus></div>
          <div class="field"><label for="pw2">Repeat password</label><input id="pw2" class="input" type="password" autocomplete="new-password" [value]="pw2()" (input)="pw2.set($any($event.target).value)" required></div>
          <span class="small" [style.color]="pw().length >= min ? 'var(--success)' : 'var(--color-neutral-700)'">At least {{ min }} characters · a short sentence works well</span>
          @if (error()) { <div class="err" role="alert">{{ error() }}</div> }
          <button class="btn btn-primary" type="submit" [disabled]="!valid() || busy()" style="min-height:44px"><app-icon name="lock" [size]="17" />{{ busy() ? 'Activating…' : 'Activate account' }}</button>
        }
        <a routerLink="/login" class="small" style="text-align:center">Back to sign in</a>
      </form>
    </div>
  `,
  styles: [`
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--color-bg); }
    .card { width: min(440px, 100%); padding: 0 32px 28px; gap: 16px; box-shadow: var(--shadow-md); overflow: hidden; }
    .flag { height: 6px; margin: 0 -32px 8px; background: linear-gradient(100deg, var(--nam-blue) 0 38%, #fff 38% 41%, var(--nam-red) 41% 59%, #fff 59% 62%, var(--nam-green) 62% 100%); }
    .err { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-bd); font-size: 13.5px; }
  `]
})
export class InviteComponent {
  private api = inject(ApiService);
  private router = inject(Router);
  token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');
  min = MIN_LENGTH;
  pw = signal('');
  pw2 = signal('');
  busy = signal(false);
  error = signal('');
  valid = computed(() => this.pw().length >= MIN_LENGTH && this.pw() === this.pw2());

  async submit() {
    if (!this.valid()) {
      this.error.set(this.pw() !== this.pw2() ? 'The passwords do not match.' : `Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    this.busy.set(true); this.error.set('');
    try {
      const { email } = await this.api.post<{ email: string }>('/invitations/accept', { token: this.token, password: this.pw() }, { noRetry: true });
      this.router.navigate(['/login'], { queryParams: { email, activated: 1 } });
    } catch (e: any) {
      this.error.set(e?.message || 'Activation failed');
    } finally { this.busy.set(false); }
  }
}
