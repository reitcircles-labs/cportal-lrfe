import {fail, isObject} from '../fail.js';

/** A document type id: lower-case letters, digits and underscores (stored, never renamed). */
const TYPE_ID = /^[a-z][a-z0-9_]*$/;
/** A field key: letters and digits, as in `field.<key>` searches. */
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
/** What the search index may do with a field (API-808). */
const SEARCH_ROLES = ['reference', 'number', 'name', 'place'];
/** The field type every service knows without the pack: a text kept as written. */
const TEXT = 'text';

/**
 * Checks the `documents` section of a domain pack: what edrms, intake and search know of the
 * product's documents. Every part is optional, so an empty section is a product without documents.
 *
 * - `types`: the document types, `{id, label, refField, desc?, fields}`; `refField` is null or the
 *   key of the field holding the document's own reference; each field is
 *   `{k, label, type, desc?, required, search?}`, its `type` being `text` or one of `fieldTypes`
 *   and `search` one of `reference`, `number`, `name`, `place` or null.
 * - `formatReference(ref)`: the canonical form of a trimmed, upper-cased reference.
 * - `fieldTypes`: the check of each field type, `(raw) → {value, normalized, checks}`.
 * - `reading`: how intake reads the documents; needed when there are types: `promptVersion`,
 *   `prompt: {subject, languages?, notOfKind, rules?}`, and optionally `checkRows(typeId, rows)`,
 *   `crossChecks: {codes, check(context)}` and `wrongPartyExample`.
 * - `partyFields`: the keys of the fields that name whom a document is for, first found first.
 * - `demo`: `{answer, reading(file)}`, the stand-in reader's answers.
 * @param {string} pack the pack's name, for the error
 * @param {object} section the section
 */
export function checkDocuments(pack, section) {
  if (!isObject(section)) {
    fail(pack, '"documents" is not an object');
  }
  const fieldTypes = section.fieldTypes ?? {};
  if (!isObject(fieldTypes)) {
    fail(pack, 'documents: "fieldTypes" is not an object');
  }
  for (const [name, check] of Object.entries(fieldTypes)) {
    if (typeof check !== 'function') {
      fail(pack, `documents: field type "${name}" is not a function`);
    }
  }
  const types = section.types ?? [];
  if (!Array.isArray(types)) {
    fail(pack, 'documents: "types" is not a list');
  }
  const ids = new Set();
  for (const type of types) {
    checkType(pack, type, fieldTypes);
    if (ids.has(type.id)) {
      fail(pack, `documents: the type "${type.id}" is given twice`);
    }
    ids.add(type.id);
  }
  checkFunction(pack, section, 'formatReference');
  if (section.reading !== undefined || types.length > 0) {
    checkReading(pack, section.reading);
  }
  const partyFields = section.partyFields ?? [];
  if (!isTextList(partyFields)) {
    fail(pack, 'documents: "partyFields" is not a list of field keys');
  }
  if (section.demo !== undefined) {
    if (!isObject(section.demo) || typeof section.demo.reading !== 'function') {
      fail(pack, 'documents: "demo" needs a function "reading"');
    }
  }
}

/**
 * Checks one document type.
 * @param {string} pack the pack's name, for the error
 * @param {object} type the type
 * @param {object} fieldTypes the pack's field types
 */
function checkType(pack, type, fieldTypes) {
  if (
    !isObject(type) ||
    typeof type.id !== 'string' ||
    !TYPE_ID.test(type.id)
  ) {
    fail(
      pack,
      `documents: a type has no valid id (${JSON.stringify(type?.id)})`,
    );
  }
  const where = `documents: type "${type.id}"`;
  if (!isText(type.label)) {
    fail(pack, `${where} has no label`);
  }
  if (type.desc !== undefined && typeof type.desc !== 'string') {
    fail(pack, `${where}: "desc" is not a text`);
  }
  if (!Array.isArray(type.fields)) {
    fail(pack, `${where}: "fields" is not a list`);
  }
  const keys = new Set();
  for (const field of type.fields) {
    checkField(pack, where, field, fieldTypes);
    if (keys.has(field.k)) {
      fail(pack, `${where}: the field "${field.k}" is given twice`);
    }
    keys.add(field.k);
  }
  if (type.refField !== null && !keys.has(type.refField)) {
    fail(pack, `${where}: "refField" is neither null nor one of its fields`);
  }
}

