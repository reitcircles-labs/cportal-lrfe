import { AppError } from '@lrfe/common';

/**
 * Intake's calls to the edrms service, with an intake service token:
 *   lookupRef(ref)                          → document | null     (cross-checks)
 *   fileDocument({ meta, buffer, fileName, mimeType }) → { document, created }   (filing)
 * `fetchImpl` lets tests route calls into an in-process edrms app.
 */
export function createEdrmsClient({ baseUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    async function call(method, path, { body, headers = {} } = {}) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${path}`, {
                method, body, headers: { authorization: `Bearer ${serviceToken()}`, ...headers }, signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err) {
            throw new AppError(503, `The EDRMS cannot be reached: ${err.message}`);
        }
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        return { status: res.status, json };
    }

    return {
        async lookupRef(ref) {
            const { status, json } = await call('GET', `/documents/lookup?instrumentRef=${encodeURIComponent(ref)}`);
            if (status === 404) return null;
            if (status >= 400) throw new AppError(status, json?.message || `EDRMS lookup failed (${status})`);
            return json;
        },

        async fileDocument({ meta, buffer, fileName, mimeType }) {
            // meta first, then the file: edrms streams the file straight to storage
            const form = new FormData();
            form.append('meta', JSON.stringify(meta));
            form.append('file', new Blob([buffer], { type: mimeType }), fileName);
            const { status, json } = await call('POST', '/documents', { body: form });
            if (status >= 400) throw new AppError(status, json?.message || `Filing failed (${status})`, json?.details);
            return json;
        }
    };
}
