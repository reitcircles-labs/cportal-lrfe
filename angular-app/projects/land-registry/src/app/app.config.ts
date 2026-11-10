import {
  ApplicationConfig,
  inject,
  provideZoneChangeDetection,
  provideAppInitializer,
} from '@angular/core';
import {provideRouter, withHashLocation} from '@angular/router';
import {
  provideHttpClient,
  withInterceptors,
  withXhr,
} from '@angular/common/http';
import {
  AuthService,
  SiteConfigService,
  authInterceptor,
  provideProduct,
} from '@lrfe/platform';
import {routes} from './app.routes';
import {LAND_REGISTRY} from './product';

/** Before the first route resolves: resume the session from the refresh cookie, if any. */
function restoreSession() {
  const auth = inject(AuthService);
  return () => auth.restore();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideProduct(LAND_REGISTRY),
    provideZoneChangeDetection({eventCoalescing: true}),
    provideRouter(routes, withHashLocation()),
    provideHttpClient(withXhr(), withInterceptors([authInterceptor])),
    provideAppInitializer(() => {
      const initializerFn = restoreSession();
      return initializerFn();
    }),
    // the organisation's name and texts, from the site's settings (API-712)
    provideAppInitializer(() => inject(SiteConfigService).load()),
  ],
};
