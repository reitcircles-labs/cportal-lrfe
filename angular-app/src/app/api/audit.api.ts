import { HttpClient, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { VerifyResult } from '../features/audit/verify-wording';
import { ApiService, toApiError } from './api.service';

/** Types and calls of the audit service (gateway prefix /api/audit). */

/** How far an item's anchoring has got (API-680). */
export type Anchoring = 'waiting' | 'sent' | 'onChain' | 'confirmed';

/** The automatic blockchain check of an item. */
export type Match = 'matches' | 'changed' | 'notOnChain' | 'unavailable';

/** The list filters of the Audit screen. */
export type ListFilter = 'changed' | 'attention' | 'all';

/** One land record in the Audit list. */
export interface AuditListItem {
  id: string;
  recordNo: string;
  label: string;
  currentVersion: number;
  changedAt: string;
  owners: string[];
  proof: Anchoring;
  /** The batch the current version is in; null while it waits for the next batch (API-699). */
  proofBatch: number | null;
  needsAttention: boolean;
  audit: {
    range: { from: number; to: number } | null;
    newDocuments: number;
    check: 'matches' | 'changed' | 'notOnChain';
    openFindings: number;
    lastSignoff: { toVersion: number; signedAt: string; signedByName: string | null; proof: Anchoring; batch: number | null } | null;
  };
}

/** The Audit list: a page of records and the count of every filter. */
export interface AuditList {
  items: AuditListItem[];
  total: number;
  counts: Record<ListFilter, number>;
}

/** A land record version in the open checkpoint. */
export interface CheckVersion {
  key: string;
  label: string;
  versionNumber: number;
  seal: string;
  approvedByName: string | null;
  committedAt: string;
  anchoring: Anchoring;
  /** The batch it is in; null while it waits for the next batch (API-699). */
  batch: number | null;
  match: Match;
  superseded?: boolean;
}

/** A document version the open checkpoint covers. */
export interface CheckDocument {
  key: string;
  label: string;
  documentId: string;
  edrmsNo: string;
  version: number;
  seal: string;
  addedIn: number;
  anchoring: Anchoring;
  /** The batch it is in; null while it waits for the next batch (API-699). */
  batch: number | null;
  match: Match;
  superseded?: boolean;
}

/** One message in a finding's thread, as the trail carries it. */
export interface FindingAnswer {
  byId: string;
  byName: string | null;
  role: string | null;
  at: string;
  text: string;
}

/** A finding (API-659, API-680). */
export interface Finding {
  id: string;
  recordId: string | null;
  recordNo: string | null;
  recordVersion: number | null;
  documentId: string | null;
  edrmsNo: string | null;
  documentVersion: number | null;
  description: string;
  status: 'open' | 'resolved' | 'closed';
  outcome: 'agreed' | 'mistake' | null;
  raisedById: string;
  raisedByName: string | null;
  raisedAt: string;
  answers: FindingAnswer[];
  closedByName: string | null;
  closeReason: string | null;
  closedAt: string | null;
  resolvedByVersion: number | null;
}

/** A finding as the check returns it (the thread under the key "Findings"). */
export interface FindingRecord {
  id: string;
  status: Finding['status'];
  recordNo: string | null;
  recordVersion: number | null;
  edrmsNo: string | null;
  documentVersion: number | null;
  raisedBy: { id: string; name: string | null; at: string };
  issue: string;
}

/** An audit sign-off (a checkpoint). */
export interface Signoff {
  id: string;
  kind: 'checkpoint' | 'item';
  fromVersion: number | null;
  toVersion: number | null;
  signedByName: string | null;
  signedAt: string;
  /** How far its trail entry has got on the blockchain, and in which batch (the checkpoint's last sign-off, API-699). */
  proof?: { status: Anchoring; batch: number | null };
}

/** The open checkpoint of a land record (GET /audit/records/:id/check). */
export interface Checkpoint {
  recordId: string;
  recordNo: string;
  label: string;
  lastSignoff: Signoff | null;
  range: { from: number; to: number } | null;
  versions: CheckVersion[];
  documents: CheckDocument[];
  openFindings: FindingRecord[];
  canSignOff: boolean;
  reason: string | null;
}

/** A trail entry (GET /audit/trail). */
export interface TrailEntry {
  seq: number;
  type: string;
  time: string;
  actor: { id: string | null; name: string };
  subjects: string[];
  data: Record<string, unknown>;
  hash: string;
}

/** What a proof can be of (GET /audit/proofs/{kind}/{id}). */
export type ProofKind = 'record-version' | 'document-version' | 'trail-entry';

/** A proof's status: in no anchoring yet, anchored, or confirmed. */
export type ProofStatus = 'waiting' | 'anchored' | 'confirmed';

/** The downloaded evidence pack. */
export interface EvidencePack {
  blob: Blob;
  fileName: string;
  manifestSha256: string;
}

@Injectable({ providedIn: 'root' })
export class AuditApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);

  list(query: { q?: string; filter: ListFilter; limit: number; offset: number }) {
    return this.api.get<AuditList>('/audit/records', query);
  }

  check(recordId: string) {
    return this.api.get<Checkpoint>(`/audit/records/${recordId}/check`);
  }

  signOff(recordId: string, comment?: string) {
    return this.api.post<Signoff>('/audit/signoffs', { recordId, ...(comment ? { comment } : {}) });
  }

  findings(recordId: string) {
    return this.api.get<{ items: Finding[] }>('/audit/findings', { recordId });
  }

  raiseFinding(body: { recordId: string; version: number; documentId?: string; description: string }) {
    return this.api.post<Finding>('/audit/findings', body);
  }

  answerFinding(findingId: string, text: string) {
    return this.api.post<Finding>(`/audit/findings/${findingId}/answers`, { text });
  }

  closeFinding(findingId: string, outcome: 'agreed' | 'mistake', answer: string) {
    return this.api.post<Finding>(`/audit/findings/${findingId}/close`, { outcome, answer });
  }

  trail(recordId: string, offset: number, limit: number) {
    return this.api.get<{ total: number; entries: TrailEntry[] }>('/audit/trail', { subject: `record:${recordId}`, offset, limit });
  }

  /** A proof file (`lrfe-audit-proof/1`), for the offline verifier (API-672). */
  proof(kind: ProofKind, id: string, version?: number) {
    return this.api.get<Record<string, unknown>>(`/audit/proofs/${kind}/${id}`, { version });
  }

  /** Check a version against the blockchain now (API-675). */
  verify(kind: ProofKind, id: string, version?: number) {
    return this.api.post<VerifyResult>('/audit/verify', { kind, id, ...(version ? { version } : {}) });
  }

  /** The anchoring wallet the installation publishes (no sign-in needed). */
  wallet() {
    return this.api.get<{ address: string | null; explorerUrl: string | null; transactionUrl: string | null }>('/audit/anchoring/wallet');
  }

  proofStatus(seq: number) {
    return this.api.get<{ status: ProofStatus; anchor: { batch: number } | null }>(`/audit/proofs/trail-entry/${seq}`);
  }

  /** The whole trail's hash chain, recomputed. */
  verifyTrail() {
    return this.api.get<{ intact: boolean; brokenAt?: number }>('/audit/trail/verify');
  }

  verifyEntry(seq: number) {
    return this.api.post<{ valid: boolean; status: ProofStatus }>('/audit/verify', { kind: 'trail-entry', id: String(seq) });
  }

  async evidence(recordId: string): Promise<EvidencePack> {
    let res: HttpResponse<Blob>;
    try {
      res = await firstValueFrom(this.http.get(`${this.api.base}/audit/records/${recordId}/evidence`, { observe: 'response', responseType: 'blob' }));
    } catch (e) {
      throw toApiError(e);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'evidence.zip';
    return { blob: res.body!, fileName, manifestSha256: res.headers.get('x-manifest-sha256') ?? '' };
  }
}
