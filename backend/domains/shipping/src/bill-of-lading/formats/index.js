import {BadRequestError} from '@lrfe/common';

import {dcsa30} from './dcsa-3.0.js';

/**
 * A format a B/L can arrive in or be written in, and its two-way conversion with the internal
 * model (CB-26). A converter never changes the model: it maps a format onto it.
 *
 * @typedef {object} BillOfLadingFormat
 * @property {string} name the format's name in `LRFE_BL_FORMATS`, e.g. `dcsa-3.0`
 * @property {string} label the format's name for people, e.g. `DCSA eBL 3.0`
 * @property {function(object): {billOfLading: object, status: ?string}} toModel a document in the
 *     format as a B/L of the model, with the format's own status of it when it has one
 * @property {function(object, object): object} fromModel a B/L of the model as a document in the
 *     format; the options carry what the model keeps apart (the status)
 */

/**
 * Every converter the platform has, by name. Adding a format: write its converter in this folder
 * and add it here (docs/formats.md).
 * @type {Readonly<Record<string, BillOfLadingFormat>>}
 */
export const FORMATS = Object.freeze({
  [dcsa30.name]: dcsa30,
});

/** The setting that lists the formats on in an install. */
export const FORMATS_SETTING = 'LRFE_BL_FORMATS';

/** The formats on when the setting is not set. */
const DEFAULT_FORMATS = 'dcsa-3.0';

/**
 * Whether the platform has a converter of this name (its own entries only, never an object's
 * built-in names such as `toString`).
 *
 * @param {string} name
 * @return {boolean}
 */
function isKnown(name) {
  return Object.hasOwn(FORMATS, name);
}

/**
 * The formats on in this install, from `LRFE_BL_FORMATS` (comma-separated names; `dcsa-3.0` when
 * not set). Read at start: an unknown name stops the start with a message naming it.
 *
 * @param {Record<string, string | undefined>} [source] the settings, `process.env` by default
 * @return {ReadonlyArray<BillOfLadingFormat>} the formats, in the setting's order
 * @throws {Error} for an empty list or an unknown name
 */
export function formatsFromSettings(source = process.env) {
  const value = source[FORMATS_SETTING]?.trim() || DEFAULT_FORMATS;
  const names = [...new Set(value.split(',').map(name => name.trim()))];
  const known = Object.keys(FORMATS).join(', ');
  if (names.includes('')) {
    throw new Error(
      `${FORMATS_SETTING} has an empty name in its list. Known formats: ${known}`,
    );
  }
  const unknown = names.filter(name => !isKnown(name));
  if (unknown.length > 0) {
    throw new Error(
      `${FORMATS_SETTING} names an unknown B/L format: ${unknown.join(', ')}. ` +
        `Known formats: ${known}`,
    );
  }
  return Object.freeze(names.map(name => FORMATS[name]));
}

/**
 * The converter of a format that is on, for a request naming it.
 *
 * @param {ReadonlyArray<BillOfLadingFormat>} formats the formats on (formatsFromSettings)
 * @param {string} name the format a request names
 * @return {BillOfLadingFormat}
 * @throws {BadRequestError} when the format is unknown or not on in this install
 */
export function formatNamed(formats, name) {
  const format = formats.find(f => f.name === name);
  if (format) {
    return format;
  }
  const on = formats.map(f => f.name).join(', ');
  if (isKnown(name)) {
    throw new BadRequestError(
      `The B/L format ${name} is not on in this install (${FORMATS_SETTING}: ${on})`,
    );
  }
  throw new BadRequestError(`Unknown B/L format: ${name}. Formats on: ${on}`);
}
