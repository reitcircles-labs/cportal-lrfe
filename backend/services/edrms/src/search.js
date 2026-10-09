/**
 * Document search text (API-645). Each document keeps a normalised text of what it is found by:
 * title, instrument reference, EDRMS number and every verified field value. Lowercase, accents and
 * punctuation removed, so "T 2210/2008" is found as "t 2210 2008", "Hoäeb" as "hoaeb" and "!Naruseb"
 * as "naruseb". PostgreSQL indexes it for full-text search (tsvector) and, where the pg_trgm
 * extension is available, for similarity (spelling variants of names); the memory repo mirrors it.
 */

import { normalizeSearch } from '@lrfe/common';

// normalisation is shared with land-records (@lrfe/common)
export { normalizeSearch };

export function searchTextOf({ title, instrumentRef, edrmsNo, fields = [] }) {
    return normalizeSearch([title, instrumentRef, edrmsNo, ...fields.map(f => f.v)].filter(Boolean).join(' '));
}

/** A spelling variant still matches from this word similarity (0 to 1), e.g. "ngishidi" ~ "nghishidi". */
export const SIMILARITY = 0.5;

const trigrams = (word) => {
    const w = `  ${word} `;
    const set = new Set();
    for (let i = 0; i < w.length - 2; i++) set.add(w.slice(i, i + 3));
    return set;
};

/** Trigram similarity of two words (like pg_trgm's similarity). */
export function wordSimilarity(a, b) {
    const x = trigrams(a), y = trigrams(b);
    let common = 0;
    for (const t of x) if (y.has(t)) common++;
    return common / (x.size + y.size - common);
}

/**
 * Spelling variants only for words with letters (names): numbers (ID numbers, deed and erf numbers)
 * must match exactly or as the start of a number, so "9999" never finds "1873".
 */
export const fuzzy = (word) => /[a-z]/.test(word) && word.length >= 4;

/** Query words of 3 or more letters also match as the start of a word ("wind" finds "windhoek"). */
export const PREFIX_MIN = 3;

/**
 * How well a normalised query matches a normalised text (memory repo): every query word must occur
 * as a word of the text, start one, or be similar enough to one. Returns a score (higher is better) or 0.
 */
export function matchScore(query, text) {
    const words = text.split(' ');
    let score = 0;
    for (const q of query.split(' ').filter(Boolean)) {
        if (words.includes(q)) { score += 2; continue; }
        if (q.length >= PREFIX_MIN && words.some(w => w.startsWith(q))) { score += 1.5; continue; }
        if (!fuzzy(q)) return 0;
        const best = Math.max(0, ...words.map(w => wordSimilarity(q, w)));
        if (best < SIMILARITY) return 0;
        score += best;
    }
    return score;
}
