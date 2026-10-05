import { AppError } from '@lrfe/common';

/**
 * land-records' calls to the bpm service, with a land-records service token:
 *   startReview(variables) → instance        (process "land-record-review")
 *   cancel(instanceId, reason) → instance     (the officer withdrew; an instance already ended is fine)
 */
export function createBpmClient({ baseUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    async function post(path, body) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${serviceToken()}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err) {
            throw new AppError(503, `The review process cannot be reached: ${err.message}`);
        }
        const text = await res.text();
        return { status: res.status, json: text ? JSON.parse(text) : null };
    }

    return {
        async startReview(variables) {
            const { status, json } = await post('/processes/land-record-review/instances', { variables });
            if (status >= 400) throw new AppError(status === 409 ? 409 : 502, json?.message || `Starting the review failed (${status})`);
            return json;
        },
        async cancel(instanceId, reason) {
            const { status, json } = await post(`/instances/${encodeURIComponent(instanceId)}/cancel`, { reason });
            if (status === 409 || status === 404) return null;           // already decided or gone
            if (status >= 400) throw new AppError(502, json?.message || `Withdrawing the review failed (${status})`);
            return json;
        }
    };
}
