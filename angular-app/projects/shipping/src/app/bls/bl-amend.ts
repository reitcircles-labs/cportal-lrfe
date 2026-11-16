/**
 * The carrier's amendment of a B/L held for a change (CB-50, first version, from the CB-14
 * design): the fields it may change, read from the current version, the changes marked against
 * it, and the document sent as the next version: the current one with the changed fields, so its
 * number, carrier code, cargo and parties stay as they are. Only the fields of the new B/L form
 * that a change of voyage or goods needs; the containers and their cargo are not changed here.
 * The record service checks the document again (the same number and carrier code, still to
 * order, valid). Tested by bl-amend.test.ts (`npm run test:shipping`).
 */

/** How a field's value is written: as typed, a code in capitals, or a date. */
type AmendFieldKind = 'text' | 'code' | 'date' | 'long';

/** A field of the document the carrier may change. */
export interface AmendField {
  key: string;
  /** Its label in the panel. */
  label: string;
  /** Its name in a message: "Fill in the port of discharge." */
  name: string;
  /** Where it is in the DCSA document. */
  path: ReadonlyArray<string | number>;
  kind: AmendFieldKind;
}

/** The fields of the panel, by key, as typed. */
export type AmendForm = Record<string, string>;

/** A field changed, with its value in the version before and in the next one. */
export interface AmendChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/** What the record service is sent to amend a B/L: the format and the new document. */
export interface AmendRequest {
  format: string;
  document: Record<string, unknown>;
}

/** The fields the carrier may change, in the panel's order. */
export const AMEND_FIELDS: readonly AmendField[] = [
  {
    key: 'vesselName',
    label: 'Vessel',
    name: 'the vessel',
    path: ['transports', 'vesselVoyages', 0, 'vesselName'],
    kind: 'text',
  },
  {
    key: 'voyageNumber',
    label: 'Voyage',
    name: 'the voyage',
    path: ['transports', 'vesselVoyages', 0, 'carrierExportVoyageNumber'],
    kind: 'text',
  },
  {
    key: 'portOfLoading',
    label: 'Port of loading',
    name: 'the port of loading',
    path: ['transports', 'portOfLoading', 'UNLocationCode'],
    kind: 'code',
  },
  {
    key: 'portOfDischarge',
    label: 'Port of discharge',
    name: 'the port of discharge',
    path: ['transports', 'portOfDischarge', 'UNLocationCode'],
    kind: 'code',
  },
  {
    key: 'plannedDepartureDate',
    label: 'Departure date',
    name: 'the departure date',
    path: ['transports', 'plannedDepartureDate'],
    kind: 'date',
  },
  {
    key: 'plannedArrivalDate',
    label: 'Arrival date',
    name: 'the arrival date',
    path: ['transports', 'plannedArrivalDate'],
    kind: 'date',
  },
  {
    key: 'goods',
    label: 'Goods',
    name: 'the goods',
    path: ['consignmentItems', 0, 'descriptionOfGoods', 0],
    kind: 'text',
  },
  {
    key: 'hsCode',
    label: 'HS code',
    name: 'the HS code',
    path: ['consignmentItems', 0, 'HSCodes', 0],
    kind: 'code',
  },
  {
    key: 'bookingReference',
    label: 'Booking reference',
    name: 'the booking reference',
    path: ['consignmentItems', 0, 'carrierBookingReference'],
    kind: 'text',
  },
  {
    key: 'termsAndConditions',
    label: 'Terms and conditions',
    name: 'the terms and conditions',
    path: ['termsAndConditions'],
    kind: 'long',
  },
];

/**
 * The text at a path of a document.
 * @param value where to start
 * @param path the keys and indexes to follow
 * @return the text, '' when there is none
 */
function textAt(value: unknown, path: ReadonlyArray<string | number>): string {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return '';
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return typeof current === 'string' ? current : '';
}

/**
 * Writes a text at a path of a document, making the objects and lists on the way.
 * @param document the document, changed
 * @param path the keys and indexes to follow
 * @param text the text
 */
function setAt(
  document: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  text: string,
): void {
  let current = document as Record<string | number, unknown>;
  for (const [i, key] of path.entries()) {
    if (i === path.length - 1) {
      current[key] = text;
      return;
    }
    let next = current[key];
    if (next === null || typeof next !== 'object') {
      next = typeof path[i + 1] === 'number' ? [] : {};
      current[key] = next;
    }
    current = next as Record<string | number, unknown>;
  }
}

