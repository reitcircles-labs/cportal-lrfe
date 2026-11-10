import {AppError} from '@lrfe/common';
import {createRecordClient} from '@lrfe/record-contract';

/**
 * The extracts service's calls to the product's record service (CB-4: the record contract), with an
 * extracts service token (read only):
 *   getRecord(id) → the record with its current committed version (`current`) | null
 *   getVersion(id, n) → version `n` of the record | null
 * `label` names the record service in error texts ("land records" for land) and `record` one record
 * ("land record"), both from the domain pack. `fetchImpl` lets tests route calls into an in-process
 * record service app.
 */
export function createRecordsClient({
  baseUrl,
  label,
  record,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  const send = async (method, path) => {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {authorization: `Bearer ${serviceToken()}`},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppError(503, `The ${label} cannot be reached: ${err.message}`);
    }
    if (res.status === 404) {
      return null;
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
        json?.message || `Reading the ${record} failed (${res.status})`,
      );
    }
    return json;
  };
  const client = createRecordClient(send);
  return {
    getRecord: id => client.get(id),
    getVersion: (id, n) => client.version(id, n),
  };
}
