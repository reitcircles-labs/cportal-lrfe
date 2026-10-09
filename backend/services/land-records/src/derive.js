import { normalizeSearch } from '@lrfe/common';
import { propertyMatches } from './parcel-match.js';

/**
 * What the linked documents say about the parcel (README.md section 3), and the checks a version
 * must pass before review (section 4). Works on the pinned documents' field snapshots only, so a
 * committed version can be recomputed later without asking edrms.
 */

// ---------------------------------------------------------------- small parsers

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "14 March 2008" → Date; else the year of a reference "T 2210/2008"; else null. */
export function registrationDate(fields = {}, ref = '') {
    const m = /(\d{1,2})\s+([a-z]+)\s+(\d{4})/i.exec(fields.regDate || '');
    if (m && MONTHS.includes(m[2].toLowerCase())) return new Date(Date.UTC(Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])));
    const y = /\/(\d{4})\b/.exec(ref || fields.deedNo || '');
    return y ? new Date(Date.UTC(Number(y[1]), 0, 1)) : null;
}

/** "1 214 square metres" → { value: 1214, unit: 'm2' }; "12,3456 ha" → { value: 12.3456, unit: 'ha' }. */
export function parseExtent(text) {
    if (!text) return null;
    const m = /([\d][\d\s.,]*)\s*(square\s*met(?:re|er)s?|m²|m2|sq\.?\s*m|hectares?|ha)(?![a-z])/i.exec(text);
    if (!m) return null;
    const unit = /^h/i.test(m[2]) ? 'ha' : 'm2';
    let num = m[1].trim().replace(/\s+/g, '');
    num = unit === 'ha' ? num.replace(',', '.') : num.replace(/[,.](?=\d{3}\b)/g, '').replace(',', '.');
    const value = Number(num);
    return Number.isFinite(value) && value > 0 ? { value, unit } : null;
}

// fractions: { n, d } reduced
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const frac = (n, d) => { const g = gcd(n, d) || 1; return { n: n / g, d: d / g }; };
export const parseFraction = (s) => { const m = /^(\d+)\/(\d+)$/.exec(String(s || '').trim()); return m && Number(m[2]) ? frac(Number(m[1]), Number(m[2])) : null; };
const add = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const fracText = (f) => `${f.n}/${f.d}`;

/** "½ share each" → "1/2"; "undivided quarter share each" → "1/4"; null when it does not say. */
export function shareEach(text) {
    const t = String(text || '').toLowerCase();
    const map = [[/½|\bhalf\b|\b1\/2\b/, '1/2'], [/¼|\bquarter\b|\b1\/4\b/, '1/4'], [/¾|\b3\/4\b/, '3/4'], [/⅓|\bthird\b|\b1\/3\b/, '1/3']];
    for (const [re, f] of map) if (re.test(t)) return f;
    return null;
}

/** Same person or body, ignoring case, accents, punctuation and "estate of the late". */
export function sameName(a, b) {
    const n = (s) => normalizeSearch(s).replace(/^(the )?estate (of )?(the )?(late )?/, '').trim();
    return !!a && !!b && n(a) === n(b);
}

const TITLE_TYPES = ['deed_of_transfer', 'deed_of_grant'];
const BODY = /\b(pty|ltd|limited|cc|close corporation|trust|municipality|council|state|republic|government|estate|company|bank)\b/i;

/** The holders a title deed names: transferees, or the grantee of a grant. */
function holdersOf(doc) {
    const f = doc.fields || {};
    const out = [];
    for (let i = 1; i <= 4; i++) if (f[`tee${i}`]) out.push({ name: f[`tee${i}`], idNo: f[`tee${i}Id`] || undefined });
    return out;
}

// ---------------------------------------------------------------- suggestions

/**
 * Suggested core values from the pinned documents: owners and shares (the titles in registration
 * order), extent (SG diagram, else latest deed), encumbrances (bonds), and the chain of title.
 */
