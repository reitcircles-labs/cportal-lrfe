import {domain} from '@lrfe/common';

/**
 * The document types held in the EDRMS, from the product's domain pack (CB-3): `{id, label,
 * refField}`, `refField` being the field that carries the document's own reference (an instrument
 * number, say), which must be unique across the store.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {Array<{id: string, label: string, refField: ?string}>}
 */
export function docTypesOf(pack = domain) {
  return (pack.documents.types ?? []).map(({id, label, refField}) => ({
    id,
    label,
    refField,
  }));
}

/**
 * The ids of the document types held in the EDRMS.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {Array<string>}
 */
export function docTypeIdsOf(pack = domain) {
  return docTypesOf(pack).map(t => t.id);
}

/**
 * The document type with this id, or undefined.
 * @param {string} id
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {{id: string, label: string, refField: ?string}|undefined}
 */
export function docType(id, pack = domain) {
  return docTypesOf(pack).find(t => t.id === id);
}

/** Anyone who works with documents in any stage may read them. Writes are separate. */
export const READ_PERMS = [
  'capture.view',
  'verify.view',
  'record.view',
  'audit.view',
];

/**
 * Intake's read permissions: a document still in intake is found only by users with one of them,
 * as on intake's own screens (API-803).
 */
export const INTAKE_READ_PERMS = ['capture.view', 'verify.view'];

/** Services allowed to file new documents. */
export const FILING_SERVICES = ['intake'];

/**
 * A reference in the form the EDRMS keeps it: trimmed, upper-cased, single spaces, then in the
 * product's own form (`formatReference` of the domain pack, e.g. "t2210 / 2008" → "T 2210/2008").
 * @param {?string} ref
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?string} null for no reference
 */
export function normalizeRef(ref, pack = domain) {
  if (ref === undefined || ref === null) {
    return null;
  }
  const s = String(ref).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) {
    return null;
  }
  const format = pack.documents.formatReference;
  return format ? format(s) : s;
}

/**
 * The reference of a document, taken from its fields.
 * @param {string} typeId
 * @param {Array<{k: string, v: string}>} fields
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?string}
 */
export function instrumentRefOf(typeId, fields, pack = domain) {
  const field = docType(typeId, pack)?.refField;
  return field ? normalizeRef(fields.find(f => f.k === field)?.v, pack) : null;
}

/** EDR-NA-2026-018204 */
export const formatEdrmsNo = (country, year, seq) =>
  `EDR-${country}-${year}-${String(seq).padStart(6, '0')}`;
