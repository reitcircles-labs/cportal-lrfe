/**
 * Gemini API list prices in USD per 1M tokens (standard tier), from
 * https://ai.google.dev/gemini-api/docs/pricing as read on 2026-09-29. The Batch API is half.
 * Thinking tokens are billed as output. Entries with `until` apply up to and including that date.
 * Update this table when prices change; the cost of every extraction is stored with it.
 */
export const PRICES = {
    'gemini-3.1-flash-lite': [{ in: 0.25, out: 1.50 }],
    'gemini-3.5-flash-lite': [{ in: 0.30, out: 2.50 }],
    'gemini-3.8-flash': [{ until: '2026-12-31', in: 0.75, out: 3.75 }, { in: 1.50, out: 7.50 }],
    'gemini-3.7-flash': [{ until: '2026-12-31', in: 0.75, out: 3.75 }, { in: 1.50, out: 7.50 }],
    'gemini-3.1-pro-preview': [{ in: 2.00, out: 12.00 }],   // prompts ≤ 200k tokens
    'gemini-2.5-flash-lite': [{ in: 0.10, out: 0.40 }],
    'gemini-2.5-flash': [{ in: 0.30, out: 2.50 }],
    'gemini-2.5-pro': [{ in: 1.25, out: 10.00 }]
};

/**
 * Cost of one call, or null when the model is not in the table (the call still succeeds; the
 * missing price is visible in the usage report).
 */
export function costUsd(model, usage, { at = new Date(), batch = false } = {}) {
    const rows = PRICES[model];
    if (!rows || !usage) return null;
    const day = at.toISOString().slice(0, 10);
    const p = rows.find(r => !r.until || day <= r.until);
    const factor = batch ? 0.5 : 1;
    const out = (usage.outputTokens || 0) + (usage.thoughtsTokens || 0);
    // tokens × USD-per-1M → micro-dollars, rounded to whole micro-dollars, then to USD
    return Math.round(((usage.inputTokens || 0) * p.in + out * p.out) * factor) / 1e6;
}
