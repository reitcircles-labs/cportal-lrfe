import {AppError} from '@lrfe/common';

/**
 * A GET to another service with the search service's token. Null on 404 (the document is not
 * there); a 503 AppError when the service cannot be reached, a 502 when it answers with an error,
 * so the event is delivered again.
 */
async function getJson({
  baseUrl,
  serviceToken,
  fetchImpl,
  timeoutMs,
  path,
  what,
}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {authorization: `Bearer ${serviceToken()}`},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AppError(503, `${what} cannot be reached: ${err.message}`);
  }
  if (res.status === 404) return null;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // an answer that is not JSON (a proxy's error page): reported below by its status
  }
  if (res.status >= 400) {
    throw new AppError(502, json?.message || `${what} answered ${res.status}`);
  }
  return json;
}

/** The query of a changed-since list: `since` (left out: all), `after` (the last page's `next`), `limit`. */
function changedQuery({since, after, limit}) {
  return new URLSearchParams({
    ...(since ? {since: new Date(since).toISOString()} : {}),
    ...(after ? {after} : {}),
    limit: String(limit),
  }).toString();
}

/**
 * The search service's calls to intake, with its own service token:
 *   getReading(id) → { documentId, status, docType, reference, fields, pages, … } | null
 *   listChanged({ since, after, limit }) → { items: [{ documentId, status, updatedAt }], next, total }
 * (intake GET /documents/:id/reading, which takes the search service's token only, API-798).
 * `fetchImpl` lets tests route calls into an in-process intake app.
 */
export function createIntakeClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  return {
    getReading: id =>
      getJson({
        baseUrl,
        serviceToken,
        fetchImpl,
        timeoutMs,
        path: `/documents/${encodeURIComponent(id)}/reading`,
        what: 'Intake',
      }),
    listChanged: query =>
      getJson({
        baseUrl,
        serviceToken,
        fetchImpl,
        timeoutMs,
        path: `/documents/changed?${changedQuery(query)}`,
        what: 'Intake',
      }),
  };
}

/**
 * The search service's calls to edrms, with its own service token (read only):
 *   getDocument(id) → the filed document: edrmsNo, corrected fields, recordMetadata, … | null
 *   getReading(id) → { documentId, pages, extracted } | null: the page text and the AI's values
 *     kept with the filed document, for one whose copy intake has cleared (API-807)
 *   listChanged({ since, after, limit }) → { items: [{ id, sourceId, updatedAt }], next, total }
 * `fetchImpl` lets tests route calls into an in-process edrms app.
 */
export function createEdrmsClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  return {
    getDocument: id =>
      getJson({
        baseUrl,
        serviceToken,
        fetchImpl,
        timeoutMs,
        path: `/documents/${encodeURIComponent(id)}`,
        what: 'The document store',
      }),
    getReading: id =>
      getJson({
        baseUrl,
        serviceToken,
        fetchImpl,
        timeoutMs,
        path: `/documents/${encodeURIComponent(id)}/reading`,
        what: 'The document store',
      }),
    listChanged: query =>
      getJson({
        baseUrl,
        serviceToken,
        fetchImpl,
        timeoutMs,
        path: `/documents/changed?${changedQuery(query)}`,
        what: 'The document store',
      }),
  };
}
