import { APP_INITIALIZER, ApplicationConfig, inject, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './api/auth.interceptor';
import { AuthService } from './state/auth.service';

/** Before the first route resolves: resume the session from the refresh cookie, if any. */
function restoreSession() {
  const auth = inject(AuthService);
  return () => auth.restore();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withHashLocation()),
    provideHttpClient(withInterceptors([authInterceptor])),
    { provide: APP_INITIALIZER, useFactory: restoreSession, multi: true }
  ]
};
