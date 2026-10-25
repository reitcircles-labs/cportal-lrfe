import {readFileSync} from 'node:fs';

/**
 * The search part of a country pack (API-713): how the country writes its registry references and
 * which spellings of a name are the same name. Nothing country-specific is in the code: the
 * analysers and the query take everything from here. Namibia's pack is the first
 * (`country-packs/na.json`); another country adds its own file.
 */
const PACKS = new URL('../country-packs/', import.meta.url);

/**
 * The pack of a country, by its code (`NA`), checked: a pack that cannot be used fails at start,
 * not in a search.
 * @param {string} country
 */
export function loadCountryPack(country) {
  const code = String(country ?? '').toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) {
    throw new Error(`Country code "${country}" is not two letters`);
  }
  let pack;
  try {
    pack = JSON.parse(readFileSync(new URL(`${code}.json`, PACKS), 'utf8'));
  } catch (err) {
    throw new Error(`No country pack for "${country}": ${err.message}`);
  }
  if (String(pack.country).toLowerCase() !== code) {
    throw new Error(`The country pack ${code}.json is for "${pack.country}"`);
  }
  return checkCountryPack(pack);
}

/**
 * The pack itself when its search part is complete; an error naming what is wrong otherwise.
 * @param {object} pack a parsed country pack
 */
export function checkCountryPack(pack) {
  const search = pack?.search;
  const fail = what => {
    throw new Error(`Country pack ${pack?.country ?? '?'}: ${what}`);
  };
  if (!search) fail('no "search" part');
  if (!Array.isArray(search.references)) fail('"references" is not a list');
  for (const ref of search.references) {
    const re = new RegExp(ref.pattern, 'giu');
    for (const example of ref.examples ?? []) {
      re.lastIndex = 0;
      if (!re.test(example)) fail(`"${ref.name}" does not match ${example}`);
    }
  }
  if (!Array.isArray(search.nameVariants)) fail('"nameVariants" is not a list');
  for (const v of search.nameVariants) {
    if (typeof v.pattern !== 'string' || typeof v.replacement !== 'string') {
      fail('a name variant needs a pattern and a replacement');
    }
  }
  for (const key of ['wordStartMin', 'variantMinLength']) {
    if (!Number.isInteger(search[key]) || search[key] < 1) {
      fail(`"${key}" is not a positive whole number`);
    }
  }
  return pack;
}
