import type {Anchoring} from '../shared/anchoring';
import {Injectable, inject} from '@angular/core';
import {ApiService} from './api.service';

/** Types and calls of the land-records service (gateway prefix /api/records). */

export type RecordStatusFilter =
  | 'draft'
  | 'committed'
  | 'in_review'
  | 'needs_review'
  | 'new_document'
  | 'in_bin';

export interface Source {
  from: 'document' | 'manual';
  edrmsNo?: string;
  by?: string;
  reason?: string;
}
export interface Owner {
  name: string;
  idNo?: string;
  share: string;
  since?: string;
  source?: Source;
}
export interface Extent {
  value: number;
  unit: 'm2' | 'ha';
  source?: Source;
}
export interface Encumbrance {
  type: 'bond' | 'servitude' | 'other';
  ref: string;
  inFavourOf?: string;
  note?: string;
}
export interface PinnedDocument {
  edrmsDocumentId: string;
  edrmsNo: string;
  version: number;
  seal: string;
  docType: string;
  ref: string | null;
  addedBy?: string;
  addedAt?: string;
  fields: Record<string, string>;
}
export interface Parcel {
  kind: string;
  [k: string]: unknown;
}
export interface VersionData {
  schemaVersion: string;
  parcel: Parcel;
  extent?: Extent;
  tenure?: 'freehold' | 'leasehold' | 'other';
  owners?: Owner[];
  encumbrances?: Encumbrance[];
  attributes?: Record<string, unknown>;
  documents?: PinnedDocument[];
}
/** Why a document's property does not describe the parcel: the parcel's words it does not name. */
export interface Mismatch {
  missing: string[];
  otherPortion: boolean;
}
export interface Check {
  id: string;
  level: 'error' | 'warning';
  ok: boolean;
  message: string;
  details: string[];
  /** On "documents describe this parcel": why, per document. */
  mismatches?: Array<Mismatch & {edrmsDocumentId: string}>;
}
export interface ChainEntry {
  ref: string;
  edrmsNo: string;
  docType: string;
  regDate: string | null;
  date: string | null;
  priorTitle: string | null;
  transferor: string | null;
  holders: string[];
}
export interface Derived {
  owners: Owner[] | null;
  extent: Extent | null;
  encumbrances: Encumbrance[];
  chain: ChainEntry[];
  notes: string[];
}
export interface Change {
  at: string;
  byId: string;
  byName: string | null;
  action: string;
  [k: string]: unknown;
}
export interface Version {
  id: string;
  recordId: string;
  versionNumber: number;
  state: 'draft' | 'in_review' | 'committed' | 'superseded';
  revision: number;
  data: VersionData;
  derived: Derived | null;
  checks: Check[];
  changes: Change[];
  reviewComment: string | null;
  submittedById: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
  approvedByName: string | null;
  committedAt: string | null;
  seal: string | null;
  /** The bpm review of this version, while (or since) it was submitted. */
  reviewInstanceId?: string | null;
}
/**
 * A note on a record: a linked document was corrected in the EDRMS (`document_updated`, from and
 * to its versions), or a document was filed for the parcel and is not in the record yet
 * (`document_filed`, API-766).
 */
export interface Flag {
  type: 'document_updated' | 'document_filed';
  edrmsDocumentId: string;
  edrmsNo: string;
  ref: string | null;
  from?: number;
  to?: number;
  reason?: string;
  docType?: string | null;
  matchedBy?: 'property' | 'chain';
  message: string;
  at: string;
}
/** A "new document" flag that ended: dismissed (who, when, why), or its document added to a draft. */
export interface FlagLogEntry {
  flag: Flag;
  outcome: 'dismissed' | 'added';
  dismissedAt?: string;
  dismissedById?: string;
  dismissedByName?: string | null;
  reason?: string;
  versionNumber?: number;
}
export interface RecordSummary {
  id: string;
  recordNo: string;
  kind: string;
  label: string;
  parcelKey: string;
  status: 'draft' | 'committed';
  currentVersion: number | null;
  draftVersion: number | null;
  draftState: 'draft' | 'in_review' | null;
  needsReview: boolean;
  /** Documents filed for the parcel that are not in the record yet. */
  newDocuments: number;
  /** Moved to the bin (API-767): in no list but the bin's, and not changed until restored. */
  inBin: boolean;
  discardedAt: string | null;
  bin: {at: string; byName: string | null; reason: string} | null;
  flags: Flag[];
  createdAt: string;
  updatedAt: string;
}
/** An owner's share and ID number, before or after a change. */
export interface OwnerTerms {
  share: string;
  idNo: string | null;
}

