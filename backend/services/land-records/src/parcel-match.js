import {normalizeSearch} from '@lrfe/common';

/**
 * Does a document's property field describe this parcel? Every identifying word must be there as
 * a whole word ("Erf 1873, Klein Windhoek" matches; "Erf 18730" or "Erf 1873, Eros" does not).
 */
export function propertyMatches(parcel, property) {
  return propertyMismatch(parcel, property) === null;
}

/**
 * Why a document's property field does not describe this parcel, or null when it does: the
 * parcel's identifying words it does not name (`missing`, as normalizeSearch writes them), and
 * whether it names a portion the parcel does not have (`otherPortion`).
 */
export function propertyMismatch(parcel, property) {
  const words = new Set(property ? normalizeSearch(property).split(' ') : []);
  const required = identifyingWords(parcel ?? {});
  const missing = required.filter(w => !words.has(w));
  // no other portion than the parcel's own
  const otherPortion = !parcel?.portion && words.has('portion');
  if (property && required.length && !missing.length && !otherPortion) {
    return null;
  }
  return {missing, otherPortion};
}

/**
 * Does a document's property field name this parcel's number (the erf, farm or unit number),
 * whatever township or name it gives? For listing the documents likely about this parcel, so the
 * ones that do not match it can be shown.
 */
export function sameParcelNumber(parcel, property) {
  const kind = parcel?.kind;
  let numberOnly = null;
  if (kind === 'erf') {
    numberOnly = {kind, number: parcel.number, portion: parcel.portion};
  } else if (kind === 'farm_portion') {
    numberOnly = {kind, farmNumber: parcel.farmNumber, portion: parcel.portion};
  } else if (kind === 'sectional_unit') {
    numberOnly = {kind, unit: parcel.unit};
  }
  return !!numberOnly && propertyMatches(numberOnly, property);
}

/** The words a document's property field must name for this parcel. */
function identifyingWords(parcel) {
  const need = (...vals) =>
    vals
      .filter(Boolean)
      .flatMap(v => normalizeSearch(v).split(' '))
      .filter(Boolean);
  if (parcel.kind === 'erf') {
    return need(
      'erf',
      parcel.number,
      parcel.township,
      parcel.portion ? `portion ${parcel.portion}` : null,
    );
  }
  if (parcel.kind === 'farm_portion') {
    return need(
      'farm',
      parcel.farmName,
      parcel.farmNumber,
      parcel.portion ? `portion ${parcel.portion}` : null,
    );
  }
  if (parcel.kind === 'sectional_unit') {
    return need(parcel.schemeName, 'unit', parcel.unit);
  }
  return [];
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
