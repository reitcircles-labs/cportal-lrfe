/**
 * Document types held in the EDRMS. `refField` is the extracted field that carries the
 * instrument reference (deed number, SG diagram number), which must be unique across the store.
 */
export const DOC_TYPES = [
    { id: 'deed_of_transfer', label: 'Deed of transfer', refField: 'deedNo' },
    { id: 'deed_of_sale', label: 'Deed of sale', refField: null },
    { id: 'deed_of_grant', label: 'Deed of grant', refField: 'deedNo' },
    { id: 'sg_diagram', label: 'Surveyor-General diagram', refField: 'sgNo' },
    { id: 'mortgage_bond', label: 'Mortgage bond', refField: 'bondNo' },
    { id: 'other', label: 'Other supporting document', refField: null }
];
export const DOC_TYPE_IDS = DOC_TYPES.map(t => t.id);
export const docType = (id) => DOC_TYPES.find(t => t.id === id);

/** Anyone who works with documents in any stage may read them. Writes are separate. */
export const READ_PERMS = ['capture.view', 'verify.view', 'record.view', 'audit.view'];

/** Services allowed to file new documents. */
export const FILING_SERVICES = ['intake'];

/**
 * "t2210 / 2008" → "T 2210/2008", "a412/2007" → "A 412/2007". Anything that doesn't look like
 * <letters> <number>/<year> is only trimmed and upper-cased.
 */
export function normalizeRef(ref) {
    if (ref === undefined || ref === null) return null;
    const s = String(ref).trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return null;
    const m = s.match(/^([A-Z]{1,3})\s*(\d+)\s*\/\s*(\d{4})$/);
    return m ? `${m[1]} ${m[2]}/${m[3]}` : s;
}

/** Instrument reference for a document, taken from its fields. */
export function instrumentRefOf(typeId, fields) {
    const field = docType(typeId)?.refField;
    return field ? normalizeRef(fields.find(f => f.k === field)?.v) : null;
}

/** EDR-NA-2026-018204 */
export const formatEdrmsNo = (country, year, seq) => `EDR-${country}-${year}-${String(seq).padStart(6, '0')}`;
