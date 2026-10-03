/**
 * TypeSafe's Jev: a "System One" model that answers typed questions about text with calibrated
 * probabilities. It does not read images and does not write text, so Gemini keeps reading the
 * scans; Jev judges what Gemini read (see docs: https://docs.typesafe.ai/api).
 *
 *   const jev = createJevClient({ apiKey });
 *   const r = await jev.ask({ state: { page, field }, questions: { wrongParty: noul('…', { true: '…', false: '…' }) } });
 *   r.answers.wrongParty.noul → 0.86     r.usage → { inputTokens, outputTokens }     r.model → 'jev-1.13.0'
 *
 * A failed call throws JevError. Callers treat Jev as optional: on any error the document is
 * handled exactly as without Jev.
 */

export class JevError extends Error {
    constructor(message, { status = null, retryable = true, cause } = {}) {
        super(message);
        this.name = 'JevError';
        this.status = status;
        this.retryable = retryable;
        if (cause) this.cause = cause;
    }
}

/** Yes/no: the answer is the probability of yes. `criteria`: { true: '…', false: '…' } (optional). */
export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
/** One of a set: `criteria` maps each option to its meaning (or null). At most 255 options. */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
/** Ordered levels, 2 to 10, each a self-contained description. */
export const score = (instructions, levels) => ({ type: 'score', instructions, criteria: levels });

// 429 rate limited, 529 overloaded, other 5xx: worth another try; 401/422: not
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Jev over HTTP (POST {baseUrl}/v1/systemone). Plain fetch: the JS SDK is pre-1.0 and the contract
 * is small. A call is retried on rate limits, overload, 5xx, network errors and timeouts, with
 * backoff (backoffMs, ×4 each time); `timeoutMs` applies to each attempt.
 */
export function createJevClient({
    apiKey, model = 'jev-latest', baseUrl = 'https://api.typesafe.ai', timeoutMs = 5000,
    retries = 2, backoffMs = 250, fetch: fetchFn = globalThis.fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms))
}) {
    if (!apiKey) throw new Error('Jev client: TYPESAFE_API_KEY is required');
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/systemone`;

    async function once(body) {
        let res;
        try {
            res = await fetchFn(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err) {
            const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
            throw new JevError(timedOut ? `Jev did not answer within ${timeoutMs} ms` : `Jev unreachable: ${err?.message || err}`, { retryable: true, cause: err });
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const detail = text.slice(0, 300).replace(/\s+/g, ' ').trim();
            throw new JevError(`Jev answered ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status, retryable: RETRY_STATUS.has(res.status) });
        }
        let json;
        try { json = await res.json(); } catch (err) { throw new JevError('Jev returned invalid JSON', { status: res.status, retryable: true, cause: err }); }
        if (!json || typeof json.answers !== 'object') throw new JevError('Jev returned no answers', { status: res.status, retryable: false });
        return json;
    }

    return {
        name: 'typesafe',
        model,
        /** Ask `questions` (id → noul/choice/score) about `state` (string, object or array). */
        async ask({ state, questions }) {
            if (!questions || !Object.keys(questions).length) throw new JevError('No questions to ask', { retryable: false });
            const body = JSON.stringify({ model, state, questions });
            const t0 = Date.now();
            for (let attempt = 0; ; attempt++) {
                try {
                    const json = await once(body);
                    return {
                        answers: json.answers,
                        usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
                        model: json.model || model,
                        durationMs: Date.now() - t0
                    };
                } catch (err) {
                    if (!err.retryable || attempt >= retries) throw err;
                    await sleep(backoffMs * 4 ** attempt);
                }
            }
        }
    };
}

/**
 * Deterministic stand-in (tests, CI, and JEV_PROVIDER=fake): no key, no network.
 * `respond({ state, questions })` returns answers by question id; questions it leaves out get the
 * defaults: noul 0.02 ("no"), choice the first option (confidence 1, or `{ choice, confidence }`),
 * score the first level.
 */
export function createFakeJev({ model = 'fake-jev', respond } = {}) {
    const calls = [];
    return {
        name: 'fake',
        model,
        calls,
        async ask({ state, questions }) {
            calls.push({ state, questions });
            const given = respond ? (await respond({ state, questions })) || {} : {};
            const answers = {};
            for (const [id, q] of Object.entries(questions)) {
                const a = given[id];
                if (q.type === 'noul') answers[id] = { type: 'noul', noul: typeof a === 'number' ? a : a?.noul ?? 0.02 };
                else if (q.type === 'choice') {
                    const options = Object.keys(q.criteria);
                    const pick = typeof a === 'string' ? a : a?.choice ?? options[0];
                    answers[id] = { type: 'choice', choice: pick, probabilities: Object.fromEntries(options.map(o => [o, o === pick ? 1 : 0])), confidence: a?.confidence ?? 1 };
                } else answers[id] = { type: 'score', score: a?.score ?? 0, probabilities: {}, confidence: 1 };
            }
            const tokens = Math.ceil(JSON.stringify({ state, questions }).length / 4);
            return { answers, usage: { inputTokens: tokens, outputTokens: 0 }, model, durationMs: 1 };
        }
    };
}
