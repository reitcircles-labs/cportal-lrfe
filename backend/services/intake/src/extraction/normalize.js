/**
 * Deterministic normalisation and format checks per field type (see ../doc-types.js).
 * The model reads; this decides what a reviewer must look at. Nothing here trusts the model's
 * own confidence.
 *
 * normalize(type, raw) → { value, normalized, checks: [{ level, code, message }] }
 *   value       what the reviewer sees and what gets filed (canonical formatting for references,
 *               ID numbers and divisions; otherwise as written)
 *   normalized  machine form used for comparisons (ISO date, m² number, amount, …)
 *   level       'info' | 'warn' | 'error'   (error = must be fixed before filing)
 */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const info = (code, message) => ({ level: 'info', code, message });
const warn = (code, message) => ({ level: 'warn', code, message });
const error = (code, message) => ({ level: 'error', code, message });

const MONTHS = {
    // English, Afrikaans, German (incl. common abbreviations)
    january: 1, jan: 1, januarie: 1, januar: 1, february: 2, feb: 2, februarie: 2, februar: 2,
    march: 3, mar: 3, maart: 3, märz: 3, maerz: 3, april: 4, apr: 4, may: 5, mei: 5, mai: 5,
    june: 6, jun: 6, junie: 6, juni: 6, july: 7, jul: 7, julie: 7, juli: 7,
    august: 8, aug: 8, augustus: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, oktober: 10, okt: 10,
    november: 11, nov: 11, december: 12, dec: 12, desember: 12, des: 12, dezember: 12, dez: 12
};

const validDate = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** "14 March 2008", "the 14th day of March 2008", "14 Maart 2008", "14/03/2008", "2008-03-14" → ISO */
export function parseDate(raw) {
    const s = clean(raw).toLowerCase().replace(/\bthe\b|\bday of\b|\bdag van\b|\bden\b|,/g, ' ').replace(/(\d)(st|nd|rd|th|ste|de)\b/g, '$1').replace(/\s+/g, ' ').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return validDate(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);            // day first, as used in Namibia
    if (m) return validDate(+m[3], +m[2], +m[1]) ? iso(+m[3], +m[2], +m[1]) : null;
    m = s.match(/^(\d{1,2})\.? ([a-zäö]+)\.? (\d{4})$/);
    if (m && MONTHS[m[2]]) return validDate(+m[3], MONTHS[m[2]], +m[1]) ? iso(+m[3], MONTHS[m[2]], +m[1]) : null;
    m = s.match(/^([a-zäö]+)\.? (\d{1,2}) (\d{4})$/);
    if (m && MONTHS[m[1]]) return validDate(+m[3], MONTHS[m[1]], +m[2]) ? iso(+m[3], MONTHS[m[1]], +m[2]) : null;
    return null;
}

