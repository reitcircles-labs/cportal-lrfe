import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { NO_AUTH_RETRY } from './api.service';
import { AuthService } from '../state/auth.service';

const withToken = (req: HttpRequest<unknown>, token: string | null) =>
  token ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } }) : req;

/**
 * Adds the access token to /api calls. On a 401 it refreshes the session once (httpOnly cookie)
 * and retries; if the refresh also fails, the session has ended (idle timeout, suspension,
 * sign-out elsewhere) and the user is sent to the sign-in page.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const auth = inject(AuthService);
  return next(withToken(req, auth.token())).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401 || req.context.get(NO_AUTH_RETRY) || !auth.signedIn()) {
        return throwError(() => err);
      }
      return from(auth.refresh()).pipe(
        switchMap(ok => {
          if (!ok) {
            auth.expire();
            return throwError(() => err);
          }
          return next(withToken(req, auth.token()));
        })
      );
    })
  );
};
