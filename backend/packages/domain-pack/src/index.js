import {fail, isObject} from './fail.js';
import {checkDocuments} from './sections/documents.js';
import {checkIdentity} from './sections/identity.js';
import {checkRecordKind} from './sections/record-kind.js';
import {checkWording} from './sections/wording.js';
import {checkWorkflows} from './sections/workflows.js';

export {WORDING_PARTS} from './sections/wording.js';

/**
 * A domain pack tells the shared services about the product they serve (CB-3): the land registry,
 * shipping. It is a JavaScript module, `backend/domains/<name>`, published in the workspace as
 * `@lrfe/domain-<name>`, which exports as `pack` an object with these sections:
 *
 * - `name`: the pack's name, as in `LRFE_DOMAIN` (`land`).
 * - `documents`: document types and their fields, the reading prompt and checks (edrms, intake,
 *   search).
 * - `identity`: permission groups, roles, separation-of-duty rules, offices, demo users.
 * - `workflows`: the product's workflow definitions and their roles (bpm).
 * - `recordKind`: the product's record for the audit trail, or null when it has none yet.
 * - `wording`: texts per service (edrms, identity, audit, extracts).
 *
 * Every section is checked at start, so a broken pack fails before a service serves anything. An
 * empty pack has every section, with nothing in it.
 *
 * A pack never imports `@lrfe/common`: common loads the pack while it is itself being loaded.
 * @typedef {object} DomainPack
 * @property {string} name
 * @property {object} documents
 * @property {object} identity
 * @property {object} workflows
 * @property {?object} recordKind
 * @property {object} wording
 */

/** The pack names a setting may hold: lower-case letters, digits and dashes. */
const NAME = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * The pack itself, frozen, when it can be used; an error naming what is wrong otherwise.
 * @param {DomainPack} pack
 * @param {string=} expectedName the name the pack was loaded by
 * @return {DomainPack}
 */
export function checkDomainPack(pack, expectedName) {
  if (!isObject(pack)) {
    fail(expectedName ?? '?', 'its module exports no pack object');
  }
  const name = pack.name;
  if (typeof name !== 'string' || !NAME.test(name)) {
    fail(expectedName ?? '?', `"${name}" is not a pack name`);
  }
  if (expectedName !== undefined && name !== expectedName) {
    fail(expectedName, `the module is the pack "${name}"`);
  }
  checkDocuments(name, pack.documents);
  checkIdentity(name, pack.identity);
  checkWorkflows(name, pack.workflows);
  if (pack.recordKind !== null) {
    checkRecordKind(name, pack.recordKind);
  }
  checkWording(name, pack.wording);
  return deepFreeze(pack);
}

/**
 * Whether a text is a valid pack name (the form of `LRFE_DOMAIN`).
 * @param {string} name
 * @return {boolean}
 */
export function isPackName(name) {
  return typeof name === 'string' && NAME.test(name);
}

/**
 * Freezes an object and everything in it, so no service changes the pack another one reads.
 * @param {object} value
 * @return {object} the same object
 */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }
  return value;
}
