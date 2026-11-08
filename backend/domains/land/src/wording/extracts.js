/**
 * The land registry's texts for the extracts service (CB-3): the ownership extract's PDF, where the
 * extracts service keeps the layout (pdf/extract-pdf.js). A new extract of a land record is the
 * same PDF, byte for byte, as before these texts moved here.
 */

/** How many dots stand for the hidden part of an ID number: always the same, whatever its length. */
const HIDDEN = '•'.repeat(7);

/**
 * The ID number as the extract prints it: only its last 4 digits, "•••••••0418"; "—" without one.
 * @param {?string} idNo
 * @return {string}
 */
function idNumberShown(idNo) {
  const plain = String(idNo ?? '').replace(/[\s-]+/g, '');
  return plain ? `${HIDDEN}${plain.slice(-4)}` : '—';
}

/** The fractions the standard fonts have a sign for. */
const FRACTIONS = {'1/2': '½', '1/4': '¼', '3/4': '¾'};

/**
 * "½" for 1/2, the share as written otherwise.
 * @param {?string} share
 * @return {string}
 */
function shareText(share) {
  const text = String(share ?? '').replace(/\s+/g, '');
  return FRACTIONS[text] ?? (String(share ?? '').trim() || '—');
}

/**
 * "1 214 square metres", "12.5 hectares"; the value and unit as written for any other unit.
 * @param {?{value: (number|string), unit: string}} extent
 * @return {string}
 */
function extentText(extent) {
  if (extent?.value == null) {
    return '';
  }
  const [whole, fraction] = String(extent.value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const value = fraction ? `${grouped}.${fraction}` : grouped;
  const units = {m2: 'square metres', ha: 'hectares'};
  return `${value} ${units[extent.unit] ?? extent.unit ?? ''}`.trim();
}

/**
 * "Freehold", "Leasehold": the tenure with a capital and spaces.
 * @param {?string} tenure
 * @return {string}
 */
function tenureText(tenure) {
  const text = String(tenure ?? '').replace(/_/g, ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/**
 * The title deeds the owners hold under (each owner's `since`), once each: "T 4521/2019".
 * @param {!Array<!Object>=} owners
 * @return {string}
 */
function titleDeeds(owners = []) {
  return [...new Set(owners.map(o => o.since).filter(Boolean))].join(', ');
}

/**
 * The texts of the land registry's extract: the ownership extract of a land record's version.
 * Functions make a text from the extract's facts; `recordRows` and `parties` give what the PDF's
 * record section and parties table show, in order.
 */
export const extracts = {
  /** The extract number's first part: EX-<country>-<year>-<nnnnnn>. Stored: never changes. */
  numberPrefix: 'EX',

  /** The extract's title: in the header, the PDF's title and the seal's reason. */
  title: 'Ownership extract',

  /** The heading of the record section, for the version the extract shows. */
  recordHeading: versionNumber =>
    `The land record, version ${versionNumber} (current on the issue date)`,

  /**
   * The record section's rows, [label, value]; a row without a value is left out.
   * @param {{record: !Object, version: !Object, versionNumber: number}} facts
   * @return {!Array<!Array<string>>}
   */
  recordRows: ({record, version, versionNumber}) => {
    const data = version.data ?? {};
    return [
      ['Parcel', record.label],
      ['Land record', `${record.recordNo} · version ${versionNumber}`],
      ['Registration division', data.parcel?.regDiv],
      ['Extent', extentText(data.extent)],
      ['Tenure', tenureText(data.tenure)],
      ['Title deed', titleDeeds(data.owners)],
    ];
  },

  /** The heading of the parties table. */
  partiesHeading: 'Registered owners',

  /** The parties table's column headings. */
  partyColumns: {name: 'Name', idNo: 'ID number', share: 'Share'},

  /**
   * The parties table's rows, as printed: the owners of the version, only the last 4 digits of
   * each ID number.
   * @param {!Object} version
   * @return {!Array<{name: string, idNo: string, share: string}>}
   */
  parties: version =>
    (version.data?.owners ?? []).map(owner => ({
      name: owner.name,
      idNo: idNumberShown(owner.idNo),
      share: shareText(owner.share),
    })),

  /** The line under the parties table: who the extract was issued to. */
  issuedTo: ownerName =>
    `Issued to ${ownerName}, registered owner, identity document seen at the counter.`,

  /** The check box's introduction. */
  checkIntro:
    'Scan the QR code. The check page says whether this extract matches the registry’s record, and whether it is still the current version. No login is needed.',

  /** The warning box: the paper alone proves nothing. */
  warning: {
    title: 'Always scan the QR code. Don’t rely on this paper alone.',
    body: 'The extract shows the record on its issue date. The record may have changed since, or the registry may have withdrawn this extract: only the check page can tell you.',
  },

  /** The seal box's title. */
  sealTitle: 'Electronic seal',

  /** The seal box's sentence for `registry`, as the site's settings name it. */
  sealNotice: registry =>
    `This PDF carries the electronic seal of ${registry} and, attached inside the file, the proof that ties this record version to the blockchain transaction above. A printout carries the QR code only; the PDF file can be checked in full.`,
};
