import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Text as it is searched and compared: lowercase, no accents or punctuation, letters split from
 * digits. "Hoäeb, T2210/2008" → "hoaeb t 2210 2008". Shared by edrms search and land-records.
 */
export function normalizeSearch(s) {
    return String(s ?? '')
        .normalize('NFD').replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
