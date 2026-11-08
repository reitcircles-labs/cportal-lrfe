import {HttpClient, HttpResponse} from '@angular/common/http';
import {Injectable, inject} from '@angular/core';
import {firstValueFrom} from 'rxjs';

import {ProofApi, toApiError} from '@lrfe/platform';

export type {ProofKind, ProofStatus} from '@lrfe/platform';

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
    range: {from: number; to: number} | null;
    newDocuments: number;
    check: 'matches' | 'changed' | 'notOnChain';
    openFindings: number;
    lastSignoff: {
      toVersion: number;
      signedAt: string;
      signedByName: string | null;
      proof: Anchoring;
      batch: number | null;
    } | null;
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
  raisedBy: {id: string; name: string | null; at: string};
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
  proof?: {status: Anchoring; batch: number | null};
}

/** The open checkpoint of a land record (GET /audit/records/:id/check). */
export interface Checkpoint {
  recordId: string;
  recordNo: string;
  label: string;
  lastSignoff: Signoff | null;
  range: {from: number; to: number} | null;
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
  source: string;
  time: string;
  actor: {id: string | null; name: string};
  subjects: string[];
  data: Record<string, unknown>;
  hash: string;
}

/** The downloaded evidence pack. */
export interface EvidencePack {
  blob: Blob;
  fileName: string;
  manifestSha256: string;
}

/**
 * The audit service API: the trail, sign-offs, findings and evidence packs of land records, and
 * the proofs and blockchain checks of the platform (ProofApi).
 */
@Injectable({providedIn: 'root'})
export class AuditApi extends ProofApi {
  private readonly http = inject(HttpClient);

  list(query: {q?: string; filter: ListFilter; limit: number; offset: number}) {
    return this.api.get<AuditList>('/audit/records', query);
  }

  check(recordId: string) {
    return this.api.get<Checkpoint>(`/audit/records/${recordId}/check`);
  }

  signOff(recordId: string, comment?: string) {
    return this.api.post<Signoff>('/audit/signoffs', {
      recordId,
      ...(comment ? {comment} : {}),
    });
  }

  findings(recordId: string) {
    return this.api.get<{items: Finding[]}>('/audit/findings', {recordId});
  }

  raiseFinding(body: {
    recordId: string;
    version: number;
    documentId?: string;
    description: string;
  }) {
    return this.api.post<Finding>('/audit/findings', body);
  }

  answerFinding(findingId: string, text: string) {
    return this.api.post<Finding>(`/audit/findings/${findingId}/answers`, {
      text,
    });
  }

  closeFinding(
    findingId: string,
    outcome: 'agreed' | 'mistake',
    answer: string,
  ) {
    return this.api.post<Finding>(`/audit/findings/${findingId}/close`, {
      outcome,
      answer,
    });
  }

  /** Trail entries, oldest first, by subject, event type (or a family ending in a dot) and dates (API-673). */
  searchTrail(query: {
    subject?: string;
    type?: string;
    from?: string;
    to?: string;
    offset: number;
    limit: number;
  }) {
    return this.api.get<{total: number; entries: TrailEntry[]}>(
      '/audit/trail',
      query,
    );
  }

  /** The people who acted in the trail whose name contains `q`. */
  actors(q: string) {
    return this.api.get<{items: Array<{id: string; name: string}>}>(
      '/audit/trail/actors',
      {q, limit: 10},
    );
  }

  trail(recordId: string, offset: number, limit: number) {
    return this.api.get<{total: number; entries: TrailEntry[]}>(
      '/audit/trail',
      {subject: `record:${recordId}`, offset, limit},
    );
  }

  async evidence(recordId: string): Promise<EvidencePack> {
    let res: HttpResponse<Blob>;
    try {
      res = await firstValueFrom(
        this.http.get(`${this.api.base}/audit/records/${recordId}/evidence`, {
          observe: 'response',
          responseType: 'blob',
        }),
      );
    } catch (e) {
      throw toApiError(e);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const fileName =
      /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'evidence.zip';
    return {
      blob: res.body!,
      fileName,
      manifestSha256: res.headers.get('x-manifest-sha256') ?? '',
    };
  }
}
