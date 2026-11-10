import {fail, isObject} from '../fail.js';

/** The subject kinds a record's events may name besides the record itself (audit/src/subjects.js). */
const SUBJECT_KINDS = ['document', 'edrmsNo', 'intake', 'process', 'user'];

/**
 * Checks the `recordKind` section of a domain pack: what the audit service needs to know about the
 * product's record. Every field may be left out (an empty section is a record kind the audit
 * service knows nothing more about):
 *
 * - `source`: the service whose events commit record versions (`land-records`).
 * - `service`: the service that answers the record contract (CB-4): `{name, label, urlSetting,
 *   defaultUrl}`: its token name, what error texts call it ("land records"), the setting holding
 *   its address and the address when not set.
 * - `committedEvent`: the event type that commits a record version (`records.record.committed`).
 * - `businessKeyProcesses`: workflow process keys whose business key is a record id.
 * - `linkedSubjects`: further subjects a record's events name, in order: `{kind, path}`, `kind` one
 *   of SUBJECT_KINDS, `path` a list of keys into the event's data.
 * - `commitPermission`: the permission to commit a record version (no audit sign-off with it).
 * - `lookup`: `{recordNumber, instrumentNumber}`, regular expressions that recognise a record number
 *   and an instrument number in a search; neither global nor sticky (the pack is frozen).
 * @param {string} pack the pack's name, for the error
 * @param {object} section the section
 */
export function checkRecordKind(pack, section) {
  if (!isObject(section)) {
    fail(pack, '"recordKind" is not an object');
  }
  for (const key of ['source', 'committedEvent', 'commitPermission']) {
    if (section[key] !== undefined && !isText(section[key])) {
      fail(pack, `recordKind.${key} is not a text`);
    }
  }
  if (section.service !== undefined) {
    checkService(pack, section.service);
  }
  const processes = section.businessKeyProcesses;
  if (processes !== undefined) {
    if (!Array.isArray(processes) || !processes.every(isText)) {
      fail(pack, 'recordKind.businessKeyProcesses is not a list of texts');
    }
  }
  if (section.linkedSubjects !== undefined) {
    checkLinkedSubjects(pack, section.linkedSubjects);
  }
  if (section.lookup !== undefined) {
    checkLookup(pack, section.lookup);
  }
}

/**
 * Checks `recordKind.service`: `{name, label, urlSetting, defaultUrl}`, all texts; the setting in capitals.
 * @param {string} pack the pack's name, for the error
 * @param {unknown} service the field
 */
function checkService(pack, service) {
  if (!isObject(service)) {
    fail(pack, 'recordKind.service is not an object');
  }
  for (const key of ['name', 'label', 'urlSetting', 'defaultUrl']) {
    if (!isText(service[key])) {
      fail(pack, `recordKind.service.${key} is not a text`);
    }
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(service.urlSetting)) {
    fail(pack, 'recordKind.service.urlSetting is not a setting name');
  }
}

/**
 * Checks `recordKind.linkedSubjects`: a list of `{kind, path}`.
 * @param {string} pack the pack's name, for the error
 * @param {unknown} list the field
 */
function checkLinkedSubjects(pack, list) {
  if (!Array.isArray(list)) {
    fail(pack, 'recordKind.linkedSubjects is not a list');
  }
  list.forEach((linked, i) => {
    const where = `recordKind.linkedSubjects[${i}]`;
    if (!isObject(linked)) {
      fail(pack, `${where} is not an object`);
    }
    if (!SUBJECT_KINDS.includes(linked.kind)) {
      fail(
        pack,
        `${where}.kind "${linked.kind}" is not one of ${SUBJECT_KINDS.join(', ')}`,
      );
    }
    const path = linked.path;
    if (!Array.isArray(path) || !path.length || !path.every(isText)) {
      fail(pack, `${where}.path is not a list of keys`);
    }
  });
}

/**
 * Checks `recordKind.lookup`: regular expressions, neither global nor sticky.
 * @param {string} pack the pack's name, for the error
 * @param {unknown} lookup the field
 */
function checkLookup(pack, lookup) {
  if (!isObject(lookup)) {
    fail(pack, 'recordKind.lookup is not an object');
  }
  for (const key of ['recordNumber', 'instrumentNumber']) {
    const pattern = lookup[key];
    if (pattern === undefined) {
      continue;
    }
    if (!(pattern instanceof RegExp)) {
      fail(pack, `recordKind.lookup.${key} is not a regular expression`);
    }
    if (pattern.global || pattern.sticky) {
      fail(pack, `recordKind.lookup.${key} must be neither global nor sticky`);
    }
  }
}

/**
 * Whether a value is a text that is not empty.
 * @param {unknown} value
 * @return {boolean}
 */
function isText(value) {
  return typeof value === 'string' && value !== '';
}
