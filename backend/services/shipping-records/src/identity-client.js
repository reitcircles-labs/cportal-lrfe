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
 *   nameOf(id)      the organisation's name (CB-42, the same route), null when identity knows
 *                   none; rejects as standingOf does
 *   activeOrganisations()  the organisations registered and active, {id, code, name} each
 *                   (CB-44, GET /organisations/active): whom a new B/L may name; rejects with
 *                   503 when identity cannot be reached, 502 for any answer but 200
 * @param {{
 *   baseUrl: string,
 *   serviceToken: function(): string,
 *   fetchImpl?: function(string, !Object): !Promise<!Response>,
 *   timeoutMs?: number,
 * }} options `baseUrl`: the identity service (IDENTITY_URL); `serviceToken`: this service's token
 * @return {{
 *   standingOf: function(string): !Promise<string>,
 *   nameOf: function(string): !Promise<?string>,
 *   activeOrganisations: function(): !Promise<!Array<{id: string, code: string, name: string}>>,
 * }}
 */
export function createIdentityClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  /**
   * Asks identity with this service's token: its raw answer; rejects with 503 when identity
   * cannot be reached.
   * @param {string} path
   * @return {!Promise<!Response>}
   */
  async function ask(path) {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
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
  }

  /**
   * Identity's answer about an organisation, `{id, status, name}`, or null when it knows none (404,
   * or 400 for a text that is no organisation id); rejects with 503 when identity cannot be
   * reached, 502 for any other answer.
   * @param {string} id the organisation's id
   * @return {!Promise<?{status: string, name: (string|undefined)}>}
   */
  async function askStanding(id) {
    const res = await ask(`/organisations/${encodeURIComponent(id)}/standing`);
    if (res.status === 404 || res.status === 400) {
      return null;
    }
    if (!res.ok) {
      throw new AppError(
        502,
        `The identity service answered ${res.status} to a standing request`,
      );
    }
    return res.json();
  }

  return {
    /**
     * The standing of an organisation on the platform.
     * @param {string} id the organisation's id
     * @return {!Promise<string>} 'active', 'inactive' or 'unknown'
     */
    async standingOf(id) {
      const answer = await askStanding(id);
      if (answer === null) {
        return 'unknown';
      }
      if (answer.status === 'Active') {
        return 'active';
      }
      return 'inactive';
    },
    /**
     * The name of an organisation (CB-42), for the parties of a B/L.
     * @param {string} id the organisation's id
     * @return {!Promise<?string>} its name, null for an organisation identity does not know
     */
    async nameOf(id) {
      const answer = await askStanding(id);
      if (answer === null || typeof answer.name !== 'string') {
        return null;
      }
      return answer.name;
    },
    /**
     * The organisations registered and active on the platform (CB-44), whom a new B/L may name.
     * @return {!Promise<!Array<{id: string, code: string, name: string}>>}
     */
    async activeOrganisations() {
      const res = await ask('/organisations/active');
      if (!res.ok) {
        throw new AppError(
          502,
          `The identity service answered ${res.status} to a list of organisations`,
        );
      }
      const {organisations} = await res.json();
      return organisations.map(o => ({id: o.id, code: o.code, name: o.name}));
    },
  };
}
