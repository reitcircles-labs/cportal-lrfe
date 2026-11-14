import {AppError} from '@lrfe/common';

/** How long a call to the audit service may take. */
const TIMEOUT_MS = 10_000;

/**
 * The shipping records service's client of the audit service (CB-33): the trail-entry proof of a
 * chain-of-title entry's event, asked as the pack's record service.
 *
 *   entryProof(eventId)  the audit's trail-entry proof (lrfe-audit-proof/1); rejects with 404 while
 *                        the event is not on the trail, 503 when the audit service cannot be
 *                        reached, 502 for any other error answer
 * @param {{
 *   baseUrl: string,
 *   serviceToken: function(): string,
 *   fetchImpl?: function(string, !Object): !Promise<!Response>,
 *   timeoutMs?: number,
 * }} options `baseUrl`: the audit service (AUDIT_URL); `serviceToken`: this service's token
 * @return {{entryProof: function(string): !Promise<!Object>}}
 */
export function createAuditClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  return {
    /**
     * The trail-entry proof of an event.
     * @param {string} eventId
     * @return {!Promise<!Object>}
     */
    async entryProof(eventId) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/audit/anchoring/entry-proof`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({eventId}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AppError(
          503,
          `The audit service cannot be reached: ${error.message}`,
        );
      }
      if (res.status === 404) {
        throw new AppError(404, 'The event is not on the audit trail yet');
      }
      if (!res.ok) {
        throw new AppError(
          502,
          `The audit service answered ${res.status} to a proof request`,
        );
      }
      return res.json();
    },
  };
}
