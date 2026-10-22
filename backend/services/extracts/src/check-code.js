import {randomBytes} from 'node:crypto';

/** Check codes (API-692): printed on an extract for typing in on the public check page. */

/** The characters of a check code: digits and capitals without I, L, O and U, which are misread. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A check code (API-692): 12 random characters of CODE_ALPHABET, for typing in on the check page. */
export function newCheckCode() {
  return [...randomBytes(12)].map(b => CODE_ALPHABET[b % 32]).join('');
}

/**
 * A check code as typed in: capitals, without spaces or dashes, and the letters that look like
 * digits read as those digits (O as 0, I and L as 1). Null when it can't be a check code.
 */
export function normalizeCheckCode(typed) {
  const code = String(typed ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(code) ? code : null;
}

/** A check code as printed: three groups of four ("K7QF 2M9D XH4T"). */
export const printedCheckCode = code => code.match(/.{4}/g).join(' ');
