import {Injectable, inject} from '@angular/core';
import {
  HttpClient,
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpParams,
} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';

/**
 * Requests marked with this skip the interceptor's refresh-and-retry (the auth calls themselves).
 */
export const NO_AUTH_RETRY = new HttpContextToken<boolean>(() => false);

/** Query string values; empty ones (undefined, null, '') are left out. */
type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** Error shape of every backend service: { status, message, details? }. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // The details' shape depends on the endpoint; callers read the fields they expect.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public details?: any,
  ) {
    super(message);
  }
}

/**
 * Thin promise-based client for the backend gateway. All paths are relative to /api, which the
 * dev server proxies to the gateway (proxy.conf.json), so the browser sees a single origin and
 * the httpOnly refresh cookie (path /api/auth) is sent automatically.
 */
@Injectable({providedIn: 'root'})
export class ApiService {
  private http = inject(HttpClient);
  readonly base = '/api';

  get<T>(path: string, params?: QueryParams) {
    return this.send<T>(
      this.http.get<T>(this.base + path, {params: toParams(params)}),
    );
  }
  post<T>(path: string, body: unknown = {}, opts: {noRetry?: boolean} = {}) {
    return this.send<T>(
      this.http.post<T>(this.base + path, body, {
        context: new HttpContext().set(NO_AUTH_RETRY, !!opts.noRetry),
      }),
    );
  }
  put<T>(path: string, body: unknown) {
    return this.send<T>(this.http.put<T>(this.base + path, body));
  }
  patch<T>(path: string, body: unknown) {
    return this.send<T>(this.http.patch<T>(this.base + path, body));
  }
  delete<T>(path: string, params?: QueryParams) {
    return this.send<T>(
      this.http.delete<T>(this.base + path, {params: toParams(params)}),
    );
  }

  private async send<T>(obs: import('rxjs').Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(obs);
    } catch (e) {
      throw toApiError(e);
    }
  }
}

/** Any error from a request as an ApiError, with a message that can be shown. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) {
      return new ApiError(
        0,
        'The server cannot be reached. Is the backend running?',
      );
    }
    const body = e.error && typeof e.error === 'object' ? e.error : null;
    return new ApiError(
      e.status,
      body?.message || e.statusText || 'Request failed',
      body?.details,
    );
  }
  return new ApiError(0, (e as Error)?.message || 'Unexpected error');
}

function toParams(params?: QueryParams) {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
  }
  return p;
}