/** Number as written in Namibian documents: space thousands, comma or point decimals. */
function parseNumber(s, { commaIsDecimal }) {
    let t = s.replace(/[\s ']/g, '');
    if (commaIsDecimal) t = t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    else t = /,\d{3}(\D|$)/.test(t) && !/,\d{1,2}$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
}

/** "1 214 square metres", "1 214 m²", "12,3456 hectares", "12.3456 ha", "1 214 vierkante meter" → m² */
export function parseExtent(raw) {
    const s = clean(raw).toLowerCase();
    const num = s.match(/[\d][\d\s.,]*/)?.[0]?.trim();
    if (!num) return null;
    if (/\b(hectares?|ha|hektaar|hektar)\b/.test(s)) {
        const n = parseNumber(num, { commaIsDecimal: true });
        return n == null ? null : Math.round(n * 10000 * 100) / 100;
    }
    if (/(square met|sq\.? ?m|m²|m2\b|vierkante meter|quadratmeter|qm\b)/.test(s)) return parseNumber(num, { commaIsDecimal: false });
    return null;
}

/** "T2210 / 2008" → "T 2210/2008"; strips "No.", "S.G." and similar prefixes. */
function normalizeRef(raw) {
    const s = clean(raw).toUpperCase().replace(/^(DIAGRAM\s+)?(S\.?\s?G\.?\s+)?(NO\.?\s+|NR\.?\s+)?/, '');
    const m = s.match(/^([A-Z]{1,3})\s*\.?\s*(\d+)\s*\/\s*(\d{4})$/);
    return m ? { ref: `${m[1]} ${Number(m[2])}/${m[3]}`, year: +m[3] } : null;
}

const thisYear = () => new Date().getUTCFullYear();

const NORMALIZERS = {
    deed_ref(raw) {
        const r = normalizeRef(raw);
        if (!r) return { value: clean(raw), normalized: null, checks: [warn('format', 'Expected a reference like T 2210/2008')] };
        const checks = r.year < 1880 || r.year > thisYear() + 1 ? [warn('year', `Year ${r.year} looks wrong`)] : [];
        return { value: r.ref, normalized: r.ref, checks };
    },
    sg_ref(raw) {
        const r = normalizeRef(raw);
        if (!r) return { value: clean(raw), normalized: null, checks: [warn('format', 'Expected a diagram number like A 412/2007')] };
        const checks = r.year < 1880 || r.year > thisYear() + 1 ? [warn('year', `Year ${r.year} looks wrong`)] : [];
        return { value: r.ref, normalized: r.ref, checks };
    },
    id_number(raw) {
        const s = clean(raw);
        if (/[/-]/.test(s) && /[A-Za-z]|\d{4}\s*\/\s*\d+/.test(s)) {
            return { value: s, normalized: s, checks: [info('registration_number', 'Looks like a company/trust registration number, not a personal ID')] };
        }
        // Digits with separators (e.g. "6508122-01-5"): another numbering scheme or a registration
        // number — for the reviewer to judge, not an error that blocks filing.
        if (/^[\d\s-]+$/.test(s) && /-/.test(s)) {
            return { value: s, normalized: null, checks: [warn('id_format', 'Not an 11-digit Namibian ID; if the party is a trust or company this may be its registration number')] };
        }
        const digits = s.replace(/[\s.]/g, '');
        if (!/^\d+$/.test(digits)) return { value: s, normalized: null, checks: [error('id_digits', 'A Namibian ID number contains only digits')] };
        if (digits.length !== 11) return { value: digits, normalized: null, checks: [error('id_length', `A Namibian ID number has 11 digits; this has ${digits.length}`)] };
        const [yy, mm, dd] = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)].map(Number);
        const ok = [1900, 2000].some(c => validDate(c + yy, mm, dd));
        return { value: digits, normalized: digits, checks: ok ? [] : [warn('id_dob', 'The first six digits are not a valid date of birth (YYMMDD)')] };
    },
    date(raw) {
        const value = clean(raw);
        const parsed = parseDate(value);
        if (!parsed) return { value, normalized: null, checks: [warn('date_format', 'Could not read this as a date')] };
        const y = +parsed.slice(0, 4);
        const checks = y < 1880 || parsed > new Date().toISOString().slice(0, 10) ? [warn('date_range', 'Date is in the future or implausibly old')] : [];
        return { value, normalized: parsed, checks };
    },
    extent(raw) {
        const value = clean(raw);
        const m2 = parseExtent(value);
        return m2 == null
            ? { value, normalized: null, checks: [warn('extent_format', 'Could not read the area and its unit (m² or hectares)')] }
            : { value, normalized: String(m2), checks: [] };
    },
    money(raw) {
        const value = clean(raw);
        const num = value.match(/\d[\d\s.,]*/)?.[0];
        if (!num) return { value, normalized: null, checks: [info('no_amount', 'No amount (e.g. inheritance or donation)')] };
        const n = parseNumber(num.trim(), { commaIsDecimal: /,\d{2}\b/.test(num) });
        return { value, normalized: n == null ? null : String(n), checks: n == null ? [warn('amount_format', 'Could not read the amount')] : [] };
    },
    reg_div(raw) {
        const s = clean(raw).replace(/["“”'‘’]/g, '').toUpperCase().replace(/^REGISTRATION DIVISION\s+/, '');
        return /^[A-Z]{1,2}$/.test(s)
            ? { value: s, normalized: s, checks: [] }
            : { value: s, normalized: null, checks: [warn('reg_div_format', 'Expected a registration division letter, e.g. K')] };
    },
    text(raw) {
        const value = clean(raw);
        return { value, normalized: value.toLowerCase(), checks: [] };
    }
};

/** "Erf no. ________", "……": the model copied an empty line of a printed form. */
const BLANK = /_{3,}|\.{5,}|…{2,}/;

export function normalize(type, raw) {
    const r = (NORMALIZERS[type] || NORMALIZERS.text)(raw);
    if (BLANK.test(String(raw))) r.checks.push(warn('blank_template', 'Contains an empty form line (____); the real value may be elsewhere in the document'));
    return r;
}

/** Compare names loosely: case, punctuation and "Estate Late" wording ignored. */
export function sameName(a, b) {
    const n = (s) => clean(s).toLowerCase().replace(/\b(estate|late|boedel|wyle|nalatenskap)\b/g, '').replace(/[^a-z0-9!]+/g, ' ').trim();
    const x = n(a), y = n(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** Whitespace/case-insensitive "does `needle` occur in `haystack`" — used to verify model evidence. */
export function occursIn(needle, haystack) {
    const n = (s) => clean(s).toLowerCase().replace(/[“”"‘’']/g, '');
    return !!needle && n(haystack).includes(n(needle));
}
