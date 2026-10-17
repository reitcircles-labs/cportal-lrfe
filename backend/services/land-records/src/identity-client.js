import {AppError} from '@lrfe/common';

/**
 * land-records' call to the identity service, with a land-records service token (read only):
 *   policies() → { fourEyes }   the security policies land-records enforces, as set now (API-663)
 */
export function createIdentityClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  return {
    async policies() {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/policies/effective`, {
          method: 'GET',
          headers: {authorization: `Bearer ${serviceToken()}`},
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new AppError(
          503,
          `The security policies cannot be read now: ${err.message}`,
        );
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // not JSON (a proxy's error page): reported by status below
      }
      if (res.status >= 400 || !json) {
        throw new AppError(
          502,
          json?.message ||
            `Reading the security policies failed (${res.status})`,
        );
      }
      return json;
    },
  };
}
