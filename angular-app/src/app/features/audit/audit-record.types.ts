import {CheckDocument, CheckVersion, Finding} from '../../api/audit.api';
import {IntakeDocType} from '../../api/intake.api';
import {PinnedDocument} from '../../api/records.api';
import {Labelled} from './audit-wording';

/** What the detail panel shows. */
export type Selection =
  | {kind: 'checkpoint'}
  | {kind: 'version'; n: number}
  | {kind: 'doc'; id: string};

/** The documents table's filters. */
export type DocFilter = 'attention' | 'new' | 'all';

/** A document of the version shown, as the table and the panel use it. */
export interface DocRow {
  pin: PinnedDocument;
  addedIn: number;
  check: CheckDocument | null;
  findings: Finding[];
  changed: boolean;
  issues: string[];
  checkLabel: string;
  checkTone: string;
}

/** A row of the versions list, newest first. */
export interface VersionRow {
  n: number;
  summary: string;
  proofLabel: string;
  proofClass: string;
  state: Labelled;
  stateClass: string;
  on: boolean;
}

/** A kind of document with its rows, as the documents table groups them. */
export interface DocGroup {
  kind: string;
  docs: DocRow[];
}

/** The tab shown in the detail panel. */
export type DetailTab = 'proof' | 'meta' | 'issues';

/** The version picked in the versions list, with its place in the open checkpoint. */
export interface SelectedVersion {
  n: number;
  inRange: CheckVersion | null;
  earlier: boolean;
}

/** A document type's name, e.g. "SG diagram" for sg_diagram. */
export function docTypeLabel(docTypes: IntakeDocType[], id: string): string {
  return docTypes.find(t => t.id === id)?.label ?? id.replace(/_/g, ' ');
}

/** A document's sealed fields with their names, as the intake catalogue gives them. */
export function fieldsOf(
  docTypes: IntakeDocType[],
  pin: PinnedDocument,
): Array<{k: string; v: string}> {
  const type = docTypes.find(t => t.id === pin.docType);
  return Object.entries(pin.fields || {}).map(([k, v]) => ({
    k: type?.fields.find(f => f.k === k)?.label ?? k,
    v,
  }));
}
