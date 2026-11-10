import {domain} from '@lrfe/common';

/**
 * Deterministic normalisation and format checks per field type (see ../doc-types.js). The field
 * types and their checks are the product's (`documents.fieldTypes` of the domain pack, CB-3);
 * `text`, and any type the pack does not check, is kept as written.
 * The model reads; this decides what a reviewer must look at. Nothing here trusts the model's
 * own confidence.
 *
 * normalize(type, raw) → { value, normalized, checks: [{ level, code, message }] }
 *   value       what the reviewer sees and what gets filed (canonical formatting for references,
 *               ID numbers and divisions; otherwise as written)
 *   normalized  machine form used for comparisons (ISO date, m² number, amount, …)
 *   level       'info' | 'warn' | 'error'   (error = must be fixed before filing)
 */

const clean = s =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const warn = (code, message) => ({level: 'warn', code, message});

/**
 * A text field: kept as written, compared in lower case.
 * @param {string} raw
 * @return {{value: string, normalized: string, checks: Array<object>}}
 */
function text(raw) {
  const value = clean(raw);
  return {value, normalized: value.toLowerCase(), checks: []};
}

/** "No. ________", "……": the model copied an empty line of a printed form. */
const BLANK = /_{3,}|\.{5,}|…{2,}/;

/**
 * A read value cleaned up for its field type, with the checks it gave (e.g. a blank form line).
 * @param {string} type the field type
 * @param {string} raw the value as read
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {{value: string, normalized: ?string, checks: Array<object>}}
 */
export function normalize(type, raw, pack = domain) {
  const types = pack.documents.fieldTypes ?? {};
  const r = Object.hasOwn(types, type) ? types[type](raw) : text(raw);
  if (BLANK.test(String(raw))) {
    r.checks.push(
      warn(
        'blank_template',
        'Contains an empty form line (____); the real value may be elsewhere in the document',
      ),
    );
  }
  return r;
}

/** Whitespace/case-insensitive "does `needle` occur in `haystack`" — used to verify model evidence. */
export function occursIn(needle, haystack) {
  const n = s =>
    clean(s)
      .toLowerCase()
      .replace(/[“”"‘’']/g, '');
  return !!needle && n(haystack).includes(n(needle));
}
