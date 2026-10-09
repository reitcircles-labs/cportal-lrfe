import { AppError } from '@lrfe/common';

/**
 * land-records' calls to the edrms service, with a land-records service token (read only):
 *   searchDocuments({ q, docType, fields, limit }) → { items, total }   (edrms searchDocuments)
 *   getDocument(id)                                → document with fields, current version, versions | null
 * `fetchImpl` lets tests route calls into an in-process edrms app.
 */
export function createEdrmsClient({ baseUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    async function get(path) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${path}`, { method: 'GET', headers: { authorization: `Bearer ${serviceToken()}` }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new AppError(503, `The document store cannot be reached: ${err.message}`);
        }
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null };
    }

    return {
        async searchDocuments({ q, docType, fields = {}, limit = 50 } = {}) {
            const qs = new URLSearchParams();
            if (q) qs.set('q', q);
            if (docType) qs.set('docType', docType);
            for (const [k, v] of Object.entries(fields)) if (v) qs.set(`field.${k}`, v);
            qs.set('limit', String(limit));
            const { status, json } = await get(`/documents?${qs}`);
            if (status >= 400) throw new AppError(status === 400 ? 400 : 502, json?.message || `Document search failed (${status})`);
            return json;
        },
        async getDocument(id) {
            const { status, json } = await get(`/documents/${encodeURIComponent(id)}`);
            if (status === 404) return null;
            if (status >= 400) throw new AppError(502, json?.message || `Reading the document failed (${status})`);
            return json;
        }
    };
}
