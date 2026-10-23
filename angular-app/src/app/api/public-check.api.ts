import {Injectable, inject} from '@angular/core';
import {ApiService} from './api.service';

/** The public check of an ownership extract (gateway prefix /api/public/extracts, no sign-in). */

/** The one state the check answers (backend/services/extracts/README.md, "The public check"). */
export type CheckState =
  'current' | 'replaced' | 'revoked' | 'mismatch' | 'unknown' | 'unavailable';

/** The answer: every field always there, null where it does not apply; nothing personal. */
export interface CheckAnswer {
  state: CheckState;
  extractId: string | null;
  extractNo: string | null;
  recordNo: string | null;
  versionNumber: number | null;
  issuedAt: string | null;
  /** The SHA-256 of the PDF as issued, to compare a file with in the browser. */
  pdfSha256: string | null;
  /** The last 8 characters of the version's fingerprint. */
  fingerprintEnd: string | null;
  batch: number | null;
  transactionId: string | null;
  explorerUrl: string | null;
  replacedAt: string | null;
  revokedAt: string | null;
  checkedAt: string;
  /** The IANA time zone the extract prints its dates in, e.g. Africa/Windhoek (API-786). */
  timeZone: string;
}

/** The registry's seal certificate, published for the offline check (API-694). */
export interface SealCertificate {
  subject: string;
  sha256: string;
  validFrom: string;
  validTo: string;
}

/** The calls the public check page makes, without a sign-in. */
@Injectable({providedIn: 'root'})
export class PublicCheckApi {
  private api = inject(ApiService);

  /** The check of the extract with this QR code token or typed check code. */
  check(code: string) {
    return this.api.get<CheckAnswer>(
      `/public/extracts/${encodeURIComponent(code)}`,
    );
  }
  seal() {
    return this.api.get<SealCertificate>('/public/extracts/seal');
  }
}
