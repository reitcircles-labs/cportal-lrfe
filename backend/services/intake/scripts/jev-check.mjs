#!/usr/bin/env node
/**
 * Does the automatic cross-check (Jev) catch our kinds of extraction mistakes, and how often does
 * it doubt correct values? Measured on the testers' sample PDFs (fictitious), to choose
 * JEV_FLAG_AT, JEV_ESCALATE_AT and the choice confidence (API-621).
 *
 *   cd backend/services/intake
 *   node scripts/jev-check.mjs              samples 01–05 (Gemini readings cached in tmp/jev-check)
 *   node scripts/jev-check.mjs 04 05        only those samples
 *   node scripts/jev-check.mjs --fresh      read the samples with Gemini again
 *
 * For each sample: Gemini's reading (read once, then cached) and copies of single fields with a
 * planted mistake — a value that belongs to another party, item or date ("wrong party"), a value
 * that is not in the document ("not in text"), a required field left empty ("missing"). One Jev
 * call per sample asks the cross-check questions (src/extraction/crosscheck.js) about the reading
 * and about every planted copy, plus the choice between the right and the wrong value. Jev answers
 * each question on its own, so the copies cannot influence each other.
 *
 * Uses the settings in this service's .env (GEMINI_*, TYPESAFE_API_KEY, JEV_MODEL). Sends only the
 * fictitious samples. About $0.005 for Jev; a fresh Gemini reading about $0.02.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = resolve(serviceDir, '../../../angular-app/docs/samples');
process.chdir(serviceDir);                    // @lrfe/common loads .env from the working directory

const { env, envBool, envOneOf } = await import('@lrfe/common');
const { createGeminiProvider } = await import('../src/extraction/providers.js');
const { buildRows } = await import('../src/extraction/pipeline.js');
const { buildQuestions, statePages, PREFER_CONFIDENCE } = await import('../src/extraction/crosscheck.js');
const { createJevClient, choice } = await import('../src/extraction/jev.js');
const { costUsd } = await import('../src/extraction/pricing.js');
const { docType } = await import('../src/doc-types.js');
const { EXPECTED, same } = await import('./samples-expected.mjs');

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const wanted = args.filter(a => !a.startsWith('--')).map(a => a.padStart(2, '0'));
const cacheDir = join(serviceDir, 'tmp', 'jev-check');
const out = (s = '') => process.stdout.write(s + '\n');
const fail = (msg) => { out(`✗ ${msg}`); process.exit(2); };

if (envBool('NETWORK_PREFER_IPV4', false)) dns.setDefaultResultOrder('ipv4first');
if (!process.env.TYPESAFE_API_KEY) fail(`TYPESAFE_API_KEY is not set (looked in ${join(serviceDir, '.env')})`);
const jev = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, model: env('JEV_MODEL', 'jev-latest'), timeoutMs: 30_000 });

// ---------------------------------------------------------------- Gemini readings (cached)

async function readings(keys) {
    await mkdir(cacheDir, { recursive: true });
    const file = join(cacheDir, 'readings.json');
    const cache = fresh ? {} : JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    const missing = keys.filter(k => !cache[k]);
    if (missing.length) {
        if (!process.env.GEMINI_API_KEY && !envBool('GEMINI_VERTEX', false)) fail('GEMINI_API_KEY is not set: needed once to read the samples');
        const gemini = createGeminiProvider({
            apiKey: process.env.GEMINI_API_KEY, vertex: envBool('GEMINI_VERTEX', false),
            project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION,
            model: env('GEMINI_MODEL', 'gemini-3.1-flash-lite'), transcribe: true,
            thinkingLevel: envOneOf('GEMINI_THINKING_LEVEL', ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], 'LOW'),
            mediaResolution: envOneOf('GEMINI_MEDIA_RESOLUTION', ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM')
        });
        const names = await readdir(samplesDir);
        for (const k of missing) {
            const name = names.find(n => n.startsWith(k) && n.endsWith('.pdf'));
            out(`Reading sample ${k} with ${gemini.model}…`);
            const r = await gemini.extract({ buffer: await readFile(join(samplesDir, name)), mimeType: 'application/pdf', fileName: name });
            cache[k] = { file: name, model: r.model, answer: r.result, costUsd: costUsd(r.model, r.usage) };
        }
        await writeFile(file, JSON.stringify(cache, null, 1));
    }
    return cache;
}

// ---------------------------------------------------------------- planted mistakes

/** A quote from the page containing `needle`, for a copied value's evidence. */
function quote(pages, needle) {
    // transcriptions break lines anywhere: match the words with any whitespace between them
    const re = new RegExp(needle.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
    for (const p of pages) {
        const m = re.exec(p.text);
        if (m) return { page: p.page, text: p.text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim() };
    }
    return null;
}

/**
 * One planted mistake per entry: { k, value, kind, why }. "wrong party" copies another field's
 * value (with that field's evidence, as a model that put a right quote in the wrong field would);
 * "not in text" invents a value; "missing" empties a required field.
 */
function plants(typeId, rows, pages) {
    const row = (k) => rows.find(r => r.k === k && r.value);
    const swap = (k, from, why) => row(k) && row(from) && row(k).value !== row(from).value
        ? [{ k, value: row(from).value, evidence: row(from).evidence, kind: 'wrong party', why }] : [];
    const invent = (k, value, why) => row(k) ? [{ k, value, evidence: row(k).evidence && { ...row(k).evidence, text: row(k).evidence.text.replace(row(k).value, value) }, kind: 'not in text', why }] : [];
    const empty = (k, why) => row(k) ? [{ k, value: '', evidence: null, kind: 'missing', why }] : [];
    const p = [];
    if (typeId === 'deed_of_transfer') {
        p.push(...swap('tee1Id', 'transferorId', "the seller's ID in the buyer's field"));
        p.push(...swap('tee1', 'transferor', "the seller's name as buyer"));
        p.push(...swap('transferor', 'tee1', "the buyer's name as seller"));
        p.push(...swap('tee2Id', 'tee1Id', "the first buyer's ID in the second buyer's field"));
        p.push(...swap('priorTitle', 'deedNo', 'its own number as the prior title'));
        const deceased = quote(pages, 'married in community of property');
        if (row('marital') && row('marital').value !== 'married in community of property' && deceased) {
            p.push({ k: 'marital', value: 'married in community of property', evidence: deceased, kind: 'wrong party', why: "the deceased's marital regime for the heirs" });
        }
        p.push(...invent('deedNo', 'T 9999/2010', 'a deed number not on the page'));
        p.push(...invent('regDate', '1 January 2001', 'a date not on the page'));
        p.push(...invent('price', 'N$ 123 456,00', 'an amount not on the page'));
        p.push(...invent('property', 'Erf 2291, Eros', 'another property'));
        p.push(...empty('transferor', 'the seller left out'));
        p.push(...empty('regDate', 'the registration date left out'));
    } else if (typeId === 'deed_of_grant') {
        p.push(...swap('grantor', 'tee1', 'the grantee as grantor'));
        p.push(...swap('tee1', 'grantor', 'the grantor as grantee'));
        p.push(...invent('deedNo', 'G 999/1980', 'a deed number not on the page'));
        p.push(...invent('regDate', '1 January 2001', 'a date not on the page'));
        p.push(...empty('regDate', 'the registration date left out'));
    } else if (typeId === 'sg_diagram') {
        p.push(...swap('surveyDate', 'approved', 'the approval date as survey date'));
        p.push(...swap('approved', 'surveyDate', 'the survey date as approval date'));
        p.push(...invent('sgNo', 'A 999/2010', 'a diagram number not on the page'));
        p.push(...invent('extent', '2 500 square metres', 'an area not on the page'));
        p.push(...empty('extent', 'the area left out'));
    }
    return p;
}

// ---------------------------------------------------------------- run

const keys = Object.keys(EXPECTED).filter(k => EXPECTED[k].fields && Object.keys(EXPECTED[k].fields).length && (!wanted.length || wanted.includes(k)));
if (!keys.length) fail(`No sample matches ${wanted.join(' ')}`);
const cache = await readings(keys);

const results = [];        // { key, field, label, group: 'correct' | 'gemini error' | plant kind, why?, p, pick? }
const calls = [];
for (const key of keys) {
    const { answer, file } = cache[key];
    const t = docType(answer.docType);
    out(`\n— ${file} (${t?.label || answer.docType})`);
    if (!t) { out('  type not recognised: skipped'); continue; }
    const rows = buildRows(answer, {}).rows;
    const exp = EXPECTED[key].fields;
    const pages = statePages(answer, rows);

    const questions = buildQuestions(answer.docType, rows);
    const planted = plants(answer.docType, rows, answer.pages);
    planted.forEach((m, i) => {
        const base = rows.find(r => r.k === m.k);
        const copy = { ...structuredClone(base), value: m.value, evidence: m.evidence };
        for (const [id, q] of Object.entries(buildQuestions(answer.docType, [copy]))) questions[`${id}#m${i}`] = q;
        if (m.value) {
            const def = t.fields.find(f => f.k === m.k);
            const options = i % 2 ? [m.value, base.value] : [base.value, m.value];      // vary the order
            questions[`pick#m${i}`] = choice({
                question: 'Which value does `document.pages` state for the field described by `field.label` and `field.meaning`?',
                field: { label: def.label, meaning: def.desc }
            }, { [options[0]]: null, [options[1]]: null, 'neither of these': 'The text states neither value for this field' });
        }
    });

    let r;
    try {
        r = await jev.ask({ state: { document: { type: t.label, pages } }, questions });
    } catch (err) { fail(`Jev call failed for ${file}: ${err.message}`); }
    calls.push({ key, questions: Object.keys(questions).length, ...r.usage, ms: r.durationMs, model: r.model, costUsd: costUsd(r.model, r.usage) });
    const p = (id) => r.answers[id]?.noul ?? null;
    const doubt = (k, suffix = '') => Math.max(p(`${k}|unsupported${suffix}`) ?? 0, p(`${k}|wrongParty${suffix}`) ?? 0);

    for (const row of rows.filter(x => x.value && exp[x.k] !== undefined)) {
        const ok = same(row.k, row.type, row.value, exp[row.k]);
        results.push({ key, field: row.k, label: row.label, group: ok ? 'correct' : 'gemini error', value: row.value, p: doubt(row.k), parts: { unsupported: p(`${row.k}|unsupported`), wrongParty: p(`${row.k}|wrongParty`) } });
        if (!ok) out(`  ! Gemini read ${row.label} as “${row.value}” (expected “${exp[row.k]}”): doubt ${doubt(row.k).toFixed(2)}`);
    }
    planted.forEach((m, i) => {
        const score = m.kind === 'missing' ? p(`${m.k}|present#m${i}`) ?? 0 : doubt(m.k, `#m${i}`);
        const a = r.answers[`pick#m${i}`];
        const base = rows.find(x => x.k === m.k).value;
        const pick = a ? { right: a.choice === base, wrong: a.choice === m.value, confidence: a.confidence } : null;
        results.push({ key, field: m.k, group: m.kind, why: m.why, value: m.value, p: score, pick });
        const pickText = pick ? ` · choice: ${pick.right ? 'right' : pick.wrong ? 'WRONG' : 'neither'} (${pick.confidence.toFixed(2)})` : '';
        out(`  ${score >= 0.5 ? '✓' : '✗'} ${m.kind.padEnd(11)} ${m.why}: ${score.toFixed(2)}${pickText}`);
    });
    const doubted = results.filter(x => x.key === key && x.group === 'correct' && x.p >= 0.3);
    for (const d of doubted) out(`  · correct value doubted: ${d.label} “${d.value}” ${d.p.toFixed(2)}`);
    out(`  ${Object.keys(questions).length} questions, ${r.usage.inputTokens} tokens, ${r.durationMs} ms`);
}

// ---------------------------------------------------------------- summary

const groups = ['wrong party', 'not in text', 'missing'];
const correct = results.filter(x => x.group === 'correct');
const geminiErrors = results.filter(x => x.group === 'gemini error');
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '–';
out('\nThreshold   ' + groups.map(g => g.padEnd(14)).join('') + 'all planted   correct values doubted');
for (const t of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const cols = groups.map(g => { const xs = results.filter(x => x.group === g); const n = xs.filter(x => x.p >= t).length; return `${n}/${xs.length} ${pct(n, xs.length)}`.padEnd(14); });
    const planted = results.filter(x => groups.includes(x.group));
    const caught = planted.filter(x => x.p >= t).length;
    const doubted = correct.filter(x => x.p >= t).length;
    out(`  ${t.toFixed(1)}       ${cols.join('')}${`${caught}/${planted.length} ${pct(caught, planted.length)}`.padEnd(14)}${doubted}/${correct.length} ${pct(doubted, correct.length)}`);
}
const picks = results.filter(x => x.pick);
const confident = picks.filter(x => x.pick.confidence >= PREFER_CONFIDENCE);
out(`\nChoice between the right and the wrong value: right ${picks.filter(x => x.pick.right).length}/${picks.length}; ` +
    `confident (≥ ${PREFER_CONFIDENCE}) ${confident.length}, of which right ${confident.filter(x => x.pick.right).length}, wrong ${confident.filter(x => x.pick.wrong).length}`);
if (geminiErrors.length) out(`Gemini's own mistakes in these readings: ${geminiErrors.map(x => `${x.key} ${x.label} (doubt ${x.p.toFixed(2)})`).join(', ')}`);
const tokens = calls.reduce((n, c) => n + c.inputTokens, 0), cost = calls.reduce((n, c) => n + (c.costUsd || 0), 0);
out(`${calls.length} Jev calls (${calls[0]?.model}), ${tokens} input tokens, $${cost.toFixed(5)}, ${Math.round(calls.reduce((n, c) => n + c.ms, 0) / (calls.length || 1))} ms on average`);

await writeFile(join(cacheDir, `results-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ calls, results }, null, 1));
out(`Details: ${join('tmp', 'jev-check', `results-${new Date().toISOString().slice(0, 10)}.json`)}`);
