import {AppError} from '@lrfe/common';

/** How long a call to identity may take. */
const TIMEOUT_MS = 10_000;

/**
 * The shipping records service's client of identity (CB-34): whether an organisation is
 * registered and active, asked as the pack's record service, before a B/L goes to it.
 *
 *   standingOf(id)  'active' (identity answers its status Active), 'inactive' (any other
 *                   status), 'unknown' (identity knows no such organisation, 404, or the text
 *                   is no organisation id, 400); rejects with 503 when identity cannot be
 *                   reached, 502 for any other answer
 * @param {{
 *   baseUrl: string,
 *   serviceToken: function(): string,
 *   fetchImpl?: function(string, !Object): !Promise<!Response>,
 *   timeoutMs?: number,
 * }} options `baseUrl`: the identity service (IDENTITY_URL); `serviceToken`: this service's token
 * @return {{standingOf: function(string): !Promise<string>}}
 */
export function createIdentityClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  return {
    /**
     * The standing of an organisation on the platform.
     * @param {string} id the organisation's id
     * @return {!Promise<string>} 'active', 'inactive' or 'unknown'
     */
    async standingOf(id) {
      const url = `${baseUrl}/organisations/${encodeURIComponent(id)}/standing`;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: {authorization: `Bearer ${serviceToken()}`},
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AppError(
          503,
          `The identity service cannot be reached: ${error.message}`,
        );
      }
      if (res.status === 404 || res.status === 400) {
        return 'unknown';
      }
      if (!res.ok) {
        throw new AppError(
          502,
          `The identity service answered ${res.status} to a standing request`,
        );
      }
      const {status} = await res.json();
      if (status === 'Active') {
        return 'active';
      }
      return 'inactive';
    },
  };
}
