/**
 * The anchoring status of sealed versions, asked of the audit service (API-658) by land-records and
 * edrms to show next to each version: `waiting` for the next anchoring, `anchored` (on its way into
 * the chain) or `confirmed`. Best effort: when the audit service is down, slow or not installed,
 * every version's status is null (not known) and nothing else is held up.
 *
 *   statusOf(keys)   { [key]: { status, batch, tx, network, confirmedAt } | null }
 *                    keys: record-version:<id>:<n>, document-version:<id>:<n>
 */
export function createAnchoringClient({ baseUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 2000, logger = console }) {
    let warned = 0;
    return {
        async statusOf(keys) {
            if (!keys.length) return {};
            try {
                const res = await fetchImpl(`${baseUrl}/audit/anchoring`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${serviceToken()}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ keys: keys.slice(0, 500) }),
                    signal: AbortSignal.timeout(timeoutMs)
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()).items || {};
            } catch (err) {
                // at most one warning a minute
                if (Date.now() - warned > 60_000) { warned = Date.now(); logger.warn?.({ err: err.message }, 'the anchoring status cannot be read from the audit service'); }
                return {};
            }
        }
    };
}
