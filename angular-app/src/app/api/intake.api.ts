import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

/** Types and calls of the intake service (gateway prefix /api/intake). */

export type IntakeStatus = 'queued' | 'extracting' | 'ready' | 'failed' | 'filed' | 'rejected';
export type FieldFlag = 'ok' | 'check' | 'conflict' | 'missing';
export type FieldStatus = 'pending' | 'accepted' | 'edited';

export interface IntakeCheck { level: 'error' | 'warn' | 'info'; code: string; message: string; ref?: string; }
export interface IntakeNote { level: 'error' | 'warn' | 'info'; code: string; message: string; }

export interface IntakeField {
  k: string; label: string; type: string; required: boolean;
  extracted: string | null; evidence: { page: number | null; text: string } | null; model: string | null;
  value: string; normalized: string | null; status: FieldStatus; checks: IntakeCheck[]; flag: FieldFlag;
  alt: { reading?: 'first' | 'second'; value: string } | null;
}

export interface IntakeBatch {
  id: string; registry: string; source: string; createdByName: string; createdAt: string;
  counts: Partial<Record<IntakeStatus, number>> & { total: number };
}

export interface IntakeSummary {
  id: string; batchId: string; status: IntakeStatus; fileName: string; mimeType: string; size: number; pages: number | null;
  docType: string | null; docTypeLabel: string | null; ref: string | null; property: string | null;
  flags: Record<FieldFlag, number>; reviewed: number; total: number;
  escalated: boolean; extractionCostUsd: number; extractionError: string | null;
  capturedAt: string; capturedByName: string;
  claimedById: string | null; claimedByName: string | null;
  edrmsNo: string | null; filedDocumentId: string | null; rejectedReason: string | null;
}

export interface IntakeDetail extends IntakeSummary {
  docTypeReason: string | null; languages: string[]; handwritingPresent: boolean;
  fields: IntakeField[]; notes: IntakeNote[]; version: number;
  transcription: { page: number; text: string }[];
  extractions: { id: string; role: string; ok: boolean; model: string; costUsd: number | null; error: string | null; createdAt: string }[];
}

export interface IntakeDocType { id: string; label: string; refField: string | null; fields: { k: string; label: string; type: string; required: boolean }[]; }

/** Statuses still moving without a person: the screens poll while any document is in one. */
export const IN_PROGRESS: IntakeStatus[] = ['queued', 'extracting'];

export const STATUS_LABEL: Record<IntakeStatus, string> = {
  queued: 'Queued', extracting: 'Reading', ready: 'In review', failed: 'Failed', filed: 'Filed', rejected: 'Rejected'
};

/** Fields that still need a person's look (not counting fields already accepted or corrected). */
export const needsChecks = (d: IntakeSummary) => d.flags.check + d.flags.conflict + d.flags.missing;

@Injectable({ providedIn: 'root' })
export class IntakeApi {
  private api = inject(ApiService);

  catalogue() { return this.api.get<{ docTypes: IntakeDocType[] }>('/intake/catalogue'); }
  batches() { return this.api.get<{ batches: IntakeBatch[] }>('/intake/batches'); }
  createBatch(source: string) { return this.api.post<IntakeBatch>('/intake/batches', { source }); }

  /** One file per request (the service takes a single `file` part). */
  upload(batchId: string, file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.api.post<IntakeSummary>(`/intake/batches/${encodeURIComponent(batchId)}/documents`, form);
  }

  documents(query: { batchId?: string; status?: IntakeStatus[]; q?: string; limit?: number } = {}) {
    return this.api.get<{ items: IntakeSummary[]; total: number }>('/intake/documents', {
      batchId: query.batchId, q: query.q, limit: query.limit ?? 500, status: query.status?.join(',')
    });
  }
  document(id: string) { return this.api.get<IntakeDetail>(`/intake/documents/${id}`); }
  fileLink(id: string) { return this.api.get<{ url: string; expiresIn: number }>(`/intake/documents/${id}/file-link`); }

  claim(id: string) { return this.api.post<IntakeSummary>(`/intake/documents/${id}/claim`); }
  release(id: string) { return this.api.post<IntakeSummary>(`/intake/documents/${id}/release`); }
  setValue(id: string, k: string, value: string) { return this.api.put<IntakeDetail>(`/intake/documents/${id}/fields/${k}`, { value }); }
  setStatus(id: string, k: string, status: 'accepted' | 'pending') { return this.api.put<IntakeDetail>(`/intake/documents/${id}/fields/${k}`, { status }); }
  acceptClean(id: string) { return this.api.post<IntakeDetail>(`/intake/documents/${id}/accept-clean`); }
  extract(id: string, escalate = false) { return this.api.post<IntakeSummary>(`/intake/documents/${id}/extract`, { escalate }); }
  file(id: string) { return this.api.post<IntakeSummary>(`/intake/documents/${id}/file`); }
  reject(id: string, reason: string) { return this.api.post<IntakeSummary>(`/intake/documents/${id}/reject`, { reason }); }
}
