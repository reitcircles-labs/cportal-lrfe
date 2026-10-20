import {Injectable, inject} from '@angular/core';

import {ApiService} from './api.service';

/** Types and calls of the Anchorings screens (audit service, gateway prefix /api/audit; API-671, API-696, API-697). */

/** How far a batch has got. */
export type BatchStatus = 'sent' | 'onChain' | 'confirmed' | 'failed';

/** The list filters. */
export type BatchFilter = 'all' | 'progress' | 'failed';

/** Why a batch failed. */
export type FailReason = 'expired' | 'rolledBackExpired' | 'refused';

/** One batch as the list shows it. */
export interface BatchRow {
  batch: number;
  createdAt: string;
  status: BatchStatus;
  covers: number | null;
  txHash: string | null;
  explorerUrl: string | null;
  block: number | null;
  confirmations: number | null;
  reason: FailReason | null;
  replacedBy: number | null;
  replaces: number | null;
}

/** When the next batch is due and how many fingerprints wait for it. */
export interface NextBatch {
  dueAt: string;
  waiting: number;
}

/** A page of batches, with the count of every filter. */
export interface BatchList {
  items: BatchRow[];
  total: number;
  counts: Record<BatchFilter, number>;
  confirmationsNeeded: number;
  next: NextBatch | null;
}

/** One batch in detail. */
export interface BatchDetail extends BatchRow {
  root: string;
  size: number;
  prev: {root: string; batch: number | null} | null;
  steps: {
    createdAt: string;
    sentAt: string | null;
    sends: number;
    onChainAt: string | null;
    confirmedAt: string | null;
    failedAt: string | null;
  };
  replacement: {batch: number; status: BatchStatus; createdAt: string} | null;
  previousBatch: number | null;
  nextBatch: number | null;
  confirmationsNeeded: number;
}

/** A land record version in a batch, with what its fingerprint stands for. */
export interface CoveredVersion {
  versionNumber: number;
  documents: number;
  documentsEarlier: number;
  versionsBefore: number;
}

/** A land record with a version or an audit sign-off in a batch. */
export interface CoveredRecord {
  recordId: string;
  recordNo: string | null;
  label: string | null;
  versions: CoveredVersion[];
  signoffs: Array<{from: number; to: number}>;
}

/** What a batch covers. */
export interface BatchCoverage {
  batch: number;
  kinds: {recordVersions: number; documentVersions: number; signoffs: number};
  trailUpTo: number | null;
  records: CoveredRecord[];
  total: number;
}

/** A document version a batch put on the blockchain for the first time. */
export interface BatchDocument {
  documentId: string;
  version: number;
  edrmsNo: string | null;
  docType: string | null;
  ref: string | null;
  usedIn: Array<{
    recordId: string;
    versionNumber: number;
    recordNo: string | null;
    label: string | null;
  }>;
}

/** The status of an item in a search result: its batch's, or waiting, or not recorded. */
export type ItemStatus =
  'waiting' | 'sent' | 'onChain' | 'confirmed' | 'notRecorded';

/** The plain answer of a search. */
export interface LookupAnswer {
  status: 'yes' | 'sent' | 'waiting' | 'notRecorded';
  version: number | null;
  batch?: number;
  nextDueAt?: string | null;
}

/** One line of a search result's history. */
export interface HistoryItem {
  kind: 'version' | 'document' | 'signoff' | 'usedIn';
  at: string | null;
  status: ItemStatus;
  batch: number | null;
  versionNumber?: number;
  version?: number;
  documentId?: string;
  edrmsNo?: string | null;
  docType?: string | null;
  ref?: string | null;
  from?: number;
  to?: number;
  recordId?: string;
  recordNo?: string | null;
  label?: string | null;
  documentVersion?: number;
}

/** A search's result: nothing, land records to choose from, one land record, or one document. */
export type LookupResult =
  | {query: string; kind: 'none'}
  | {
      query: string;
      kind: 'choices';
      choices: Array<{recordId: string; recordNo: string; label: string}>;
    }
  | {
      query: string;
      kind: 'record';
      record: {
        id: string;
        recordNo: string;
        label: string;
        currentVersion: number | null;
        committedAt: string | null;
      };
      answer: LookupAnswer;
      history: HistoryItem[];
    }
  | {
      query: string;
      kind: 'document';
      document: {
        id: string;
        edrmsNo: string;
        docType: string;
        ref: string | null;
        currentVersion: number;
      };
      answer: LookupAnswer;
      history: HistoryItem[];
    };

/** The anchorings API of the audit service: batches and their coverage. */
@Injectable({providedIn: 'root'})
export class AnchoringsApi {
  private readonly api = inject(ApiService);

  list(query: {status: BatchFilter; limit: number; offset: number}) {
    return this.api.get<BatchList>('/audit/anchors', query);
  }

  detail(batch: number) {
    return this.api.get<BatchDetail>(`/audit/anchors/${batch}`);
  }

  coverage(batch: number, limit: number, offset: number) {
    return this.api.get<BatchCoverage>(`/audit/anchors/${batch}/coverage`, {
      limit,
      offset,
    });
  }

  documents(batch: number, limit: number, offset: number) {
    return this.api.get<{batch: number; items: BatchDocument[]; total: number}>(
      `/audit/anchors/${batch}/documents`,
      {limit, offset},
    );
  }

  lookup(q: string) {
    return this.api.get<LookupResult>('/audit/anchors/lookup', {q});
  }

  /** The document types' labels, by id. */
  async documentTypes(): Promise<Map<string, string>> {
    const {docTypes} = await this.api.get<{
      docTypes: Array<{id: string; label: string}>;
    }>('/document-catalogue');
    return new Map(docTypes.map(t => [t.id, t.label]));
  }
}
