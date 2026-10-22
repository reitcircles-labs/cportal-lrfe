import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {Injectable, inject} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {ApiError, ApiService, toApiError} from './api.service';

/** Types and calls of the extracts service (gateway prefix /api/extracts): ownership extracts. */

/** An ownership extract in the register of a land record (API-692). */
export interface Extract {
  id: string;
  /** EX-<country>-<year>-<nnnnnn>, printed on the extract; null only for development data from before numbers. */
  extractNo: string | null;
  checkCode: string | null;
  recordId: string;
  recordNo: string;
  versionNumber: number;
  issuedAt: string;
  issuedById: string;
  issuedByName: string | null;
  ownerIndex: number;
  ownerName: string;
  ownerIdLast4: string;
  status: 'valid' | 'revoked';
  revokedAt: string | null;
  revokedByName: string | null;
  revokeReason: string | null;
  pdfSha256: string;
  /** Its version is still the record's current one; null when the record could not be read. */
  isCurrentVersion: boolean | null;
}

/** What issuing an extract needs: the owner on the current version, checked at the counter. */
export interface IssueRequest {
  recordId: string;
  versionNumber: number;
  ownerIndex: number;
  idNo: string;
  documentSeen: boolean;
}

/** The extracts service API: issuing, listing, downloading again and revoking extracts. */
@Injectable({providedIn: 'root'})
export class ExtractsApi {
  private api = inject(ApiService);
  private http = inject(HttpClient);

  list(recordId: string) {
    return this.api.get<{items: Extract[]}>('/extracts', {recordId});
  }
  issue(body: IssueRequest) {
    return this.api.post<Extract>('/extracts', body);
  }
  revoke(id: string, reason: string) {
    return this.api.post<Extract>(`/extracts/${id}/revoke`, {reason});
  }
  /** The sealed PDF as issued. A refusal (a revoked extract) comes back as an ApiError with its message. */
  async pdf(id: string): Promise<Blob> {
    try {
      return await firstValueFrom(
        this.http.get(`${this.api.base}/extracts/${id}/pdf`, {
          responseType: 'blob',
        }),
      );
    } catch (e) {
      // the error body of a blob request is a blob too: read its message
      if (e instanceof HttpErrorResponse && e.error instanceof Blob) {
        let message = e.statusText || 'Request failed';
        try {
          message = JSON.parse(await e.error.text()).message || message;
        } catch {
          // not JSON: keep the status text
        }
        throw new ApiError(e.status, message);
      }
      throw toApiError(e);
    }
  }
}
