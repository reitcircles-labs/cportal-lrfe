import {AppError} from '@lrfe/common';

/**
 * The extracts service's call to land-records, with an extracts service token (read only):
 *   getRecord(id) → the land record with its current committed version (`current`) | null
 *   getVersion(id, n) → version `n` of the land record | null
 * `fetchImpl` lets tests route calls into an in-process land-records app.
 */
export function createRecordsClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  const read = async path => {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {authorization: `Bearer ${serviceToken()}`},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppError(
        503,
        `The land records cannot be reached: ${err.message}`,
      );
    }
    if (res.status === 404) return null;
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
        json?.message || `Reading the land record failed (${res.status})`,
      );
    }
    return json;
  };
  return {
    getRecord: id => read(`/records/${encodeURIComponent(id)}`),
    getVersion: (id, n) =>
      read(`/records/${encodeURIComponent(id)}/versions/${Number(n)}`),
  };
}
