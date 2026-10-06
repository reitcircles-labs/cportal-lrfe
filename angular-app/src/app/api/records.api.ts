import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

/** Types and calls of the land-records service (gateway prefix /api/records). */

export type RecordStatusFilter = 'draft' | 'committed' | 'in_review' | 'needs_review';

export interface Source { from: 'document' | 'manual'; edrmsNo?: string; by?: string; reason?: string; }
export interface Owner { name: string; idNo?: string; share: string; since?: string; source?: Source; }
export interface Extent { value: number; unit: 'm2' | 'ha'; source?: Source; }
export interface Encumbrance { type: 'bond' | 'servitude' | 'other'; ref: string; inFavourOf?: string; note?: string; }
export interface PinnedDocument {
  edrmsDocumentId: string; edrmsNo: string; version: number; seal: string; docType: string; ref: string | null;
  addedBy?: string; addedAt?: string; fields: Record<string, string>;
}
export interface Parcel { kind: string; [k: string]: any; }
export interface VersionData {
  schemaVersion: string; parcel: Parcel; extent?: Extent; tenure?: 'freehold' | 'leasehold' | 'other';
  owners?: Owner[]; encumbrances?: Encumbrance[]; attributes?: Record<string, any>; documents?: PinnedDocument[];
}
export interface Check { id: string; level: 'error' | 'warning'; ok: boolean; message: string; details: string[]; }
export interface ChainEntry { ref: string; edrmsNo: string; docType: string; regDate: string | null; date: string | null; priorTitle: string | null; transferor: string | null; holders: string[]; }
export interface Derived { owners: Owner[] | null; extent: Extent | null; encumbrances: Encumbrance[]; chain: ChainEntry[]; notes: string[]; }
export interface Change { at: string; byId: string; byName: string | null; action: string; [k: string]: any; }
export interface Version {
  id: string; recordId: string; versionNumber: number; state: 'draft' | 'in_review' | 'committed' | 'superseded'; revision: number;
  data: VersionData; derived: Derived | null; checks: Check[]; changes: Change[];
  reviewComment: string | null; submittedById: string | null; submittedByName: string | null; submittedAt: string | null;
  approvedByName: string | null; committedAt: string | null; seal: string | null;
}
export interface Flag { type: string; edrmsDocumentId: string; edrmsNo: string; ref: string | null; from: number; to: number; reason?: string; message: string; at: string; }
export interface RecordSummary {
  id: string; recordNo: string; kind: string; label: string; parcelKey: string; status: 'draft' | 'committed';
  currentVersion: number | null; draftVersion: number | null; draftState: 'draft' | 'in_review' | null;
  needsReview: boolean; flags: Flag[]; createdAt: string; updatedAt: string;
}
export interface Diff {
  fields: { path: string; before: any; after: any }[];
  owners: { added: Owner[]; removed: Owner[]; changed: { name: string; before: any; after: any }[] };
  encumbrances: { added: Encumbrance[]; removed: Encumbrance[] };
  documents: { added: any[]; removed: any[]; updated: any[] };
  empty: boolean;
}
export interface LandRecord extends RecordSummary { current: Version | null; draft: Version | null; draftDiff: Diff | null; }
export interface FoundDocument {
  edrmsDocumentId: string; edrmsNo: string; docType: string; title: string; ref: string | null; property: string | null;
  currentVersion: number; filedAt: string; inThisRecord: boolean; linkedTo: { recordId: string; recordNo: string; label: string }[]; reasons?: string[];
}
export interface Comment { id: string; body: string; authorName: string | null; createdAt: string; versionNumber: number | null; }
export interface ParcelKind { id: string; label: string; schemaVersion: string; schema: any; draftSchema: any; }

@Injectable({ providedIn: 'root' })
export class RecordsApi {
  private api = inject(ApiService);

  catalogue() { return this.api.get<{ parcelKinds: ParcelKind[] }>('/records/catalogue'); }
  list(q?: string) { return this.api.get<{ items: RecordSummary[]; total: number }>('/records', { q, limit: 200 }); }
  get(id: string) { return this.api.get<LandRecord>(`/records/${id}`); }
  create(body: { parcel?: Parcel; edrmsDocumentId?: string }) { return this.api.post<LandRecord>('/records', body); }
  edit(id: string, body: { revision: number; changes?: Record<string, any>; accept?: string[]; reason?: string }) { return this.api.patch<LandRecord>(`/records/${id}/draft`, body); }
  link(id: string, revision: number, edrmsDocumentId: string) { return this.api.post<LandRecord>(`/records/${id}/draft/documents`, { revision, edrmsDocumentId }); }
  unlink(id: string, revision: number, edrmsDocumentId: string) { return this.api.delete<LandRecord>(`/records/${id}/draft/documents/${edrmsDocumentId}`, { revision }); }
  refresh(id: string, revision: number, edrmsDocumentId: string) { return this.api.post<LandRecord>(`/records/${id}/draft/documents/${edrmsDocumentId}/refresh`, { revision }); }
  openDraft(id: string) { return this.api.post<LandRecord>(`/records/${id}/draft`); }
  submit(id: string, revision: number) { return this.api.post<LandRecord>(`/records/${id}/draft/submit`, { revision }); }
  withdraw(id: string) { return this.api.post<LandRecord>(`/records/${id}/draft/withdraw`); }
  searchDocuments(q: string, recordId?: string) { return this.api.get<{ items: FoundDocument[]; total: number }>('/records/document-search', { q, recordId, limit: 30 }); }
  suggestions(id: string) { return this.api.get<{ items: FoundDocument[] }>(`/records/${id}/suggestions`); }
  comments(id: string) { return this.api.get<{ items: Comment[] }>(`/records/${id}/comments`); }
  comment(id: string, body: string) { return this.api.post<Comment>(`/records/${id}/comments`, { body }); }
  contentLink(edrmsDocumentId: string, version?: number) { return this.api.get<{ url: string }>(`/documents/${edrmsDocumentId}/content`, { version }); }
}