/**
 * A field's value as it is sent: without the spaces around it, a code in capitals.
 * @param field the field
 * @param value as typed
 * @return the value
 */
function normalised(field: AmendField, value: string | undefined): string {
  const text = (value ?? '').trim();
  if (field.kind === 'code') {
    return text.toUpperCase();
  }
  return text;
}

/**
 * The panel's fields as the current version gives them.
 * @param document the current version's document
 * @return the form
 */
export function amendFormOf(document: Record<string, unknown>): AmendForm {
  const form: AmendForm = {};
  for (const field of AMEND_FIELDS) {
    form[field.key] = textAt(document, field.path);
  }
  return form;
}

/**
 * The fields changed against the current version, in the panel's order.
 * @param document the current version's document
 * @param form the panel's fields
 * @return the changes, none when nothing changed
 */
export function amendChanges(
  document: Record<string, unknown>,
  form: AmendForm,
): AmendChange[] {
  const changes: AmendChange[] = [];
  for (const field of AMEND_FIELDS) {
    const before = textAt(document, field.path).trim();
    const after = normalised(field, form[field.key]);
    if (after !== before) {
      changes.push({key: field.key, label: field.label, before, after});
    }
  }
  return changes;
}

/**
 * Why the amendment cannot be sent yet: a field emptied that had a value, an arrival before the
 * departure, or nothing changed.
 * @param document the current version's document
 * @param form the panel's fields
 * @return the problems, none when it can be sent
 */
export function amendProblems(
  document: Record<string, unknown>,
  form: AmendForm,
): string[] {
  const problems: string[] = [];
  for (const field of AMEND_FIELDS) {
    const had = textAt(document, field.path).trim() !== '';
    if (had && normalised(field, form[field.key]) === '') {
      problems.push(`Fill in ${field.name}.`);
    }
  }
  const departure = (form['plannedDepartureDate'] ?? '').trim();
  const arrival = (form['plannedArrivalDate'] ?? '').trim();
  if (departure !== '' && arrival !== '' && arrival < departure) {
    problems.push('The arrival cannot be before the departure.');
  }
  if (amendChanges(document, form).length === 0) {
    problems.push('Change at least one field.');
  }
  return problems;
}

/**
 * The next version's document: a copy of the current one with the changed fields. The current
 * one is not changed.
 * @param document the current version's document
 * @param form the panel's fields
 * @return the new document
 */
export function amendedDocument(
  document: Record<string, unknown>,
  form: AmendForm,
): Record<string, unknown> {
  const next = structuredClone(document);
  const changed = new Set(amendChanges(document, form).map(c => c.key));
  for (const field of AMEND_FIELDS) {
    if (changed.has(field.key)) {
      setAt(next, field.path, normalised(field, form[field.key]));
    }
  }
  return next;
}

/**
 * The request that amends the B/L: its format and new document. No party links: the record
 * service keeps the current version's.
 * @param format the document's format
 * @param document the current version's document
 * @param form the panel's fields
 * @return the request
 */
export function amendRequest(
  format: string,
  document: Record<string, unknown>,
  form: AmendForm,
): AmendRequest {
  return {format, document: amendedDocument(document, form)};
}

/**
 * The question the confirmation asks.
 * @param recordNo the B/L's number
 * @return the question
 */
export function amendQuestion(recordNo: string): string {
  return `Amend ${recordNo}?`;
}

/**
 * What the confirmation says happens: the next version goes to the holder, the current one is
 * kept as superseded.
 * @param version the current version
 * @param recordNo the B/L's number
 * @param holder the name of the holder it goes back to
 * @return the sentence
 */
export function amendConfirmation(
  version: number,
  recordNo: string,
  holder: string,
): string {
  return `Version ${version + 1} of ${recordNo} goes to ${holder}. Version ${version} is kept as superseded.`;
}

/**
 * What the toast says once the B/L is amended.
 * @param version the version before the amendment
 * @param holder the name of the holder it went back to
 * @return the text
 */
export function amendDone(version: number, holder: string): string {
  return `B/L amended: version ${version + 1} is with ${holder}`;
}
