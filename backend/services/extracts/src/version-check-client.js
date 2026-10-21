/**
 * The extracts service's call to the audit service for the public check of an extract (API-693),
 * with an extracts service token:
 *   checkVersion(recordId, n) → { valid, status, checks, seal, batch, tx, confirmedAt, explorerUrl }
 *                               | null when the audit service cannot answer now
 * It never throws: a check that cannot be made is null, and the public check then says so.
 * `fetchImpl` lets tests route calls into an in-process audit app.
 */
export function createVersionCheckClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
}) {
  return {
    async checkVersion(recordId, versionNumber) {
      try {
        const res = await fetchImpl(`${baseUrl}/audit/anchoring/check`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({recordId, version: versionNumber}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
  };
}
