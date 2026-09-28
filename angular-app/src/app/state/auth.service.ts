import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

export interface Role { id: string; label: string; name: string; initials: string; home: string; office: string; }

export const ROLES: Role[] = [
  { id: 'sup', label: 'Registrar (supervisor)', name: 'E. Shivute', initials: 'ES', home: '/', office: 'Deeds Registry · Windhoek' },
  { id: 'scan', label: 'Scan operator', name: 'K. Iipinge', initials: 'KI', home: '/capture', office: 'Registry floor 2' },
  { id: 'rev', label: 'Metadata reviewer', name: 'A. Mwandingi', initials: 'AM', home: '/verify', office: 'Review desk' },
  { id: 'rec', label: 'Records officer', name: 'J. !Gawaseb', initials: 'JG', home: '/link', office: 'Records desk' },
  { id: 'aud', label: 'Auditor · read-only', name: 'M. Nakale', initials: 'MN', home: '/audit', office: 'Office of the Auditor-General' }
];

const KEY = 'lr-demo-role';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private router = inject(Router);
  readonly roleId = signal<string | null>(localStorage.getItem(KEY));
  readonly role = computed(() => ROLES.find(r => r.id === this.roleId()) || null);
  readonly signedIn = computed(() => !!this.role());

  login(roleId: string) {
    this.roleId.set(roleId);
    localStorage.setItem(KEY, roleId);
    this.router.navigateByUrl(this.role()!.home);
  }
  switchRole(roleId: string) { this.login(roleId); }
  logout() {
    this.roleId.set(null);
    localStorage.removeItem(KEY);
    this.router.navigateByUrl('/login');
  }
}

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.signedIn() ? true : inject(Router).createUrlTree(['/login']);
};
