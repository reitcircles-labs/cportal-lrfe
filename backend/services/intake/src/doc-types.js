import {domain} from '@lrfe/common';

/**
 * The document types intake reads, from the product's domain pack (CB-3, `documents.types`): the
 * reading prompt, the JSON schema the model must answer in, the field checks and the review-screen
 * labels are all made from them, so they cannot drift apart. Document type ids match the EDRMS
 * catalogue. Each field's `type` picks its check (./extraction/normalize.js); `refField` is the
 * field holding the document's own reference (unique in the EDRMS).
 */

/**
 * The document types of a pack.
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {Array<object>}
 */
export function docTypesOf(pack = domain) {
  return pack.documents.types ?? [];
}

/**
 * The document type with this id, or null.
 * @param {string} id
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {?object}
 */
export function docType(id, pack = domain) {
  return docTypesOf(pack).find(t => t.id === id) || null;
}

/**
 * What the search index does with a field (API-808): a `reference` or `number` matches whole, a
 * `name` or `place` by its words; null for a field that is not searched (dates, amounts, …).
 * @param {{search?: ?string}} field a field of a document type
 * @return {?string}
 */
export function searchRole(field) {
  return field.search ?? null;
}

/**
 * Every field key across all types (the JSON schema's enum).
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {Array<string>}
 */
export function allFieldKeysOf(pack = domain) {
  return [...new Set(docTypesOf(pack).flatMap(t => t.fields.map(x => x.k)))];
}
