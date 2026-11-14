import {inject} from '@angular/core';
import {Router, type CanActivateFn} from '@angular/router';
import {AuthService} from '@lrfe/platform';
import {mayDraft} from './bl-actions';

/**
 * The new B/L screen's guard (CB-44): only a user who drafts B/Ls; anyone else is shown the
 * refusal page.
 * @return true, or the refusal page
 */
export const draftGuard: CanActivateFn = () => {
  if (mayDraft(inject(AuthService).perms())) {
    return true;
  }
  return inject(Router).createUrlTree(['/denied']);
};
