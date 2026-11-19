/**
 * Searchable SMDG carrier code picker helpers (CB-68): formats each option with its code and
 * carrier name and filters the list as the user types, keeping any currently selected carrier
 * visible so selection never silently clears while filtering.
 */

/** One liner shipping company of the SMDG Liner Code List. */
export interface CarrierOption {
  code: string;
  name: string;
}

/**
 * Normalizes text for accent- and case-insensitive matching.
 * @param text the text
 * @return folded lower-case text
 */
function folded(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * How a carrier option reads in the dropdown: its SMDG code followed by its name.
 * @param carrier the carrier
 * @return e.g. "MSK — Maersk"
 */
export function carrierOptionLabel(carrier: CarrierOption): string {
  return `${carrier.code} — ${carrier.name}`;
}

/**
 * Whether a code belongs to the given SMDG carrier list.
 * @param code the code to check
 * @param carriers the loaded SMDG list
 * @return true when present
 */
export function isKnownCarrier(
  code: string,
  carriers: readonly CarrierOption[],
): boolean {
  const clean = code.trim().toUpperCase();
  if (clean === '') {
    return false;
  }
  return carriers.some(c => c.code === clean);
}

/**
 * Filters carriers by code or name (case- and accent-insensitive), keeping `selected` at the top
 * if it belongs to `carriers` even when the search query would otherwise hide it.
 * @param carriers all loaded SMDG carriers
 * @param query search text typed by the user
 * @param selected currently selected code, if any
 * @return matching carriers
 */
export function filterCarriers(
  carriers: readonly CarrierOption[],
  query: string,
  selected = '',
): CarrierOption[] {
  const wanted = folded(query.trim());
  const selectedCode = selected.trim().toUpperCase();
  const current =
    selectedCode === ''
      ? undefined
      : carriers.find(c => c.code === selectedCode);
  if (wanted === '') {
    return [...carriers];
  }
  const exact: CarrierOption[] = [];
  const prefix: CarrierOption[] = [];
  const rest: CarrierOption[] = [];
  for (const carrier of carriers) {
    const code = carrier.code.toLowerCase();
    const name = folded(carrier.name);
    if (code === wanted) {
      exact.push(carrier);
    } else if (code.startsWith(wanted)) {
      prefix.push(carrier);
    } else if (code.includes(wanted) || name.includes(wanted)) {
      rest.push(carrier);
    }
  }
  const matches = [...exact, ...prefix, ...rest];
  if (current && !matches.some(c => c.code === current.code)) {
    return [current, ...matches];
  }
  return matches;
}
