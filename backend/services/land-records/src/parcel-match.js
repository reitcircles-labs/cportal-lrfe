import {normalizeSearch} from '@lrfe/common';

/**
 * Does a document's property field describe this parcel? Every identifying word must be there as
 * a whole word ("Erf 1873, Klein Windhoek" matches; "Erf 18730" or "Erf 1873, Eros" does not).
 */
export function propertyMatches(parcel, property) {
  if (!property) return false;
  const words = new Set(normalizeSearch(property).split(' '));
  const need = (...vals) =>
    vals
      .filter(Boolean)
      .flatMap(v => normalizeSearch(v).split(' '))
      .filter(Boolean);
  let required = [];
  if (parcel.kind === 'erf') {
    required = need(
      'erf',
      parcel.number,
      parcel.township,
      parcel.portion ? `portion ${parcel.portion}` : null,
    );
  } else if (parcel.kind === 'farm_portion') {
    required = need(
      'farm',
      parcel.farmName,
      parcel.farmNumber,
      parcel.portion ? `portion ${parcel.portion}` : null,
    );
  } else if (parcel.kind === 'sectional_unit') {
    required = need(parcel.schemeName, 'unit', parcel.unit);
  }
  if (!required.length || !required.every(w => words.has(w))) return false;
  // no other portion than the parcel's own
  if (!parcel.portion && words.has('portion')) return false;
  return true;
}

/** "KLEIN WINDHOEK" → "Klein Windhoek": a name written in capitals, as deeds do; others as they are. */
function nameCase(name) {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(
      /(^|[\s\-(/])(\p{L})/gu,
      (_, gap, letter) => gap + letter.toUpperCase(),
    );
}

/**
 * The parcel a document's property field names, for creating a record from a filed document:
 * "Erf 1873, Klein Windhoek", "Portion 2 of Erf 51, Eros", "Portion 3 of the Farm Okapuka No. 64",
 * and as title deeds write it, "ERF NO. 2417 OLYMPIA" (API-718). The registration division and
 * region come from the document's own fields. Null when unclear.
 */
export function parcelFromProperty(property, fields = {}) {
  const text = String(property ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const extra = {
    ...(fields.regDiv ? {regDiv: fields.regDiv} : {}),
    ...(fields.region ? {region: fields.region} : {}),
  };
  // the township after the number: after a comma, or (with "No.") after a space
  let m =
    /^(?:portion (\w+) of )?erf (?:no\.? ?(\d+[a-z]?)(?:\s*,\s*|\s+)|(\d+[a-z]?)\s*,\s*)(.+)$/i.exec(
      text,
    );
  if (m) {
    return {
      kind: 'erf',
      number: m[2] ?? m[3],
      township: nameCase(m[4].trim()),
      ...(m[1] ? {portion: m[1]} : {}),
      ...extra,
    };
  }
  m = /^(?:portion (\w+) of )?(?:the )?farm (.+?),? no\.? ?(\d+)\b/i.exec(text);
  if (m) {
    return {
      kind: 'farm_portion',
      farmName: m[2].trim(),
      farmNumber: m[3],
      ...(m[1] ? {portion: m[1]} : {}),
      ...extra,
    };
  }
  return null;
}
