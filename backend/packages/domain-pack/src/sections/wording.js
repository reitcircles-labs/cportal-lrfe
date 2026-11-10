import {fail, isObject} from '../fail.js';

/** The services that take wording from the pack, one part each. */
export const WORDING_PARTS = Object.freeze([
  'edrms',
  'identity',
  'audit',
  'extracts',
]);

/**
 * Checks the `wording` section of a domain pack: one object per service in WORDING_PARTS, whose
 * values are texts, or functions that make a text from their arguments, or objects of those.
 * @param {string} pack the pack's name, for the error
 * @param {object} section the section
 */
export function checkWording(pack, section) {
  if (!isObject(section)) {
    fail(pack, '"wording" is not an object');
  }
  for (const part of WORDING_PARTS) {
    if (!isObject(section[part])) {
      fail(pack, `wording: "${part}" is not an object`);
    }
    checkTexts(pack, `wording.${part}`, section[part]);
  }
}

/**
 * Checks that every value of an object is a text, a function or an object of those.
 * @param {string} pack the pack's name, for the error
 * @param {string} path where the object is, for the error
 * @param {object} texts the object
 */
function checkTexts(pack, path, texts) {
  for (const [key, value] of Object.entries(texts)) {
    if (isObject(value)) {
      checkTexts(pack, `${path}.${key}`, value);
    } else if (typeof value !== 'string' && typeof value !== 'function') {
      fail(pack, `${path}.${key} is not a text`);
    }
  }
}
