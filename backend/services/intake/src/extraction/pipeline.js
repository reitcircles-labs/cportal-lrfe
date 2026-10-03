import { docType } from '../doc-types.js';
import { normalize, occursIn } from './normalize.js';
import { PROMPT_VERSION } from './prompt.js';
import { costUsd } from './pricing.js';
import { crossCheck } from './crosscheck.js';

/** A field's flag for the review screen, from its checks. */
export function flagOf(row) {
    if (row.checks.some(c => c.level === 'error')) return 'conflict';
    if (!row.value) return row.required ? 'missing' : 'ok';
    if (row.checks.some(c => c.level === 'warn')) return 'check';
    return 'ok';
}

/**
 * Turn the model's answer into review rows for the document type's schema: required fields
 * always, optional ones when found. Adds format checks and evidence checks (the quote must be on
 * the cited page and contain the value — the guard against invented values).
 */
export function buildRows(answer, { model } = {}) {
    const t = docType(answer.docType);
    if (!t) return { rows: [], ignored: answer.fields.map(x => x.k) };
    const byKey = new Map();
    for (const x of answer.fields) if (!byKey.has(x.k)) byKey.set(x.k, x);
    const pageText = new Map(answer.pages.map(p => [p.page, p.text]));
    const rows = [];
    for (const def of t.fields) {
        const x = byKey.get(def.k);
        if (!x && !def.required) continue;
        const raw = x?.value?.trim() || '';
        const n = raw ? normalize(def.type, raw) : { value: '', normalized: null, checks: [] };
        const checks = [...n.checks];
        if (!raw && def.required) checks.push({ level: 'warn', code: 'missing', message: 'Not found in the document' });
        if (x && raw) {
            if (!x.legible) checks.push({ level: 'warn', code: 'illegible', message: 'The model could not read every character' });
            const text = x.page ? pageText.get(x.page) : null;
            if (text != null && x.evidence && !occursIn(x.evidence, text)) checks.push({ level: 'warn', code: 'evidence_not_found', message: `The quoted evidence is not on page ${x.page}` });
            if (x.evidence && !occursIn(raw, x.evidence)) checks.push({ level: 'warn', code: 'value_not_in_evidence', message: 'The value does not appear in the quoted evidence' });
        }
        rows.push({
            k: def.k, label: def.label, type: def.type, required: def.required,
            extracted: raw || null, evidence: x ? { page: x.page, text: x.evidence } : null, model: x ? model : null,
            value: n.value, normalized: n.normalized, status: 'pending', checks, flag: 'ok', alt: null
        });
    }
    // A purchase price equal to the deposit is usually the deposit read into the wrong field.
    const price = rows.find(r => r.k === 'price' && r.normalized), deposit = rows.find(r => r.k === 'deposit' && r.normalized);
    if (price && deposit && price.normalized === deposit.normalized && t.id === 'deed_of_sale') {
        price.checks.push({ level: 'warn', code: 'same_as_deposit', message: 'Same amount as the deposit; check that this is the full purchase price' });
    }
    const known = new Set(t.fields.map(d => d.k));
    return { rows, ignored: answer.fields.map(x => x.k).filter(k => !known.has(k)) };
}

/**
 * Should the answer be re-read by the stronger model? Not for long documents (`pages` over
 * `maxPages`): a second reading re-sends every page, and costs more than the first. The reviewer
 * can still ask for one.
 */
export function needsEscalation(answer, rows, { pages = null, maxPages = Infinity } = {}) {
    let reason = null;
    if (answer.docType === 'unknown') reason = 'Document type not recognised';
    else {
        const conflicts = rows.filter(r => r.checks.some(c => c.level === 'error' && c.code !== 'duplicate'));
        const weak = rows.filter(r => r.flag === 'check' || r.flag === 'missing').length;
        if (conflicts.length) reason = `${conflicts.length} field(s) failed format checks`;
        else if (rows.length && weak / rows.length >= 0.3) reason = `${weak} of ${rows.length} fields need checking`;
    }
    if (reason && pages != null && pages > maxPages) return { skipped: `${reason}, but the document has ${pages} pages (automatic re-reading stops at ${maxPages}); request it from the review screen if needed` };
    return reason ? { reason } : null;
}

const problems = (r) => r.checks.filter(c => c.level === 'error' || (c.level === 'warn' && c.code !== 'models_disagree' && c.code !== 'single_reading')).length;

/**
 * Combine two readings field by field; neither is simply trusted. Agreement keeps the value.
 * On disagreement the reading with fewer problems (format errors, missing evidence, empty form
 * lines) wins — the second model on a tie — and the other reading is kept as `alt`. A value only
 * one model found is kept and flagged. Messages say "first/second reading", never the model: the
 * screen shows them as they are (`alt.model` stays for the backend).
 */
