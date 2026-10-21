import {orgFromEnv} from '@lrfe/common';

/** The legal wording until the registry's legal advisers have settled it (EXTRACTS_LEGAL_TEXT). */
export const DEFAULT_LEGAL_TEXT =
  '[Legal wording: what this extract certifies, to be confirmed by the registry’s legal advisers.]';

/** The check page's address outside production when none is set: the web app on this machine. */
const DEV_CHECK_URL_BASE = 'http://localhost:4200/#/check';

/**
 * What the extract's PDF says that belongs to the site, not the code (README.md, "Settings"):
 *   org           the organisation running the portal (LRFE_ORG_*, as identity and audit read it)
 *   checkUrlBase  EXTRACTS_CHECK_URL_BASE: the public check page; the QR code holds <base>/<token>.
 *                 Not set: <LRFE_PUBLIC_URL>/#/check, the portal's own address
 *   legalText     EXTRACTS_LEGAL_TEXT: what the extract certifies, in the registry's words
 *   timeZone      EXTRACTS_TIME_ZONE: the IANA time zone of the dates printed (the server's if unset)
 * One of the two is required with NODE_ENV=production: a QR code must never point to a development
 * machine.
 */
export function extractSettingsFromEnv(source = process.env) {
  const publicUrl = (source.LRFE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  const checkUrlBase =
    (source.EXTRACTS_CHECK_URL_BASE ?? '').trim() ||
    (publicUrl ? `${publicUrl}/#/check` : '');
  if (!checkUrlBase && source.NODE_ENV === 'production') {
    throw new Error(
      'EXTRACTS_CHECK_URL_BASE or LRFE_PUBLIC_URL is required: the address of the public check page the QR code opens',
    );
  }
  const timeZone = (source.EXTRACTS_TIME_ZONE ?? '').trim() || undefined;
  // an unknown time zone fails here, at start, not when an extract is issued
  new Intl.DateTimeFormat('en-GB', {timeZone});
  return {
    org: orgFromEnv(source),
    checkUrlBase: checkUrlBase || DEV_CHECK_URL_BASE,
    legalText: (source.EXTRACTS_LEGAL_TEXT ?? '').trim() || DEFAULT_LEGAL_TEXT,
    timeZone,
  };
}
