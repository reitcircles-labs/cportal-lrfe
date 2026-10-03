/**
 * Model prices in USD per 1M tokens. Gemini: API list prices (standard tier), from
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
 * Prices by model-id prefix, for model families whose API answers with a versioned id
 * (e.g. "jev-1.13.0" for jev-latest). An exact entry in PRICES wins.
 *   Jev (TypeSafe): $42 per billion input tokens, output free (https://typesafe.ai, read 2026-10-03).
 */
export const PRICE_FAMILIES = [
    { prefix: 'jev-', rows: [{ in: 0.042, out: 0 }] }
];

const priceRows = (model) => PRICES[model] ?? PRICE_FAMILIES.find(f => model?.startsWith(f.prefix))?.rows ?? null;

/**
 * Cost of one call, or null when the model is not in the table (the call still succeeds; the
 * missing price is visible in the usage report).
 */
export function costUsd(model, usage, { at = new Date(), batch = false } = {}) {
    const rows = priceRows(model);
    if (!rows || !usage) return null;
    const day = at.toISOString().slice(0, 10);
    const p = rows.find(r => !r.until || day <= r.until);
    const factor = batch ? 0.5 : 1;
    const out = (usage.outputTokens || 0) + (usage.thoughtsTokens || 0);
    // tokens × USD-per-1M → micro-dollars, rounded to whole micro-dollars, then to USD
    return Math.round(((usage.inputTokens || 0) * p.in + out * p.out) * factor) / 1e6;
}