export function suggestFromDocuments(documents = []) {
    const titles = documents.filter(d => TITLE_TYPES.includes(d.docType))
        .map(d => ({ d, date: registrationDate(d.fields, d.ref) }))
        .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
    const notes = [];

    const chain = titles.map(({ d, date }) => ({
        ref: d.ref, edrmsNo: d.edrmsNo, docType: d.docType, regDate: d.fields?.regDate ?? null, date: date?.toISOString().slice(0, 10) ?? null,
        priorTitle: d.fields?.priorTitle ?? null, transferor: d.fields?.transferor ?? d.fields?.grantor ?? null,
        holders: holdersOf(d).map(h => h.name)
    }));

    // owners: walk the titles in order. A grant gives the grantees the whole parcel; a transfer
    // moves the transferor's share to the transferees, the other holders keep theirs (a transferor
    // not among the holders, or no transferor named: the transferees take the whole parcel).
    let holdings = null;
    for (const { d } of titles) {
        const holders = holdersOf(d);
        if (!holders.length) continue;
        const f = d.fields || {};
        const idx = holdings && d.docType === 'deed_of_transfer' && f.transferor ? holdings.findIndex(h => sameName(h.name, f.transferor)) : -1;
        const passing = idx >= 0 ? parseFraction(holdings[idx].share) || frac(1, 1) : frac(1, 1);
        const stated = holders.length === 1 ? null : shareEach(f.share);
        if (holders.length > 1 && !stated) notes.push(`${d.ref} does not state the shares: equal shares assumed`);
        const each = stated ? parseFraction(stated) : frac(passing.n, passing.d * holders.length);
        const incoming = holders.map(h => ({
            name: h.name, ...(h.idNo ? { idNo: h.idNo } : {}), share: fracText(holders.length === 1 ? passing : each), since: d.ref,
            source: { from: 'document', edrmsNo: d.edrmsNo }
        }));
        holdings = idx >= 0 ? [...holdings.slice(0, idx), ...holdings.slice(idx + 1), ...incoming] : incoming;
    }
    const owners = holdings;

    let extent = null;
    const sg = documents.find(d => d.docType === 'sg_diagram' && parseExtent(d.fields?.extent));
    const deedWithExtent = [...titles].reverse().map(t => t.d).find(d => parseExtent(d.fields?.extent));
    const extentDoc = sg || deedWithExtent;
    if (extentDoc) extent = { ...parseExtent(extentDoc.fields.extent), source: { from: 'document', edrmsNo: extentDoc.edrmsNo } };

    const encumbrances = documents.filter(d => d.docType === 'mortgage_bond')
        .map(d => ({ type: 'bond', ref: d.ref || d.fields?.bondNo, ...(d.fields?.mortgagee ? { inFavourOf: d.fields.mortgagee } : {}) }));

    return { owners, extent, encumbrances, chain, notes };
}

// ---------------------------------------------------------------- checks

const check = (id, level, ok, message, details = []) => ({ id, level, ok, message, details });
const toM2 = (e) => (e.unit === 'ha' ? e.value * 10_000 : e.value);

/**
 * The checks of README.md section 4 on a version's data. `flags`: the record's flags (a document
 * corrected in edrms). Errors block submitting; warnings are shown to the reviewer.
 */