/** A document in a diff; `fromVersion` is set when its version changed. */
export interface DiffDocument {
  edrmsDocumentId: string;
  edrmsNo: string;
  docType: string;
  version: number;
  ref: string | null;
  fromVersion?: number;
}

export interface Diff {
  fields: Array<{path: string; before: unknown; after: unknown}>;
  owners: {
    added: Owner[];
    removed: Owner[];
    changed: Array<{name: string; before: OwnerTerms; after: OwnerTerms}>;
  };
  encumbrances: {added: Encumbrance[]; removed: Encumbrance[]};
  documents: {
    added: DiffDocument[];
    removed: DiffDocument[];
    updated: DiffDocument[];
  };
  empty: boolean;
  against: 'current' | null;
}
export interface Review {
  record: RecordSummary;
  version: Version;
  checks: Check[];
  blocking: string[];
  overrides: Array<{what: string; by: string | null; reason: string | null}>;
  diff: Diff;
  currentVersion: {
    versionNumber: number;
    seal: string;
    committedAt: string;
  } | null;
}
export interface HistoryVersion {
  versionNumber: number;
  state: 'committed' | 'superseded';
  current: boolean;
  submittedAt: string | null;
  submittedByName: string | null;
  approvedByName: string | null;
  committedAt: string;
  reviewComment: string | null;
  seal: string;
  previousSeal: string | null;
  intact: boolean;
  linked: boolean;
  diff: Diff;
  anchoring?: Anchoring | null;
}
export interface History {
  recordId: string;
  recordNo: string;
  label: string;
  intact: boolean;
  flags: Flag[];
  flagLog: FlagLogEntry[];
  binLog: BinLogEntry[];
  versions: HistoryVersion[];
}
/** Moved to the bin, restored, or a change discarded (with what it changed): who, when, why. */
export interface BinLogEntry {
  action: 'discarded' | 'restored' | 'draft_discarded';
  at: string;
  byId: string;
  byName: string | null;
  reason?: string;
  versionNumber?: number;
  diff?: Diff;
}
export interface LandRecord extends RecordSummary {
  current: Version | null;
  draft: Version | null;
  draftDiff: Diff | null;
}
export interface FoundDocument {
  edrmsDocumentId: string;
  edrmsNo: string;
  docType: string;
  title: string;
  ref: string | null;
  property: string | null;
  currentVersion: number;
  filedAt: string;
  inThisRecord: boolean;
  linkedTo: Array<{recordId: string; recordNo: string; label: string}>;
  reasons?: string[];
  /** The verified metadata, labelled as on the Documents screen. */
  fields: DocumentField[];
}
export interface DocumentField {
  k: string;
  label: string;
  v: string;
  edited?: boolean;
}
/** A filed document before creating a record: whether it describes the parcel as filled in. */
export interface PreviewDocument extends FoundDocument {
  chosen: boolean;
  matches: boolean;
  mismatch?: Mismatch;
}
/** What POST /records/preview says about a parcel before its record is created. */
export interface CreatePreview {
  document: FoundDocument | null;
  read: Parcel | null;
  parcel: Parcel | null;
  missing: string[];
  suggested: Record<string, {value: string; from: number}>;
  documents: PreviewDocument[];
  existing: (RecordSummary & {hasDocument: boolean}) | null;
}
/** A version as GET /records/:id/versions lists it, with its change log. */
export interface VersionSummary {
  versionNumber: number;
  state: Version['state'];
  createdAt: string;
  createdByName: string | null;
  submittedAt: string | null;
  submittedByName: string | null;
  approvedByName: string | null;
  committedAt: string | null;
  seal: string | null;
  changes: Change[];
}
export interface Comment {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  versionNumber: number | null;
}
export interface ParcelKind {
  id: string;
  label: string;
  schemaVersion: string;
  // JSON Schemas of a version (complete, and as a draft); read as plain JSON.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draftSchema: any;
}

