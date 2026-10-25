import {BadRequestError} from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The position in a "documents changed since" list (intake and edrms, API-804): the last document
 * read, as an opaque cursor (base64url JSON) to read on after it. Unlike a page number it is found
 * by index however deep the list is, and a document changed meanwhile moves past it, so it is read
 * again rather than skipped. The position is kept to the millisecond: the services set
 * `updatedAt` from JavaScript dates, which have no finer part.
 * @param {{updatedAt: Date|string, id: string}} doc
 */
export function changedCursor(doc) {
  return Buffer.from(
    JSON.stringify({at: new Date(doc.updatedAt).toISOString(), id: doc.id}),
  ).toString('base64url');
}

/** A cursor from changedCursor as `{ at, id }`, null for none; a 400 when it is not one. */
export function readChangedCursor(text) {
  if (!text) return null;
  const after = parseJson(Buffer.from(text, 'base64url').toString());
  if (
    !after ||
    typeof after.at !== 'string' ||
    Number.isNaN(Date.parse(after.at)) ||
    !UUID.test(after.id ?? '')
  ) {
    throw new BadRequestError('Not a cursor from this list');
  }
  return {at: after.at, id: after.id};
}

/** Whether a document comes after the position `after` in the list (updatedAt, then id). */
export function isAfterCursor(doc, after) {
  const t = new Date(doc.updatedAt).getTime();
  const a = new Date(after.at).getTime();
  return t > a || (t === a && doc.id > after.id);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
