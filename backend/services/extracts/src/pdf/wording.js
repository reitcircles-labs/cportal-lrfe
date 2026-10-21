/** How many dots stand for the hidden part of an ID number: always the same, whatever its length. */
const HIDDEN = '•'.repeat(7);

/** The ID number as the extract prints it: only its last 4 digits, "•••••••0418"; "—" without one. */
export function idNumberShown(idNo) {
  const plain = String(idNo ?? '').replace(/[\s-]+/g, '');
  return plain ? `${HIDDEN}${plain.slice(-4)}` : '—';
}

/** The fractions the standard fonts have a sign for. */
const FRACTIONS = {'1/2': '½', '1/4': '¼', '3/4': '¾'};

/** "½" for 1/2, the share as written otherwise. */
export function shareText(share) {
  const text = String(share ?? '').replace(/\s+/g, '');
  return FRACTIONS[text] ?? (String(share ?? '').trim() || '—');
}

/** "1 214 square metres", "12.5 hectares"; the value and unit as written for any other unit. */
export function extentText(extent) {
  if (extent?.value == null) return '';
  const [whole, fraction] = String(extent.value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const value = fraction ? `${grouped}.${fraction}` : grouped;
  const units = {m2: 'square metres', ha: 'hectares'};
  return `${value} ${units[extent.unit] ?? extent.unit ?? ''}`.trim();
}

/** "Freehold", "Leasehold": the tenure with a capital and spaces. */
export function tenureText(tenure) {
  const text = String(tenure ?? '').replace(/_/g, ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** The title deeds the owners hold under (each owner's `since`), once each: "T 4521/2019". */
export function titleDeeds(owners = []) {
  return [...new Set(owners.map(o => o.since).filter(Boolean))].join(', ');
}