/** The land-records service API: records, drafts, versions, review and comments. */
@Injectable({providedIn: 'root'})
export class RecordsApi {
  private api = inject(ApiService);

  catalogue() {
    return this.api.get<{parcelKinds: ParcelKind[]}>('/records/catalogue');
  }
  list(q?: string, status?: RecordStatusFilter) {
    return this.api.get<{items: RecordSummary[]; total: number}>('/records', {
      q,
      status,
      limit: 200,
    });
  }
  moveToBin(id: string, reason: string) {
    return this.api.post<LandRecord>(`/records/${id}/bin`, {reason});
  }
  restore(id: string) {
    return this.api.post<LandRecord>(`/records/${id}/restore`);
  }
  discardDraft(id: string, reason: string) {
    return this.api.post<LandRecord>(`/records/${id}/draft/discard`, {reason});
  }
  get(id: string) {
    return this.api.get<LandRecord>(`/records/${id}`);
  }
  create(body: {parcel?: Parcel; edrmsDocumentId?: string}) {
    return this.api.post<LandRecord>('/records', body);
  }
  preview(body: {parcel?: Parcel; edrmsDocumentId?: string}) {
    return this.api.post<CreatePreview>('/records/preview', body);
  }
  documentDetails(edrmsDocumentId: string) {
    return this.api.get<FoundDocument>(
      `/records/document-details/${edrmsDocumentId}`,
    );
  }
  edit(
    id: string,
    body: {
      revision: number;
      changes?: Record<string, unknown>;
      accept?: string[];
      reason?: string;
    },
  ) {
    return this.api.patch<LandRecord>(`/records/${id}/draft`, body);
  }
  link(id: string, revision: number, edrmsDocumentId: string) {
    return this.api.post<LandRecord>(`/records/${id}/draft/documents`, {
      revision,
      edrmsDocumentId,
    });
  }
  unlink(id: string, revision: number, edrmsDocumentId: string) {
    return this.api.delete<LandRecord>(
      `/records/${id}/draft/documents/${edrmsDocumentId}`,
      {revision},
    );
  }
  refresh(id: string, revision: number, edrmsDocumentId: string) {
    return this.api.post<LandRecord>(
      `/records/${id}/draft/documents/${edrmsDocumentId}/refresh`,
      {revision},
    );
  }
  openDraft(id: string) {
    return this.api.post<LandRecord>(`/records/${id}/draft`);
  }
  submit(id: string, revision: number) {
    return this.api.post<LandRecord>(`/records/${id}/draft/submit`, {revision});
  }
  withdraw(id: string) {
    return this.api.post<LandRecord>(`/records/${id}/draft/withdraw`);
  }
  dismissFlag(id: string, edrmsDocumentId: string, reason: string) {
    return this.api.post<LandRecord>(`/records/${id}/flags/dismiss`, {
      edrmsDocumentId,
      reason,
    });
  }
  searchDocuments(q: string, recordId?: string) {
    return this.api.get<{items: FoundDocument[]; total: number}>(
      '/records/document-search',
      {q, recordId, limit: 30},
    );
  }
  suggestions(id: string) {
    return this.api.get<{items: FoundDocument[]}>(`/records/${id}/suggestions`);
  }
  review(id: string) {
    return this.api.get<Review>(`/records/${id}/review`);
  }
  history(id: string) {
    return this.api.get<History>(`/records/${id}/history`);
  }
  versions(id: string) {
    return this.api.get<VersionSummary[]>(`/records/${id}/versions`);
  }
  version(id: string, n: number) {
    return this.api.get<Version>(`/records/${id}/versions/${n}`);
  }
  comments(id: string) {
    return this.api.get<{items: Comment[]}>(`/records/${id}/comments`);
  }
  comment(id: string, body: string) {
    return this.api.post<Comment>(`/records/${id}/comments`, {body});
  }
  contentLink(edrmsDocumentId: string, version?: number) {
    return this.api.get<{url: string}>(
      `/documents/${edrmsDocumentId}/content`,
      {version},
    );
  }
}