/**
 * Checks one field of a document type.
 * @param {string} pack the pack's name, for the error
 * @param {string} where the type, for the error
 * @param {object} field the field
 * @param {object} fieldTypes the pack's field types
 */
function checkField(pack, where, field, fieldTypes) {
  if (
    !isObject(field) ||
    typeof field.k !== 'string' ||
    !FIELD_KEY.test(field.k)
  ) {
    fail(
      pack,
      `${where}: a field has no valid key (${JSON.stringify(field?.k)})`,
    );
  }
  const at = `${where}, field "${field.k}"`;
  if (!isText(field.label)) {
    fail(pack, `${at} has no label`);
  }
  if (field.type !== TEXT && !Object.hasOwn(fieldTypes, field.type)) {
    fail(
      pack,
      `${at}: the type "${field.type}" is neither "text" nor in "fieldTypes"`,
    );
  }
  if (field.desc !== undefined && typeof field.desc !== 'string') {
    fail(pack, `${at}: "desc" is not a text`);
  }
  if (typeof field.required !== 'boolean') {
    fail(pack, `${at}: "required" is not true or false`);
  }
  if (field.search != null && !SEARCH_ROLES.includes(field.search)) {
    fail(pack, `${at}: "search" is not one of ${SEARCH_ROLES.join(', ')}`);
  }
}

/**
 * Checks how intake reads the documents.
 * @param {string} pack the pack's name, for the error
 * @param {object} reading the `reading` part
 */
function checkReading(pack, reading) {
  if (!isObject(reading)) {
    fail(
      pack,
      'documents: "reading" is needed with document types, and is not an object',
    );
  }
  if (!isText(reading.promptVersion)) {
    fail(pack, 'documents: "reading.promptVersion" is not a text');
  }
  const prompt = reading.prompt;
  if (
    !isObject(prompt) ||
    !isText(prompt.subject) ||
    !isText(prompt.notOfKind)
  ) {
    fail(
      pack,
      'documents: "reading.prompt" needs the texts "subject" and "notOfKind"',
    );
  }
  if (prompt.languages !== undefined && !isText(prompt.languages)) {
    fail(pack, 'documents: "reading.prompt.languages" is not a text');
  }
  if (prompt.rules !== undefined && !isTextList(prompt.rules)) {
    fail(pack, 'documents: "reading.prompt.rules" is not a list of texts');
  }
  checkFunction(pack, reading, 'checkRows', 'reading.');
  if (reading.crossChecks !== undefined) {
    const crossChecks = reading.crossChecks;
    if (
      !isObject(crossChecks) ||
      !isTextList(crossChecks.codes) ||
      typeof crossChecks.check !== 'function'
    ) {
      fail(
        pack,
        'documents: "reading.crossChecks" needs "codes" (texts) and a function "check"',
      );
    }
  }
  if (
    reading.wrongPartyExample !== undefined &&
    !isText(reading.wrongPartyExample)
  ) {
    fail(pack, 'documents: "reading.wrongPartyExample" is not a text');
  }
}

/**
 * Fails when an optional member is there but is not a function.
 * @param {string} pack the pack's name, for the error
 * @param {object} owner the object holding it
 * @param {string} name its name
 * @param {string=} prefix where the owner is, for the error
 */
function checkFunction(pack, owner, name, prefix = '') {
  if (owner[name] !== undefined && typeof owner[name] !== 'function') {
    fail(pack, `documents: "${prefix}${name}" is not a function`);
  }
}

/**
 * Whether a value is a text that is not empty.
 * @param {unknown} value
 * @return {boolean}
 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether a value is a list of texts that are not empty.
 * @param {unknown} value
 * @return {boolean}
 */
function isTextList(value) {
  return Array.isArray(value) && value.every(isText);
}
