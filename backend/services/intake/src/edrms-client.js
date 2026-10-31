import {AppError} from '@lrfe/common';

/**
 * Intake's calls to the edrms service, with an intake service token:
 *   lookupRef(ref)                          → document | null     (cross-checks)
 *   fileDocument({ meta, transcription, buffer, fileName, mimeType }) → { document, created }   (filing)
 *   addTranscription(documentId, pages)     → { created }          (back-fill of page text, API-798)
 *   getVersion(documentId, n)               → version (sha256, text) | null   (before clearing, API-807)
 *   contentLink(documentId, version)        → { url, expiresIn }   (the scan of a cleared document)
 * `fetchImpl` lets tests route calls into an in-process edrms app.
 */
export function createEdrmsClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  async function call(method, path, {body, headers = {}} = {}) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        body,
        headers: {authorization: `Bearer ${serviceToken()}`, ...headers},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppError(503, `The EDRMS cannot be reached: ${err.message}`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return {status: res.status, json};
  }

  return {
    async lookupRef(ref) {
      const {status, json} = await call(
        'GET',
        `/documents/lookup?instrumentRef=${encodeURIComponent(ref)}`,
      );
      if (status === 404) return null;
      if (status >= 400) {
        throw new AppError(
          status,
          json?.message || `EDRMS lookup failed (${status})`,
        );
      }
      return json;
    },

    async fileDocument({meta, transcription = [], buffer, fileName, mimeType}) {
      // meta and page text first, then the file: edrms streams the file straight to storage
      const form = new FormData();
      form.append('meta', JSON.stringify(meta));
      if (transcription.length) {
        form.append('transcription', JSON.stringify(transcription));
      }
      form.append('file', new Blob([buffer], {type: mimeType}), fileName);
      const {status, json} = await call('POST', '/documents', {body: form});
      if (status >= 400) {
        throw new AppError(
          status,
          json?.message || `Filing failed (${status})`,
          json?.details,
        );
      }
      return json;
    },

    async addTranscription(documentId, pages) {
      const {status, json} = await call(
        'PUT',
        `/documents/${encodeURIComponent(documentId)}/transcription`,
        {
          body: JSON.stringify({pages}),
          headers: {'content-type': 'application/json'},
        },
      );
      if (status >= 400) {
        throw new AppError(
          status,
          json?.message || `Storing the page text failed (${status})`,
        );
      }
      return json;
    },

    async getVersion(documentId, n) {
      const {status, json} = await call(
        'GET',
        `/documents/${encodeURIComponent(documentId)}/versions/${n}`,
      );
      if (status === 404) return null;
      if (status >= 400) {
        throw new AppError(
          status,
          json?.message || `Reading the filed version failed (${status})`,
        );
      }
      return json;
    },

    async contentLink(documentId, version) {
      const {status, json} = await call(
        'GET',
        `/documents/${encodeURIComponent(documentId)}/content?version=${version}`,
      );
      if (status >= 400) {
        throw new AppError(
          status,
          json?.message || `The filed scan cannot be opened (${status})`,
        );
      }
      return json;
    },
  };
}
