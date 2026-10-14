import { AppError } from '@lrfe/common';

/**
 * JSON from another service, with the audit service's own token. `request(url, { name, method,
 * body, notFound })`: 503 when `name` cannot be reached, 502 for an error reply or one that is not
 * JSON; with `notFound` set, a 404 returns that value instead.
 */
export function createServiceClient({ serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    return async function request(url, { name, method = 'GET', body, notFound } = {}) {
        const headers = { authorization: `Bearer ${serviceToken()}` };
        if (body !== undefined) headers['content-type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new AppError(503, `The ${name} cannot be reached: ${err.message}`);
        }
        if (res.status === 404 && notFound !== undefined) return notFound;
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            // not JSON (a proxy's error page): reported by status below
        }
        if (res.status >= 400 || !json) {
            throw new AppError(502, `Reading from the ${name} failed (${res.status}): ${json?.message || 'no detail'}`);
        }
        return json;
    };
}
