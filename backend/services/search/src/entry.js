/**
 * A document's entry in the search index (API-801's fields, written here, API-808), made from
 * what intake and edrms say about it now: intake's reading (the AI's values and page text) and,
 * once filed, the EDRMS document (the corrected values, its number and access restriction).
 * Built from the current state on each event, so the same event twice gives the same entry.
 */

/** The intake id of a document filed without intake (not made by this product): an edrms id. */
const edrmsOnlyId = id => `edrms:${id}`;

const time = t => (t ? new Date(t).getTime() : 0);
const unique = values => [
  ...new Set(values.filter(v => v != null && String(v).trim())),
];

/**
 * The fields that name whom a document is for, first found first: the (first) transferee of a
 * deed, the owner who grants a bond. Otherwise the first name the document has.
 */
const PARTY_FIELDS = ['tee1', 'mortgagor'];

function partyOf(fields, roles) {
  const named = fields.filter(f => roles.get(f.k) === 'name' && f.v);
  for (const k of PARTY_FIELDS) {
    const field = named.find(f => f.k === k);
    if (field) return field.v;
  }
  return named[0]?.v ?? null;
}

/**
 * The entry `{ id, version, body }`, or null when there is nothing to index. `version` is the
 * last change on either side (ms): the index keeps an entry only if it is not older than the one
 * it has, so a slow handler never brings back an older state.
 * @param {{reading?: object|null, filed?: object|null}} sides
 */
export function buildEntry({reading = null, filed = null}) {
  if (!reading && !filed) return null;
  const id = reading?.documentId ?? edrmsOnlyId(filed.id);
  // what each field is for the search, as intake's catalogue says
  // (a cleared reading, API-807, has no fields: it gives the roles on their own)
  const roles = new Map([
    ...Object.entries(reading?.roles ?? {}),
    ...(reading?.fields ?? []).filter(f => f.search).map(f => [f.k, f.search]),
  ]);
  const values = {reference: [], number: [], name: [], place: []};
  const add = (k, v) => roles.has(k) && values[roles.get(k)].push(v);
  // the AI's values, and the officer's where they changed them
  for (const f of reading?.fields ?? []) {
    add(f.k, f.v);
    if (f.ai) add(f.k, f.ai);
  }
  // the filed values (also after a correction) and, once intake has cleared its copy, the AI's
  // values kept with them (API-807)
  for (const f of filed?.fields ?? []) add(f.k, f.v);
  for (const [k, v] of Object.entries(reading?.extracted ?? {})) add(k, v);
  const reference = unique([filed?.instrumentRef, reading?.reference]);
  const shownFields = (filed?.fields ?? reading?.fields ?? []).map(f => ({
    k: f.k,
    label: f.label,
    v: f.v,
  }));
  return {
    id,
    version: Math.max(time(reading?.updatedAt), time(filed?.updatedAt)),
    body: {
      documentId: id,
      status: filed ? 'filed' : 'intake',
      ...(reading ? {intakeStatus: reading.status} : {}),
      ...(filed ? {edrmsId: filed.id, edrmsNo: filed.edrmsNo} : {}),
      reference,
      docType: filed?.docType ?? reading?.docType ?? null,
      ...(filed?.registry ? {registry: filed.registry} : {}),
      ...(reading?.capturedAt ? {uploadedAt: reading.capturedAt} : {}),
      ...(filed?.filedAt ? {filedAt: filed.filedAt} : {}),
      // in intake: users with intake's read permission; once filed: edrms' own rules
      access: filed
        ? {
            audience: 'edrms',
            restriction: filed.recordMetadata?.accessRestriction ?? null,
            registry: filed.registry ?? null,
          }
        : {audience: 'intake'},
      refs: unique([...reference, ...values.reference, filed?.edrmsNo]),
      // ID numbers, and the erf, farm and portion numbers in the property's description
      numbers: unique([
        ...values.number,
        ...values.place.flatMap(p => String(p).match(/\d+/g) ?? []),
      ]),
      names: unique(values.name),
      places: unique(values.place),
      ...(filed?.title ? {title: filed.title} : {}),
      text: (reading?.pages ?? []).map(p => p.text).join('\n\n'),
      shown: {
        reference: reference[0] ?? null,
        property: shownFields.find(f => roles.get(f.k) === 'place')?.v ?? null,
        // the party the document is for, for a row in intake (API-803)
        party: partyOf(shownFields, roles),
        fields: shownFields,
      },
    },
  };
}
