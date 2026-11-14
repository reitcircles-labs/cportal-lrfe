import {computed, inject, type Signal} from '@angular/core';
import {AuthService} from '@lrfe/platform';
import type {Viewer} from './bl.model';

/**
 * The signed-in user's organisation, as the B/L screens name it. Call in an injection context.
 * @return the viewer, following the session
 */
export function injectViewer(): Signal<Viewer> {
  const auth = inject(AuthService);
  return computed(() => {
    const user = auth.me()?.user;
    return {
      organisationId: user?.organisationId ?? null,
      organisation: user?.organisation ?? '',
    };
  });
}
