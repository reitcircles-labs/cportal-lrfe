import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
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
import {SHIPPING} from './product';

/** The shipping app's providers: the platform's sign-in and site settings, and its routes. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideProduct(SHIPPING),
    provideZoneChangeDetection({eventCoalescing: true}),
    provideRouter(routes, withHashLocation()),
    provideHttpClient(withXhr(), withInterceptors([authInterceptor])),
    // resume the session from the refresh cookie, if any, before the first route resolves
    provideAppInitializer(() => inject(AuthService).restore()),
    provideAppInitializer(() => inject(SiteConfigService).load()),
  ],
};
