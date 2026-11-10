import {Check, FoundDocument, RecordSummary} from '../../api/records.api';
import type {SFilter} from './link.store';

/** The names of a parcel's fields, for labels. */
const PARCEL_LABELS: Record<string, string> = {
  number: 'Erf number',
  portion: 'Portion',
  township: 'Township',
  regDiv: 'Registration division',
  region: 'Region',
  farmName: 'Farm name',
  farmNumber: 'Farm number',
  schemeName: 'Scheme name',
  schemeNumber: 'Scheme number',
  unit: 'Unit',
  participationQuota: 'Participation quota',
};

/** Whether a land record belongs under a status filter of the list. */
export function matches(r: RecordSummary, f: SFilter) {
  // a record in the bin is under "In the bin" only (API-767)
  if (f === 'in_bin' || r.inBin) return f === 'in_bin' && r.inBin;
  if (f === 'all') return true;
  if (f === 'draft') return r.status === 'draft';
  if (f === 'committed') return r.status === 'committed';
  if (f === 'in_review') return r.draftState === 'in_review';
  if (f === 'new_document') return r.newDocuments > 0;
  return r.needsReview;
}

/** A land record's status as the list and the header show it: its label and tag colour. */
export function statusOf(r: RecordSummary): {label: string; tag: string} {
  if (r.inBin) return {label: 'In the bin', tag: 'tag-neutral'};
  if (r.needsReview) return {label: 'Needs review', tag: 'tag-outline'};
  if (r.draftState === 'in_review') {
    return {label: 'In review', tag: 'tag-info'};
  }
  if (r.status === 'draft') return {label: 'Draft', tag: 'tag-neutral'};
  if (r.draftVersion) {
    return {label: 'Change in progress', tag: 'tag-neutral'};
  }
  return {label: 'Committed', tag: 'tag-accent'};
}

/** The colour of a land record's dot in the list. */
export function dot(r: RecordSummary) {
  return r.needsReview
    ? 'flag'
    : r.draftState === 'in_review'
      ? 'review'
      : r.status === 'committed'
        ? 'committed'
        : 'draft';
}

/** The name of a parcel field, e.g. "Erf number" for number. */
export function parcelLabel(k: string) {
  return PARCEL_LABELS[k] || k;
}

/** A tenure as shown, e.g. "Freehold". */
export function tenureLabel(t?: string) {
  return t ? t[0].toUpperCase() + t.slice(1) : 'Tenure not set';
}

/** An extent as shown, e.g. "1 214 m²". */
export function extentText(e?: {value: number; unit: string} | null) {
  return e
    ? `${e.value.toLocaleString('en-ZA')} ${e.unit === 'm2' ? 'm²' : 'ha'}`
    : '—';
}

/** Up to two initials of a person's name, for their avatar. */
export function initials(n: string) {
  return n
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map(s => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** The land records a filed document is already in, as shown. */
export function linkedText(p: FoundDocument) {
  return p.linkedTo.map(l => `${l.label} (${l.recordNo})`).join(', ');
}

/** The name of a record check. */
export function checkLabel(c: Check) {
  return (
    (
      {
        shares_sum: 'Shares add up to 1',
        chain_of_title: 'Chain of title',
        extent_vs_sg: 'Extent matches the SG diagram',
        id_numbers: 'ID numbers',
        parcel_match: 'Documents describe this parcel',
        documents_current: 'Documents are current',
        overrides: 'Values from the documents',
      } as Record<string, string>
    )[c.id] || c.id
  );
}

// ---------------------------------------------------------------- loading
