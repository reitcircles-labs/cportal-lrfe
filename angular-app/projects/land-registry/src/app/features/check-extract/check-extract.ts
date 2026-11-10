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

/** The viewer's own time zone, as the browser reports it. */
const viewerTimeZone = (): string =>
  new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "Windhoek time" for Africa/Windhoek, "Buenos Aires time" for America/Argentina/Buenos_Aires, "UTC". */
export function timeZoneName(timeZone: string): string {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 'UTC';
  const city = timeZone.split('/').pop()!.replace(/_/g, ' ');
  return `${city} time`;
}

/**
 * "21 Oct 2026, 10:41", in `timeZone`, the one the extract prints its dates in (API-786), so the
 * page shows the times on the extract; named when it is not the viewer's, "21 Oct 2026, 10:41
 * (Windhoek time)". Without a time zone, in the viewer's.
 */
export function dateTime(
  iso: string | null,
  timeZone?: string | null,
  viewer: string = viewerTimeZone(),
): string {
  if (!iso) return '';
  const at = new Date(iso);
  const zone = timeZone ?? undefined;
  const date = at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: zone,
  });
  const time = at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  });
  const named = zone && zone !== viewer ? ` (${timeZoneName(zone)})` : '';
  return `${date}, ${time}${named}`;
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
