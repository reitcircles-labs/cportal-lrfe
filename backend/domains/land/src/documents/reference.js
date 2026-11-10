/**
 * The land registry's form of an instrument reference (before, in edrms' catalogue): "T 2210/2008",
 * "A 412/2007". The EDRMS keeps each reference once, in this form.
 */

/**
 * The canonical form of a reference that the EDRMS has already trimmed and upper-cased:
 * "T2210 / 2008" → "T 2210/2008". Anything that doesn't look like <letters> <number>/<year> is
 * given back as it is.
 * @param {string} ref the trimmed, upper-cased reference
 * @return {string}
 */
export function formatReference(ref) {
  const m = ref.match(/^([A-Z]{1,3})\s*(\d+)\s*\/\s*(\d{4})$/);
  return m ? `${m[1]} ${m[2]}/${m[3]}` : ref;
}
