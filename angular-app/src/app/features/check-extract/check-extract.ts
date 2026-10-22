/**
 * The check page's rules that need no screen (API-693): reading a typed check code, the dates it
 * prints, and comparing a PDF file with the extract as issued, in the browser.
 */

/** The check code's characters: digits and capitals without I, L, O and U (API-692). */
const CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/**
 * A check code as typed, the way the registry reads it: spaces, dashes and lower case ignored, O
 * read as 0, I and L as 1. Null when it is not 12 such characters.
 */
export function typedCode(typed: string): string | null {
  const code = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CODE.test(code) ? code : null;
}

/** "K7QF 2M9D XH4T", as the extract prints it. */
export const printedCode = (code: string): string =>
  (code.match(/.{1,4}/g) ?? []).join(' ');

/** "21 Oct 2026, 10:41", in the reader's time zone. */
export function dateTime(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  const date = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${date}, ${time}`;
}

/** What a file compared with the extract as issued is. */
export type FileVerdict = 'match' | 'nomatch' | 'notpdf';

/** The first bytes of every PDF file. */
const PDF_START = '%PDF-';

/**
 * Compares `bytes` with the PDF the registry issued and sealed (its SHA-256, `issuedSha256`):
 * `match` only for exactly that file, `notpdf` for a file that is no PDF at all. Runs in the
 * browser: the file is never uploaded.
 */
export async function fileVerdict(
  bytes: ArrayBuffer,
  issuedSha256: string,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<FileVerdict> {
  const start = String.fromCharCode(
    ...new Uint8Array(bytes.slice(0, PDF_START.length)),
  );
  if (start !== PDF_START) return 'notpdf';
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  const hex = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === issuedSha256.toLowerCase() ? 'match' : 'nomatch';
}