export function checksFor(data, { flags = [], suggested = suggestFromDocuments(data.documents) } = {}) {
    const owners = data.owners || [], docs = data.documents || [], out = [];

    // shares sum to one
    if (!owners.length) out.push(check('shares_sum', 'error', false, 'No owners yet'));
    else {
        const parts = owners.map(o => parseFraction(o.share));
        const bad = owners.filter((_, i) => !parts[i]).map(o => o.name);
        const sum = parts.filter(Boolean).reduce(add, frac(0, 1));
        const ok = !bad.length && sum.n === sum.d;
        out.push(check('shares_sum', 'error', ok, ok ? 'Shares add up to 1' : bad.length ? `Shares are not fractions: ${bad.join(', ')}` : `Shares add up to ${fracText(sum)}, not 1`,
            owners.map(o => `${o.name} ${o.share}`)));
    }

    // chain of title: every title's prior title is in the record (back to the first), and its
    // transferor was a holder under that prior title
    const chain = suggested.chain;
    const refs = new Set(chain.map(c => normalizeSearch(c.ref)));
    const problems = [];
    chain.forEach((c, i) => {
        if (i === 0 || !c.priorTitle) return;              // the first linked title starts the chain
        const prior = chain.find(p => normalizeSearch(p.ref) === normalizeSearch(c.priorTitle));
        if (!refs.has(normalizeSearch(c.priorTitle)) || !prior) { problems.push(`${c.ref} cites ${c.priorTitle}, which is not in the record`); return; }
        if (c.transferor && prior.holders.length && !prior.holders.some(h => sameName(h, c.transferor))) {
            problems.push(`${c.ref}: ${c.transferor} was not a holder under ${prior.ref} (${prior.holders.join(', ')})`);
        }
    });
    if (!chain.length) out.push(check('chain_of_title', 'error', false, 'No title deed in the record'));
    else out.push(check('chain_of_title', 'error', !problems.length,
        problems.length ? problems[0] : `${chain.map(c => c.ref).join(' → ')}`, problems));

    // extent vs SG diagram
    const sg = docs.find(d => d.docType === 'sg_diagram' && parseExtent(d.fields?.extent));
    if (!data.extent) out.push(check('extent_vs_sg', 'error', false, 'No extent yet'));
    else if (!sg) out.push(check('extent_vs_sg', 'warning', false, 'No SG diagram in the record to compare the extent with'));
    else {
        const a = toM2(data.extent), b = toM2(parseExtent(sg.fields.extent));
        const ok = Math.abs(a - b) <= Math.max(1, b * 0.005);
        out.push(check('extent_vs_sg', 'error', ok, ok ? `Extent matches ${sg.ref} (${sg.fields.extent})` : `Extent ${data.extent.value} ${data.extent.unit} differs from ${sg.ref} (${sg.fields.extent})`));
    }

    // identity numbers
    const badIds = owners.filter(o => (o.idNo ? !/^\d{11}$/.test(String(o.idNo).replace(/\s/g, '')) : !BODY.test(o.name)));
    out.push(check('id_numbers', 'error', owners.length > 0 && !badIds.length,
        !owners.length ? 'No owners yet' : badIds.length ? `Not a valid 11-digit ID number: ${badIds.map(o => `${o.name}${o.idNo ? ` (${o.idNo})` : ' (none)'}`).join(', ')}` : 'All ID numbers are valid',
        badIds.map(o => o.name)));

    // documents describe this parcel
    const foreign = docs.filter(d => d.fields?.property && !propertyMatches(data.parcel, d.fields.property));
    out.push(check('parcel_match', 'error', !foreign.length,
        foreign.length ? `Not this parcel: ${foreign.map(d => `${d.ref} (${d.fields.property})`).join(', ')}` : 'All documents describe this parcel', foreign.map(d => d.ref)));

    // documents at their current EDRMS version (flags come from edrms corrections, API-648)
    const stale = flags.filter(f => f.type === 'document_updated' && docs.some(d => d.edrmsNo === f.edrmsNo && d.version < f.to));
    out.push(check('documents_current', 'warning', !stale.length,
        stale.length ? `Newer versions in the EDRMS: ${stale.map(f => `${f.edrmsNo} v${f.to}`).join(', ')}` : 'All documents are at their current version'));

    // values entered by hand, or differing from what the documents say
    const manual = [...owners.filter(o => o.source?.from === 'manual').map(o => `owner ${o.name}`), ...(data.extent?.source?.from === 'manual' ? ['extent'] : [])];
    const differ = [];
    const ownerKey = (list) => JSON.stringify(list.map(o => [normalizeSearch(o.name), o.share, o.idNo ?? null]).sort());
    if (suggested.owners && owners.length && ownerKey(suggested.owners) !== ownerKey(owners)) differ.push('owners differ from the title deeds');
    if (suggested.extent && data.extent && toM2(suggested.extent) !== toM2(data.extent)) differ.push('extent differs from the documents');
    out.push(check('overrides', 'warning', !manual.length && !differ.length,
        manual.length || differ.length ? [manual.length ? `Entered by hand: ${manual.join(', ')}` : null, ...differ].filter(Boolean).join('; ') : 'All values come from the documents'));

    return out;
}

export const blocking = (checks) => checks.filter(c => c.level === 'error' && !c.ok);
