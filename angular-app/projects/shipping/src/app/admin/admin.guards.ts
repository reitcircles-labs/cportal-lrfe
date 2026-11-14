import {inject} from '@angular/core';
import {Router, type CanActivateFn} from '@angular/router';
import {AuthService} from '@lrfe/platform';
import {homeRedirect, mayOnboard} from './onboarding';

/**
 * The onboarding screens' guard (CB-43): only a user with every permission they use
 * (ONBOARDING_PERMS); anyone else is shown the refusal page.
 * @return true, or the refusal page
 */
export const onboardingGuard: CanActivateFn = () => {
  if (mayOnboard(inject(AuthService).perms())) {
    return true;
  }
  return inject(Router).createUrlTree(['/denied']);
};

/**
 * The home's guard (CB-43): an administrator who reads no B/Ls is sent to the organisations
 * (homeRedirect); everyone else sees the B/L list.
 * @return true, or where the user goes instead
 */
export const homeGuard: CanActivateFn = () => {
  const target = homeRedirect(inject(AuthService).perms());
  if (target) {
    return inject(Router).parseUrl(target);
  }
  return true;
};
