import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ApiService } from '../api/api.service';

/** Shape the shell and screens use for "who is signed in" (kept from the demo). */
export interface Role { id: string; label: string; name: string; initials: string; home: string; office: string; }

/** GET /api/auth/me, and the `me` part of every sign-in / refresh response. */
export interface Me {
  user: { id: string; name: string; email: string; office: string; roles: string[]; status: string; mfa: boolean; lastActive: string | null; conflicts: string[] };
  roles: { id: string; label: string; home: string }[];
  perms: string[];
  home: string;
  policies: { timeout: number; fourEyes: boolean };
}
interface Session { accessToken: string; expiresIn: number; me: Me; }

/** Result of the password step: signed in, or a second (MFA) step is needed. */
export type LoginStep =
  | { next: 'done' }
  | { next: 'mfa'; challenge: string }
  | { next: 'mfa-enroll'; challenge: string; secret: string; otpauthUrl: string };

const initials = (name: string) => name.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();

/**
 * Real sign-in against the identity service (via the gateway):
 *  - password, then an authenticator code (or first-time MFA enrolment when policy requires it)
 *  - the access token lives only in memory; the refresh token is an httpOnly cookie
 *  - on page load the session is restored from the cookie (restore())
 *  - the token is refreshed shortly before it expires, but only if the user has been active,
 *    so the server's idle-timeout policy still signs out an unattended browser
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(ApiService);
  private router = inject(Router);

  readonly token = signal<string | null>(null);
  readonly me = signal<Me | null>(null);
  readonly signedIn = computed(() => !!this.me());
  readonly perms = computed(() => this.me()?.perms ?? []);
  /** Primary role id (first assigned role). */
  readonly roleId = computed(() => this.me()?.roles[0]?.id ?? null);
  readonly role = computed<Role | null>(() => {
    const me = this.me();
    if (!me) return null;
    return {
      id: me.roles[0]?.id ?? '', label: me.roles.map(r => r.label).join(' + ') || 'No role', name: me.user.name,
      initials: initials(me.user.name), home: me.home || '/', office: me.user.office
    };
  });

  private refreshTimer: any;
  private refreshing: Promise<boolean> | null = null;
  private lastActivity = Date.now();
  private lastRefresh = Date.now();

  constructor() {
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, () => { this.lastActivity = Date.now(); }, { passive: true });
    }
  }

  /** Called once at start-up: resume a session from the refresh cookie, if there is one. */
  async restore(): Promise<void> {
    await this.refresh();
  }

  async login(email: string, password: string): Promise<LoginStep> {
    const res = await this.api.post<any>('/auth/login', { email, password }, { noRetry: true });
    if (res.accessToken) {
      this.start(res);
      return { next: 'done' };
    }
    return res as LoginStep;
  }

  async verifyMfa(challenge: string, code: string): Promise<void> {
    this.start(await this.api.post<Session>('/auth/mfa', { challenge, code }, { noRetry: true }));
  }

  /** Rotate the session. Concurrent callers share one request. Resolves false if the session is over. */
  refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = this.api.post<Session>('/auth/refresh', {}, { noRetry: true })
        .then(s => { this.start(s); return true; })
        .catch(() => { this.clear(); return false; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** Re-read /auth/me (e.g. after an admin changed this user's roles). */
  async reloadMe() {
    this.me.set(await this.api.get<Me>('/auth/me'));
  }

  async logout() {
    try { await this.api.post('/auth/logout', {}, { noRetry: true }); } catch { /* signed out locally regardless */ }
    this.clear();
    this.router.navigateByUrl('/login');
  }

  /** The server ended the session (idle timeout, suspension): back to sign-in, keeping the target URL. */
  expire() {
    if (!this.me()) return;
    this.clear();
    this.router.navigate(['/login'], { queryParams: { expired: 1, returnUrl: this.router.url } });
  }

  private start(s: Session) {
    this.token.set(s.accessToken);
    this.me.set(s.me);
    this.lastRefresh = Date.now();
    clearTimeout(this.refreshTimer);
    // Refresh a minute before expiry, if the user did something since the last refresh.
    this.refreshTimer = setTimeout(() => {
      if (this.lastActivity > this.lastRefresh) this.refresh();
    }, Math.max(10, s.expiresIn - 60) * 1000);
  }

  private clear() {
    clearTimeout(this.refreshTimer);
    this.token.set(null);
    this.me.set(null);
  }
}

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  return auth.signedIn() ? true : inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
