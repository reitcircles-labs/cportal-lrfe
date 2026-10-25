import {Anchoring} from '../../shared/anchoring';

/**
 * Documents screen: a document as the edrms service lists it. `status`: `filed`, or `intake` for a
 * scan still in intake (API-803), which has its intake id, `party` and no EDRMS number or version.
 */
export interface DocRow {
  id: string;
  status?: 'filed' | 'intake';
  party?: string | null;
  edrmsNo: string;
  docType: string;
  title: string;
  instrumentRef: string | null;
  batchId: string | null;
  currentVersion: number;
  filedAt: string;
  props: Record<string, string>;
}
export interface Field {
  k: string;
  label: string;
  v: string;
  c?: number;
  edited?: boolean;
}
export interface Version {
  versionNumber: number;
  label: string;
  kind: 'filed' | 'amendment';
  reason: string | null;
  changes: Array<{k: string; from: string; to: string}>;
  sha256: string;
  seal: string;
  size: number;
  mimeType: string;
  createdAt: string;
  createdByName: string | null;
  approvedByName: string | null;
  anchoring?: Anchoring | null;
}
/** A filed document with its fields, versions and record metadata. */
export interface DocDetail extends DocRow {
  registry: string;
  pages: number;
  fields: Field[];
  recordMetadata: Record<string, unknown>;
  filedByName: string | null;
  versions: Version[];
}
