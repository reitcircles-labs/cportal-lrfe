#!/usr/bin/env node
/**
 * Does the Gemini connection work for documents? Reads the testers' sample PDFs
 * (angular-app/docs/samples) with the configured Gemini model and compares each answer with the
 * values in the samples README. Uses the intake service's own provider, prompt, checks and
 * pipeline, with the settings in this service's .env (GEMINI_API_KEY, GEMINI_MODEL, …).
 *
 *   cd backend/services/intake
 *   node scripts/gemini-check.mjs                    all six samples, primary model only
 *   node scripts/gemini-check.mjs 04 05              only those samples
 *   node scripts/gemini-check.mjs --file scan.pdf    any document (no expected values)
 *   node scripts/gemini-check.mjs --escalate         let weak readings go to GEMINI_ESCALATION_MODEL, as the worker does
 *   node scripts/gemini-check.mjs --model gemini-3.1-pro-preview
 *   node scripts/gemini-check.mjs --ping             connection check only (costs nothing)
 *
 * Nothing is stored and no service or database is involved; EDRMS lookups are answered "not
 * filed". Each document read costs a fraction of a cent with the flash-lite model.
 * Exit code: 0 all good, 1 a value differs, 2 the connection or a reading failed.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = resolve(serviceDir, '../../../angular-app/docs/samples');
const startDir = process.cwd();
process.chdir(serviceDir);                    // @lrfe/common loads .env from the working directory

const { env, envBool, envOneOf } = await import('@lrfe/common');
const { GoogleGenAI } = await import('@google/genai');
const { createGeminiProvider } = await import('../src/extraction/providers.js');
const { runExtraction } = await import('../src/extraction/pipeline.js');
const { createChecker } = await import('../src/extraction/checks.js');
const { normalize } = await import('../src/extraction/normalize.js');
const { docType } = await import('../src/doc-types.js');

/** What the AI should read: angular-app/docs/samples/README.md, by field key. */
const EXPECTED = {
    '01': { docType: 'deed_of_grant', fields: {
        deedNo: 'G 88/1978', regDate: '2 May 1978', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', grantor: 'the State', tee1: 'Municipality of Windhoek' } },
    '02': { docType: 'deed_of_transfer', fields: {
        deedNo: 'T 1502/1996', regDate: '19 August 1996', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', priorTitle: 'G 88/1978', transferor: 'Municipality of Windhoek',
        tee1: 'Johannes Shikongo', tee1Id: '61042500187', marital: 'unmarried', price: 'N$ 85 000,00' } },
    '03': { docType: 'sg_diagram', fields: {
        sgNo: 'A 412/2007', property: 'Erf 1873, Klein Windhoek', regDiv: 'K', extent: '1 214 square metres',
        beacons: 'A–F (6)', surveyDate: '22 October 2007', surveyor: 'L. Hamutenya, PLS 0417', approved: '30 November 2007' } },
    '04': { docType: 'deed_of_transfer', fields: {
        deedNo: 'T 2210/2008', regDate: '14 March 2008', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', sgRef: 'A 412/2007', priorTitle: 'T 1502/1996', transferor: 'Johannes Shikongo',
        transferorId: '61042500187', tee1: 'Petrus Nghishidi', tee1Id: '72110800345', tee2: 'Maria Nghishidi',
        tee2Id: '75060200418', marital: 'married in community of property', share: '½ share each',
        price: 'N$ 640 000,00', conveyancer: 'H. van Wyk' } },
    '05': { docType: 'deed_of_transfer', fields: {
        deedNo: 'T 4521/2019', regDate: '9 July 2019', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', priorTitle: 'T 2210/2008', transferor: 'Estate of the late Petrus Nghishidi',
        master: 'E 1830/2018', executor: 'D. Amukoto', tee1: 'Ndapewa Nghishidi', tee1Id: '98030100562',
        tee2: 'Tomas Nghishidi', tee2Id: '01112500379', marital: 'unmarried', share: '¼ share each',
        price: 'inheritance' },
        // Typed with 10 digits, corrected in the margin: either reading is fine if it is flagged
        note: { k: 'tee2Id', typed: '0111250379' } },
    '06': { docType: ['other', 'unknown'], fields: {} }
};

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? false : (args.splice(i, 1), true); };
const fileArg = opt('--file'), modelArg = opt('--model'), escalate = flag('--escalate'), pingOnly = flag('--ping');

if (envBool('NETWORK_PREFER_IPV4', false)) dns.setDefaultResultOrder('ipv4first');
const vertex = envBool('GEMINI_VERTEX', false);
const apiKey = process.env.GEMINI_API_KEY;
const model = modelArg || env('GEMINI_MODEL', 'gemini-3.1-flash-lite');
const escModel = env('GEMINI_ESCALATION_MODEL', 'gemini-3.1-pro-preview');
if (!vertex && !apiKey) fail(`GEMINI_API_KEY is not set (looked in ${join(serviceDir, '.env')})`);

const out = (s = '') => process.stdout.write(s + '\n');
function fail(msg) { out(`✗ ${msg}`); process.exit(2); }

// 1 · Connection: look the model up (free; proves the key, the network and the model name)
out(`Gemini ${vertex ? `Vertex AI (${process.env.GOOGLE_CLOUD_PROJECT}, ${process.env.GOOGLE_CLOUD_LOCATION})` : 'Developer API'} · key ${vertex ? 'n/a' : `…${apiKey.slice(-4)}`}`);
const ai = new GoogleGenAI(vertex ? { vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION } : { apiKey });
for (const m of [model, ...(escalate && escModel !== 'none' ? [escModel] : [])]) {
    try {
        const info = await ai.models.get({ model: m });
        out(`✓ ${m} reachable${info?.inputTokenLimit ? ` (input limit ${info.inputTokenLimit.toLocaleString('en')} tokens)` : ''}`);
    } catch (err) {
        fail(`${m}: ${err?.message || err}${/IP|referer|PERMISSION_DENIED/i.test(String(err?.message)) ? '\n  The key may be restricted to another IP address, or IPv6 was used (NETWORK_PREFER_IPV4=true).' : ''}`);
    }
}
if (pingOnly) process.exit(0);

// 2 · Documents
const common = {
    apiKey, vertex, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION,
    transcribe: envBool('GEMINI_TRANSCRIBE', true),
    thinkingLevel: envOneOf('GEMINI_THINKING_LEVEL', ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], 'LOW'),
    mediaResolution: envOneOf('GEMINI_MEDIA_RESOLUTION', ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM'),
    client: ai
};
const primary = createGeminiProvider({ ...common, model });
const escalation = escalate && escModel !== 'none' ? createGeminiProvider({ ...common, model: escModel, transcribe: false }) : null;
const checker = createChecker({ edrms: { lookupRef: async () => null } });

let files;
if (fileArg) files = [{ path: resolve(startDir, fileArg), key: null }];
else {
    const all = (await readdir(samplesDir)).filter(n => n.endsWith('.pdf')).sort();
    files = all.filter(n => !args.length || args.some(a => n.startsWith(a.padStart(2, '0'))))
        .map(n => ({ path: join(samplesDir, n), key: n.slice(0, 2) }));
    if (!files.length) fail(`No sample matches ${args.join(' ')} in ${samplesDir}`);
}

/** Same value? Typed values compare normalised (dates, extents, refs, money); text loosely. */
function same(k, type, got, want) {
    if (!got) return false;
    if (type !== 'text') {
        const a = normalize(type, got).normalized, b = normalize(type, want).normalized;
        if (a != null && b != null) return a === b;
    }
    // Every word of the expected value, in order; extra words are fine ("L. Hamutenya, Professional
    // Land Surveyor, PLS 0417" for "L. Hamutenya, PLS 0417"; "1 214 (one thousand …) square metres")
    const words = (s) => s.toLowerCase().replace(/m²|m2\b/g, 'square metres').replace(/1\/2/g, '½').replace(/1\/4/g, '¼')
        .replace(/[–—]/g, '-').split(/[^a-z0-9½¼-]+/).filter(Boolean);
    const g = words(got);
    let i = 0;
    for (const w of words(want)) { i = g.indexOf(w, i); if (i < 0) return false; i++; }
    return true;
}

let mismatches = 0, failures = 0, totalCost = 0;
for (const f of files) {
    const name = basename(f.path);
    out(`\n— ${name}`);
    let r;
    try {
        r = await runExtraction({ file: { buffer: await readFile(f.path), mimeType: 'application/pdf', fileName: name }, primary, escalation, checker });
    } catch (err) {
        failures++;
        out(`  ✗ reading failed: ${err.message}`);
        continue;
    }
    const cost = r.attempts.reduce((n, a) => n + (a.costUsd || 0), 0);
    totalCost += cost;
    for (const a of r.attempts) out(`  ${a.ok ? '·' : '✗'} ${a.role}: ${a.model}, ${a.durationMs ?? '–'} ms, ${a.usage ? `${a.usage.inputTokens} in / ${a.usage.outputTokens + (a.usage.thoughtsTokens || 0)} out tokens` : a.error}, $${(a.costUsd || 0).toFixed(5)}`);
    for (const n of r.notes) out(`  · ${n.message}`);

    const exp = f.key && EXPECTED[f.key];
    const wantTypes = exp ? [].concat(exp.docType) : null;
    const typeOk = !wantTypes || wantTypes.includes(r.answer.docType);
    if (!typeOk) mismatches++;
    out(`  ${typeOk ? '✓' : '✗'} type: ${r.answer.docType}${wantTypes && !typeOk ? ` (expected ${wantTypes.join(' or ')})` : ''}${r.answer.handwritingPresent ? ' · handwriting noticed' : ''}`);

    const defs = new Map((docType(r.answer.docType)?.fields || []).map(d => [d.k, d]));
    const rows = new Map(r.rows.map(x => [x.k, x]));
    const keys = exp ? Object.keys(exp.fields) : r.rows.map(x => x.k);
    for (const k of keys) {
        const row = rows.get(k), got = row?.extracted || '';
        const label = (defs.get(k)?.label || k).padEnd(22);
        const marks = row?.checks?.filter(c => c.level !== 'info').map(c => c.message) || [];
        const flagText = row && row.flag !== 'ok' ? ` · ${row.flag}${marks.length ? `: ${marks.join('; ')}` : ''}` : '';
        if (!exp) { out(`    ${label} ${got || '—'}${flagText}`); continue; }
        const want = exp.fields[k];
        let ok = same(k, defs.get(k)?.type || 'text', got, want);
        let extra = '';
        if (!ok && exp.note?.k === k && got.replace(/\D/g, '') === exp.note.typed) {
            ok = row.flag !== 'ok';       // the typed 10-digit number is acceptable only when the app flags it
            extra = ok ? ' (typed number, flagged: the reviewer corrects it)' : ' (typed 10-digit number NOT flagged)';
        }
        if (!ok) mismatches++;
        out(`  ${ok ? '✓' : '✗'} ${label} ${got || '—'}${ok ? '' : `  (expected ${want})`}${extra}${flagText}`);
    }
}

out(`\n${files.length} document(s), ${failures} failed, ${mismatches} value(s) differ · cost $${totalCost.toFixed(4)}`);
process.exit(failures ? 2 : mismatches ? 1 : 0);
