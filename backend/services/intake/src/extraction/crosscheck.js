import { docType } from '../doc-types.js';
import { costUsd } from './pricing.js';
import { noul } from './jev.js';

/**
 * Automatic cross-check of extracted fields against the document text, by a judging model
 * (Jev, see ./jev.js). One call per document: for each field with a value, "is the value not
 * supported by the text?" and "does it describe another party or thing than the field asks for?";
 * for each required field left empty, "does the text contain it?".
 *
 * Results go on the row as `xcheck` (probabilities, not shown) and, from `flagAt` on, as a warning
 * check — so the field is marked "check". Messages shown to users never name the tool or the model.
 * Code checks (format, EDRMS) are not touched: an error still wins.
 *
 * Optional by design: without a judge, without a transcription, or when the call fails, the rows
 * stay exactly as they are (a failure adds one neutral note).
 */

export const CROSSCHECK_VERSION = 'xcheck-2026-10-03.1';
export const XCHECK_CODES = ['xcheck_unsupported', 'xcheck_wrong_party', 'xcheck_present'];

const MESSAGES = {
    unsupported: 'Could not be confirmed in the document text',
    wrongParty: 'May describe another party or item than this field asks for',
    present: 'The document text seems to contain this'
};
const CODES = { unsupported: 'xcheck_unsupported', wrongParty: 'xcheck_wrong_party', present: 'xcheck_present' };
export const UNAVAILABLE_NOTE = { level: 'info', code: 'xcheck_unavailable', message: 'Automatic cross-check unavailable for this document' };

// Keep the request well inside the model's state budget (about 32k tokens)
const MAX_TEXT_CHARS = 80_000;

const fieldOf = (def, row) => ({
    label: def.label,
    meaning: def.desc,
    value: row.value,
    ...(row.evidence?.text ? { evidence: row.evidence.text, page: row.evidence.page } : {})
});

/** The questions for one document: id `${k}|${kind}` → noul. */
export function buildQuestions(typeId, rows) {
    const t = docType(typeId);
    const questions = {};
    for (const row of rows) {
        const def = t?.fields.find(f => f.k === row.k);
        if (!def) continue;
        if (row.value) {
            questions[`${row.k}|unsupported`] = noul({
                question: 'Is `field.value` NOT stated in `document.pages` as the value of the field described by `field.label` and `field.meaning`?',
                field: fieldOf(def, row)
            }, {
                true: 'The text does not state this value for this field, or states a different value',
                false: 'The text states this value for this field'
            });
            questions[`${row.k}|wrongParty`] = noul({
                question: 'Does `field.value` appear in `document.pages` but describe a different person, party, date or item than the one `field.label` and `field.meaning` ask for?',
                field: fieldOf(def, row)
            }, {
                true: 'The value belongs to someone or something else in the document, e.g. the seller instead of the buyer, or the deceased instead of the heirs',
                false: 'The value describes exactly what the field asks for'
            });
        } else if (row.required) {
            questions[`${row.k}|present`] = noul({
                question: 'Does `document.pages` contain the information described by `field.label` and `field.meaning`?',
                field: { label: def.label, meaning: def.desc }
            }, {
                true: 'The text states this information',
                false: 'The text does not state this information'
            });
        }
    }
    return questions;
}

/** The pages the fields cite (and page 1), or all pages when none are cited. */
export function statePages(answer, rows) {
    const pages = (answer.pages || []).filter(p => p.text?.trim());
    const cited = new Set([1, ...rows.map(r => r.evidence?.page).filter(Boolean)]);
    let picked = pages.filter(p => cited.has(p.page));
    if (!picked.length) picked = pages;
    let total = 0;
    return picked.filter(p => (total += p.text.length) <= MAX_TEXT_CHARS);
}

/**
 * Cross-check `rows` in place. Returns { attempt, note }: `attempt` is the model call to store with
 * the extraction (null when no call was made), `note` a document note when the check could not run.
 */
export async function crossCheck({ jev, answer, rows, flagAt = 0.5, clock = () => new Date() }) {
    if (!jev || !docType(answer.docType)) return { attempt: null, note: null };
    const questions = buildQuestions(answer.docType, rows);
    if (!Object.keys(questions).length) return { attempt: null, note: null };
    const pages = statePages(answer, rows);
    if (!pages.length) return { attempt: null, note: UNAVAILABLE_NOTE };   // no transcription to check against

    const at = clock();
    const base = { role: 'crosscheck', provider: jev.name, promptVersion: CROSSCHECK_VERSION, at };
    let r;
    try {
        r = await jev.ask({ state: { document: { type: docType(answer.docType).label, pages } }, questions });
    } catch (err) {
        return { attempt: { ...base, ok: false, model: jev.model, usage: null, costUsd: null, durationMs: null, error: err.message, retryable: err.retryable !== false }, note: UNAVAILABLE_NOTE };
    }
    for (const row of rows) {
        const kinds = ['unsupported', 'wrongParty', 'present'].filter(kind => r.answers[`${row.k}|${kind}`]);
        if (!kinds.length) continue;
        row.xcheck = Object.fromEntries(kinds.map(kind => [kind, round(r.answers[`${row.k}|${kind}`].noul)]));
        for (const kind of kinds) {
            if (row.xcheck[kind] >= flagAt) row.checks.push({ level: 'warn', code: CODES[kind], message: MESSAGES[kind] });
        }
    }
    return {
        attempt: { ...base, ok: true, model: r.model, usage: r.usage, costUsd: costUsd(r.model, r.usage, { at }), durationMs: r.durationMs, answer: { answers: r.answers } },
        note: null
    };
}

const round = (p) => Math.round((Number(p) || 0) * 1000) / 1000;
