import { AppError } from '@lrfe/common';

/**
 * JSON client for calling another service with a bpm service token. Non-2xx responses become
 * AppErrors carrying the upstream status and message, so a 409 from edrms stays a 409.
 */
export function createServiceClient({ baseUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    return async function call(method, path, body) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${path}`, {
                method,
                headers: { authorization: `Bearer ${serviceToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err) {
            throw new AppError(503, `${baseUrl} is unreachable: ${err.message}`);
        }
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new AppError(res.status, json?.message || `${method} ${path} failed with ${res.status}`, json?.details);
        return json;
    };
}
