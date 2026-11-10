/**
 * Throws the error of a pack that cannot be used, naming the pack and what is wrong.
 * @param {string} pack the pack's name
 * @param {string} what what is wrong, e.g. `documents: "types" is not a list`
 * @return {never}
 */
export function fail(pack, what) {
  throw new Error(`Domain pack ${pack}: ${what}`);
}

/**
 * Whether a value is a plain object (not null, not a list).
 * @param {unknown} value
 * @return {boolean}
 */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