export function mergeRows(a, b, { firstModel, secondModel }) {
    const keys = [...new Set([...b.map(r => r.k), ...a.map(r => r.k)])];
    const order = (k) => { const i = b.findIndex(r => r.k === k); return i >= 0 ? i : 1000 + a.findIndex(r => r.k === k); };
    return keys.sort((x, y) => order(x) - order(y)).map(k => {
        const x = a.find(r => r.k === k), y = b.find(r => r.k === k);
        if (x?.value && y?.value) {
            if (x.value === y.value) return y;
            const firstWins = problems(x) < problems(y);
            const [win, lose, loseModel, reading] = firstWins ? [x, y, secondModel, 'second'] : [y, x, firstModel, 'first'];
            const chosen = structuredClone(win);
            chosen.checks.push({ level: 'warn', code: 'models_disagree', message: `The ${reading} reading gave “${lose.value}”` });
            chosen.alt = { model: loseModel, reading, value: lose.value };
            chosen.flag = flagOf(chosen);
            return chosen;
        }
        if (x?.value) {
            const kept = structuredClone(x);
            kept.checks = kept.checks.filter(c => c.code !== 'missing');
            kept.checks.push({ level: 'warn', code: 'single_reading', message: 'Found by the first reading only' });
            kept.flag = flagOf(kept);
            return kept;
        }
        return y ?? x;
    });
}

const transcriptionLength = (answer) => answer.pages.reduce((n, p) => n + p.text.length, 0);

async function attempt(provider, file, role, clock) {
    const at = clock();
    try {
        const r = await provider.extract(file);
        return { ok: true, role, provider: provider.name, model: r.model, promptVersion: PROMPT_VERSION, usage: r.usage, costUsd: costUsd(r.model, r.usage, { at }), durationMs: r.durationMs, answer: r.result, at };
    } catch (err) {
        return { ok: false, role, provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION, usage: null, costUsd: null, durationMs: null, error: err.message, retryable: err.retryable !== false, ...(err.publicMessage ? { publicMessage: err.publicMessage } : {}), at };
    }
}

async function evaluate(answer, model, checker) {
    const { rows, ignored } = buildRows(answer, { model });
    await checker.check(answer.docType, rows);
    rows.forEach(r => { r.flag = flagOf(r); });
    return { rows, ignored };
}

/**
 * Read one document: primary model, checks, and — if the result looks weak, an escalation model
 * is configured and the document is not too long — a second reading, merged field by field with
 * the first (see mergeRows). The longer transcription is kept.
 *
 * Finally, with a judge (`jev`), the fields are cross-checked against the transcription (see
 * ./crosscheck.js); its call is one more attempt, and a failure never fails the extraction.
 *
 * Returns { attempts, answer, rows, notes, escalated } or throws the primary's error (so the job
 * can be retried) with the failed attempt attached.
 */
export async function runExtraction({ file, primary, escalation = null, checker, jev = null, jevConfig = null, forceEscalation = false, pages = null, maxEscalationPages = Infinity, clock = () => new Date() }) {
    const attempts = [];
    const first = await attempt(forceEscalation && escalation ? escalation : primary, file, forceEscalation && escalation ? 'escalation' : 'primary', clock);
    attempts.push(first);
    if (!first.ok) {
        const err = new Error(first.error);
        err.retryable = first.retryable;
        if (first.publicMessage) err.publicMessage = first.publicMessage;
        err.attempts = attempts;
        throw err;
    }
    let { answer } = first;
    let { rows, ignored } = await evaluate(answer, first.model, checker);
    const notes = [];
    if (ignored.length) notes.push({ level: 'info', code: 'ignored_fields', message: `Fields not used for this document type: ${ignored.join(', ')}` });

    const decision = !forceEscalation && escalation ? needsEscalation(answer, rows, { pages, maxPages: maxEscalationPages }) : null;
    let escalated = forceEscalation && !!escalation;
    if (decision?.skipped) notes.push({ level: 'info', code: 'escalation_skipped', message: decision.skipped });
    if (decision?.reason) {
        const second = await attempt(escalation, file, 'escalation', clock);
        attempts.push(second);
        // the error (with the model) is kept on the attempt; the note is shown on screen
        if (!second.ok) notes.push({ level: 'warn', code: 'escalation_failed', message: 'Second reading failed; showing the first reading' });
        else {
            escalated = true;
            notes.push({ level: 'info', code: 'escalated', message: `Read a second time (${decision.reason}); the two readings are combined field by field` });
            if (second.answer.docType !== answer.docType && answer.docType !== 'unknown') {
                const label = (id) => docType(id)?.label || 'not recognised';
                notes.push({ level: 'warn', code: 'doctype_disagree', message: `The two readings disagree on the document type (${label(answer.docType)} / ${label(second.answer.docType)}); keeping ${label(answer.docType)}` });
            } else {
                const again = await evaluate(second.answer, second.model, checker);
                rows = answer.docType === 'unknown' ? again.rows : mergeRows(rows, again.rows, { firstModel: first.model, secondModel: second.model });
                const pagesKept = transcriptionLength(second.answer) > transcriptionLength(answer) ? second.answer.pages : answer.pages;
                answer = { ...(answer.docType === 'unknown' ? second.answer : answer), pages: pagesKept };
            }
        }
    }
    if (jev) {
        const x = await crossCheck({ jev, answer, rows, flagAt: jevConfig?.flagAt ?? 0.5, clock });
        if (x.attempt) attempts.push(x.attempt);
        if (x.note) notes.push(x.note);
        rows.forEach(r => { r.flag = flagOf(r); });
    }
    return { attempts, answer, rows, notes, escalated };
}
