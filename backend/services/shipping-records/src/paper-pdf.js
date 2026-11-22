import {PDFDocument, PageSizes, StandardFonts, rgb} from 'pdf-lib';

/** Page margin in points (A4 is 595 x 842 pt). */
const MARGIN = 44;

/** Room reserved at the bottom of every page for the footer. */
const FOOTER_ROOM = 46;

/** Left label column width in key-value rows. */
const LABEL_WIDTH = 136;

/** Palette matching the portal's ink, muted text, dividers, and paper/warning panels. */
const COLOURS = Object.freeze({
  ink: rgb(0.11, 0.14, 0.19),
  muted: rgb(0.33, 0.37, 0.43),
  rule: rgb(0.84, 0.87, 0.9),
  panel: rgb(0.95, 0.96, 0.98),
  warning: rgb(1, 0.95, 0.85),
  warningEdge: rgb(0.82, 0.56, 0.14),
});

/** Closest ASCII/WinAnsi equivalents for characters outside the standard PDF fonts. */
const CLOSEST_CHARS = Object.freeze({
  ǃ: '!',
  ǀ: '|',
  ǁ: '||',
  ǂ: '‡',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ħ: 'h',
  Ħ: 'H',
  ı: 'i',
  ŧ: 't',
  Ŧ: 'T',
  ŋ: 'n',
  Ŋ: 'N',
  ə: 'e',
  Ə: 'E',
});

/** Human-readable labels for chain-of-title commands. */
const STEP_LABELS = Object.freeze({
  issue: 'Issued',
  'issue-from-split': 'Issued from split',
  endorse: 'Endorsed',
  transfer: 'Transferred',
  'surrender-for-amendment': 'Asked for a change',
  amend: 'Amended',
  split: 'Split',
  surrender: 'Surrendered',
  release: 'Released',
  deliver: 'Delivered',
  'switch-to-paper': 'Switched to paper',
  void: 'Voided',
  'transfer-out': 'Transferred to peer platform',
  'accept-incoming': 'Accepted from peer platform',
});

/** Human-readable freight payment term names. */
const FREIGHT_TERMS = Object.freeze({
  PRE: 'Prepaid (PRE)',
  COL: 'Collect (COL)',
});

/**
 * Formats an ISO timestamp or Date as `21 Nov 2026, 10:41 UTC`.
 * @param {(string|!Date|null|undefined)} value
 * @return {string}
 */
function formatDateTime(value) {
  if (!value) {
    return '—';
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return String(value);
  }
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(at);
  return `${date}, ${time} UTC`;
}

/**
 * Builds a safe PDF download filename for a switched-to-paper B/L.
 * @param {string} recordNo
 * @param {(number|null|undefined)} versionNumber
 * @return {string}
 */
export function paperPdfFilename(recordNo, versionNumber) {
  const safeRef = String(recordNo || 'bl')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const versionTag =
    typeof versionNumber === 'number' && Number.isFinite(versionNumber)
      ? `-v${versionNumber}`
      : '';
  return `bl-${safeRef || 'document'}${versionTag}-paper.pdf`;
}

/**
 * Resolves a human-readable organisation label from the map or falls back to the raw id.
 * @param {?string} id
 * @param {!Object<string, string>} organisationNames
 * @return {string}
 */
function orgLabel(id, organisationNames) {
  if (!id) {
    return '—';
  }
  return organisationNames[id] ?? id;
}

/**
 * Resolves a UN/LOCODE port code to `CODE — Name, Country` when present in the port list.
 * @param {?string} code
 * @param {?object} ports
 * @return {string}
 */
function portLabel(code, ports) {
  if (!code) {
    return '—';
  }
  const found = ports?.get?.(code);
  if (!found) {
    return code;
  }
  const suffix = [found.name, found.country].filter(Boolean).join(', ');
  return suffix ? `${code} — ${suffix}` : code;
}

/**
 * Resolves a carrier SMDG code to `CODE — Name` when present in the carrier list.
 * @param {?string} code
 * @param {?object} carriers
 * @return {string}
 */
function carrierLabel(code, carriers) {
  if (!code) {
    return '—';
  }
  const found = carriers?.get?.(code);
  return found?.name ? `${code} — ${found.name}` : code;
}

/**
 * Joins a DCSA party's address lines cleanly for single-block rendering.
 * @param {?object} party
 * @return {string}
 */
function partyDetailsText(party) {
  if (!party || typeof party !== 'object') {
    return '—';
  }
  const lines = [];
  if (party.partyName) {
    lines.push(party.partyName);
  }
  if (
    Array.isArray(party.displayedAddress) &&
    party.displayedAddress.length > 0
  ) {
    lines.push(party.displayedAddress.filter(Boolean).join(', '));
  } else if (party.address && typeof party.address === 'object') {
    const addr = party.address;
    const street = [addr.street, addr.streetNumber].filter(Boolean).join(' ');
    const place = [addr.postCode, addr.city, addr.countryCode]
      .filter(Boolean)
      .join(', ');
    const joined = [street, place].filter(Boolean).join(', ');
    if (joined) {
      lines.push(joined);
    }
  }
  if (Array.isArray(party.partyContactDetails)) {
    for (const contact of party.partyContactDetails) {
      const text = [contact?.name, contact?.email, contact?.phone]
        .filter(Boolean)
        .join(' · ');
      if (text) {
        lines.push(text);
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : '—';
}

/**
 * Sequential A4 writer using standard PDF fonts and automatic page breaks.
 */
class PaperPageWriter {
  /**
   * @param {!PDFDocument} pdfDoc
   * @param {{regular: object, bold: object, italic: object, mono: object}} fonts
   */
  constructor(pdfDoc, fonts) {
    this.pdfDoc = pdfDoc;
    this.fonts = fonts;
    this.charsets = new Map();
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  /** @return {number} printable width inside the horizontal margins */
  get width() {
    return this.page.getWidth() - 2 * MARGIN;
  }

  /** Adds a fresh A4 page and resets the vertical cursor to the top margin. */
  newPage() {
    this.page = this.pdfDoc.addPage(PageSizes.A4);
    this.y = this.page.getHeight() - MARGIN;
  }

  /**
   * Starts a new page when `height` points would cross into the footer room.
   * @param {number} height
   */
  ensure(height) {
    if (this.y - height < FOOTER_ROOM) {
      this.newPage();
    }
  }

  /**
   * Replaces characters outside the standard WinAnsi font encoding with closest printable ones.
   * @param {*} text
   * @param {object} font
   * @return {string}
   */
  printable(text, font) {
    if (!this.charsets.has(font)) {
      this.charsets.set(font, new Set(font.getCharacterSet()));
    }
    const charset = this.charsets.get(font);
    const fits = ch => [...ch].every(c => charset.has(c.codePointAt(0)));
    const closest = ch => {
      const candidates = [
        CLOSEST_CHARS[ch],
        ch.normalize('NFD').replace(/\p{M}/gu, ''),
        ch.normalize('NFKD').replace(/\p{M}/gu, ''),
      ];
      return candidates.find(c => c && fits(c)) ?? '?';
    };
    return [...String(text ?? '').normalize('NFC')]
      .map(ch => (fits(ch) ? ch : closest(ch)))
      .join('');
  }

  /**
   * Wraps text (honouring explicit newlines) so every line fits within `width`.
   * @param {*} text
   * @param {{font?: object, size?: number, width?: number}} [options]
   * @return {!Array<string>}
   */
  wrap(text, {font = this.fonts.regular, size = 9.5, width = this.width} = {}) {
    const fitsIn = line => font.widthOfTextAtSize(line, size) <= width;
    const paragraphs = this.printable(text, font).split(/\r?\n/);
    const lines = [];
    for (const paragraph of paragraphs) {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (fitsIn(candidate)) {
          line = candidate;
          continue;
        }
        if (line) {
          lines.push(line);
        }
        let rest = word;
        while (!fitsIn(rest)) {
          let cut = rest.length - 1;
          while (cut > 1 && !fitsIn(rest.slice(0, cut))) {
            cut -= 1;
          }
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      if (line) {
        lines.push(line);
      }
    }
    return lines;
  }

  /**
   * Writes wrapped text starting at `x` from the left margin, moving down.
   * @param {*} content
   * @param {{
   *   font?: object,
   *   size?: number,
   *   x?: number,
   *   width?: number,
   *   colour?: object,
   *   lineGap?: number,
   *   dryRun?: boolean,
   * }} [options]
   * @return {number} height consumed in points
   */
  text(
    content,
    {
      font = this.fonts.regular,
      size = 9.5,
      x = 0,
      width = this.width - x,
      colour = COLOURS.ink,
      lineGap = 1.35,
      dryRun = false,
    } = {},
  ) {
    const lines = this.wrap(content, {font, size, width});
    const lineHeight = size * lineGap;
    if (dryRun) {
      return lines.length * lineHeight;
    }
    for (const line of lines) {
      if (this.y - lineHeight < FOOTER_ROOM) {
        this.newPage();
      }
      if (line !== '') {
        this.page.drawText(line, {
          x: MARGIN + x,
          y: this.y - size,
          size,
          font,
          color: colour,
        });
      }
      this.y -= lineHeight;
    }
    return lines.length * lineHeight;
  }

  /**
   * Draws a thin horizontal divider rule across the printable width.
   * @param {number} [gap]
   */
  rule(gap = 8) {
    this.y -= gap;
    this.page.drawLine({
      start: {x: MARGIN, y: this.y},
      end: {x: MARGIN + this.width, y: this.y},
      thickness: 0.6,
      color: COLOURS.rule,
    });
    this.y -= gap;
  }

  /**
   * Writes a section heading with a light rule underneath, ensuring room for at least the heading.
   * @param {string} title
   */
  section(title) {
    this.ensure(44);
    this.y -= 8;
    this.text(title, {
      font: this.fonts.bold,
      size: 11,
      colour: COLOURS.ink,
      lineGap: 1.25,
    });
    this.rule(5);
  }

  /**
   * Writes a two-column key-value row, keeping both columns together across page breaks.
   * @param {string} label
   * @param {*} value
   * @param {{mono?: boolean}} [options]
   */
  row(label, value, {mono = false} = {}) {
    const valueText =
      value === null || value === undefined || value === ''
        ? '—'
        : String(value);
    const valueFont = mono ? this.fonts.mono : this.fonts.regular;
    const valueWidth = this.width - LABEL_WIDTH;
    const labelHeight = this.text(label, {
      font: this.fonts.bold,
      size: 9,
      width: LABEL_WIDTH - 10,
      dryRun: true,
    });
    const valueHeight = this.text(valueText, {
      font: valueFont,
      size: 9.5,
      width: valueWidth,
      dryRun: true,
    });
    const height = Math.max(labelHeight, valueHeight) + 3;
    const maxPageHeight = this.page.getHeight() - MARGIN - FOOTER_ROOM;
    this.ensure(Math.min(height, maxPageHeight));
    const startPage = this.page;
    const startY = this.y;
    this.text(label, {
      font: this.fonts.bold,
      size: 9,
      width: LABEL_WIDTH - 10,
      colour: COLOURS.muted,
    });
    this.page = startPage;
    this.y = startY;
    this.text(valueText, {
      font: valueFont,
      size: 9.5,
      x: LABEL_WIDTH,
      width: valueWidth,
      colour: COLOURS.ink,
    });
    if (this.page === startPage) {
      this.y = startY - height;
    } else {
      this.y -= 3;
    }
  }

  /**
   * Draws a shaded callout box around wrapped text lines.
   * @param {string} heading
   * @param {string} body
   * @param {{warning?: boolean}} [options]
   */
  callout(heading, body, {warning = false} = {}) {
    const pad = 10;
    const innerWidth = this.width - 2 * pad;
    const headingHeight = this.text(heading, {
      font: this.fonts.bold,
      size: 10,
      width: innerWidth,
      dryRun: true,
    });
    const bodyHeight = this.text(body, {
      font: this.fonts.regular,
      size: 9.5,
      width: innerWidth,
      dryRun: true,
    });
    const boxHeight = pad * 2 + headingHeight + 4 + bodyHeight;
    this.ensure(boxHeight + 8);
    const bottomY = this.y - boxHeight;
    this.page.drawRectangle({
      x: MARGIN,
      y: bottomY,
      width: this.width,
      height: boxHeight,
      color: warning ? COLOURS.warning : COLOURS.panel,
      borderColor: warning ? COLOURS.warningEdge : COLOURS.rule,
      borderWidth: warning ? 1.1 : 0.7,
    });
    this.y -= pad;
    this.text(heading, {
      font: this.fonts.bold,
      size: 10,
      x: pad,
      width: innerWidth,
      colour: COLOURS.ink,
    });
    this.y -= 4;
    this.text(body, {
      font: this.fonts.regular,
      size: 9.5,
      x: pad,
      width: innerWidth,
      colour: COLOURS.ink,
    });
    this.y = bottomY - 10;
  }
}

/**
 * Adds a consistent footer (`Paper Bill of Lading · <ref> · Page X of Y`) to every page.
 * @param {!PDFDocument} pdfDoc
 * @param {!PaperPageWriter} writer
 * @param {{regular: object}} fonts
 * @param {string} recordNo
 */
function addFooters(pdfDoc, writer, fonts, recordNo) {
  const pages = pdfDoc.getPages();
  const total = pages.length;
  const left = writer.printable(
    `Paper Bill of Lading · ${recordNo}`,
    fonts.regular,
  );
  for (const [index, page] of pages.entries()) {
    const right = `Page ${index + 1} of ${total}`;
    page.drawLine({
      start: {x: MARGIN, y: FOOTER_ROOM - 10},
      end: {x: page.getWidth() - MARGIN, y: FOOTER_ROOM - 10},
      thickness: 0.5,
      color: COLOURS.rule,
    });
    page.drawText(left, {
      x: MARGIN,
      y: FOOTER_ROOM - 24,
      size: 8.5,
      font: fonts.regular,
      color: COLOURS.muted,
    });
    const rightWidth = fonts.regular.widthOfTextAtSize(right, 8.5);
    page.drawText(right, {
      x: page.getWidth() - MARGIN - rightWidth,
      y: FOOTER_ROOM - 24,
      size: 8.5,
      font: fonts.regular,
      color: COLOURS.muted,
    });
  }
}

/**
 * Renders a printable A4 PDF copy of an electronic Bill of Lading switched to paper (CB-86).
 *
 * @param {{
 *   record: !Object,
 *   version: !Object,
 *   title: !Object,
 *   chain: !Array<!Object>,
 *   organisationNames?: !Object<string, string>,
 *   ports?: ?object,
 *   carriers?: ?object,
 * }} input
 * @return {!Promise<{bytes: !Uint8Array, filename: string}>}
 */
export async function renderPaperBlPdf({
  record,
  version,
  title,
  chain,
  organisationNames = {},
  ports = null,
  carriers = null,
}) {
  const document = version?.data?.document ?? {};
  const partyOrgs = version?.data?.partyOrganisations ?? {};
  const versionNumber = version?.versionNumber ?? title?.issuedVersion ?? 1;
  const filename = paperPdfFilename(record.recordNo, versionNumber);
  const switchEntry = chain.findLast(
    entry => entry.command === 'switch-to-paper',
  );
  const issueEntry = chain.find(
    entry => entry.command === 'issue' || entry.command === 'issue-from-split',
  );

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Paper Bill of Lading ${record.recordNo}`);
  pdfDoc.setSubject(
    `Switched from electronic B/L ${record.recordNo} (v${versionNumber})`,
  );
  pdfDoc.setAuthor(orgLabel(title.carrier, organisationNames));
  pdfDoc.setCreator('Bill of Lading Portal');
  pdfDoc.setProducer('Bill of Lading Portal');
  if (switchEntry?.at) {
    const switchedAt = new Date(switchEntry.at);
    if (!Number.isNaN(switchedAt.getTime())) {
      pdfDoc.setCreationDate(switchedAt);
      pdfDoc.setModificationDate(switchedAt);
    }
  }

  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    mono: await pdfDoc.embedFont(StandardFonts.Courier),
  };
  const writer = new PaperPageWriter(pdfDoc, fonts);

  // Header
  writer.text('PAPER BILL OF LADING', {
    font: fonts.bold,
    size: 16,
    colour: COLOURS.ink,
  });
  writer.text(
    `Copy generated on switch from electronic B/L · ${record.recordNo} · Version ${versionNumber}`,
    {
      font: fonts.regular,
      size: 10,
      colour: COLOURS.muted,
    },
  );
  writer.rule(8);

  // Status & handover callout
  const isBearer = title.endorsement === 'blank';
  const lastHolder = orgLabel(switchEntry?.from ?? null, organisationNames);
  const switchedBy = switchEntry?.actor?.name
    ? `${switchEntry.actor.name} (${lastHolder})`
    : lastHolder;
  const bannerBody = [
    `This electronic B/L was switched to paper on ${formatDateTime(switchEntry?.at)} by ${switchedBy}.`,
    'Electronic endorsements and transfers are closed; the signed paper originals govern title from this point.',
    isBearer
      ? 'BEARER DOCUMENT WARNING: This B/L was endorsed in blank before switching to paper. Whoever holds the paper B/L holds the goods.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  writer.callout(
    isBearer ? 'Switched to a bearer paper B/L' : 'Switched to paper',
    bannerBody,
    {warning: isBearer},
  );

  // Particulars
  writer.section('Bill of Lading Particulars');
  writer.row('B/L reference', record.recordNo, {mono: true});
  writer.row('Carrier', carrierLabel(record.carrierCode, carriers));
  writer.row(
    'Type',
    document.isToOrder ? 'Negotiable (To order)' : 'Non-negotiable (Straight)',
  );
  writer.row(
    'Version',
    `Version ${versionNumber} (committed ${formatDateTime(version?.committedAt)})`,
  );
  writer.row('Issued electronically', formatDateTime(issueEntry?.at));
  writer.row('Switched to paper', formatDateTime(switchEntry?.at));
  if (document.serviceContractReference) {
    writer.row('Service contract', document.serviceContractReference);
  }
  const shippedText = document.isShippedOnBoardType
    ? `Shipped on board${document.shippedOnBoardDate ? ` (${document.shippedOnBoardDate})` : ''}`
    : 'Received for shipment';
  writer.row('On board status', shippedText);
  writer.row(
    'Freight payment',
    FREIGHT_TERMS[document.freightPaymentTermCode] ??
      document.freightPaymentTermCode,
  );
  writer.row(
    'Receipt / Delivery',
    [
      document.receiptTypeAtOrigin && document.deliveryTypeAtDestination
        ? `${document.receiptTypeAtOrigin} -> ${document.deliveryTypeAtDestination}`
        : null,
      document.cargoMovementTypeAtOrigin &&
      document.cargoMovementTypeAtDestination
        ? `${document.cargoMovementTypeAtOrigin} / ${document.cargoMovementTypeAtDestination}`
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (document.invoicePayableAt?.UNLocationCode) {
    writer.row(
      'Invoice payable at',
      portLabel(document.invoicePayableAt.UNLocationCode, ports),
    );
  }

  // Parties
  const docParties = document.documentParties ?? {};
  writer.section('Parties');
  writer.row(
    'Carrier (Platform org)',
    orgLabel(title.carrier, organisationNames),
  );
  if (docParties.issuingParty) {
    writer.row('Issuing party', partyDetailsText(docParties.issuingParty));
  }
  const shipperOrg = partyOrgs.shipper
    ? ` (${orgLabel(partyOrgs.shipper, organisationNames)})`
    : '';
  writer.row('Shipper', `${partyDetailsText(docParties.shipper)}${shipperOrg}`);
  writer.row(
    'Consignee',
    document.isToOrder ? 'To order' : partyDetailsText(docParties.consignee),
  );
  if (Array.isArray(docParties.notifyParties)) {
    for (const [index, notify] of docParties.notifyParties.entries()) {
      writer.row(
        docParties.notifyParties.length > 1
          ? `Notify party ${index + 1}`
          : 'Notify party',
        partyDetailsText(notify),
      );
    }
  }
  writer.row('Last electronic holder', lastHolder);
  writer.row(
    'Endorsement at switch',
    isBearer ? 'Blank (Bearer)' : title.endorsement,
  );

  // Voyage & Ports
  const transports = document.transports ?? {};
  writer.section('Voyage & Ports');
  const voyages = Array.isArray(transports.vesselVoyages)
    ? transports.vesselVoyages
        .map(v =>
          [
            v.vesselName,
            v.carrierExportVoyageNumber
              ? `Voyage ${v.carrierExportVoyageNumber}`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        )
        .filter(Boolean)
        .join('\n')
    : '';
  writer.row('Vessel & voyage', voyages);
  if (transports.placeOfReceipt?.UNLocationCode) {
    writer.row(
      'Place of receipt',
      portLabel(transports.placeOfReceipt.UNLocationCode, ports),
    );
  }
  writer.row(
    'Port of loading',
    portLabel(transports.portOfLoading?.UNLocationCode, ports),
  );
  writer.row(
    'Port of discharge',
    portLabel(transports.portOfDischarge?.UNLocationCode, ports),
  );
  if (transports.placeOfDelivery?.UNLocationCode) {
    writer.row(
      'Place of delivery',
      portLabel(transports.placeOfDelivery.UNLocationCode, ports),
    );
  }
  if (transports.plannedDepartureDate || transports.plannedArrivalDate) {
    writer.row(
      'Planned dates',
      [
        transports.plannedDepartureDate
          ? `Departure ${transports.plannedDepartureDate}`
          : null,
        transports.plannedArrivalDate
          ? `Arrival ${transports.plannedArrivalDate}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }

  // Cargo & Containers
  writer.section('Cargo & Equipment');
  const items = Array.isArray(document.consignmentItems)
    ? document.consignmentItems
    : [];
  for (const [index, item] of items.entries()) {
    const desc = Array.isArray(item.descriptionOfGoods)
      ? item.descriptionOfGoods.join('; ')
      : '';
    const hs =
      Array.isArray(item.HSCodes) && item.HSCodes.length > 0
        ? `HS ${item.HSCodes.join(', ')}`
        : null;
    const booking = item.carrierBookingReference
      ? `Booking ${item.carrierBookingReference}`
      : null;
    const cargoLines = [];
    for (const cargo of item.cargoItems ?? []) {
      const pkg = cargo.outerPackaging
        ? `${cargo.outerPackaging.numberOfPackages ?? ''} ${cargo.outerPackaging.description ?? cargo.outerPackaging.packageCode ?? ''}`.trim()
        : '';
      const weight = cargo.cargoGrossWeight
        ? `${cargo.cargoGrossWeight.value} ${cargo.cargoGrossWeight.unit}`
        : '';
      const parts = [
        cargo.equipmentReference
          ? `Container ${cargo.equipmentReference}`
          : null,
        pkg || null,
        weight || null,
      ].filter(Boolean);
      if (parts.length > 0) {
        cargoLines.push(parts.join(' · '));
      }
    }
    const itemSummary = [
      desc,
      [booking, hs].filter(Boolean).join(' · '),
      ...cargoLines,
    ]
      .filter(Boolean)
      .join('\n');
    writer.row(
      items.length > 1 ? `Consignment ${index + 1}` : 'Goods',
      itemSummary,
    );
  }
  const equipments = Array.isArray(document.utilizedTransportEquipments)
    ? document.utilizedTransportEquipments
    : [];
  for (const [index, eq] of equipments.entries()) {
    const ref = eq.equipment?.equipmentReference ?? '—';
    const iso = eq.equipment?.ISOEquipmentCode
      ? `ISO ${eq.equipment.ISOEquipmentCode}`
      : null;
    const owned = eq.isShipperOwned ? 'Shipper-owned' : 'Carrier-owned';
    const seals = Array.isArray(eq.seals)
      ? eq.seals
          .map(s => s?.number)
          .filter(Boolean)
          .join(', ')
      : '';
    const text = [ref, iso, owned, seals ? `Seals: ${seals}` : null]
      .filter(Boolean)
      .join(' · ');
    writer.row(
      equipments.length > 1 ? `Container ${index + 1}` : 'Container',
      text,
    );
  }

  // Charges (if present)
  if (Array.isArray(document.charges) && document.charges.length > 0) {
    writer.section('Charges');
    for (const charge of document.charges) {
      const amount =
        charge.currencyAmount !== undefined && charge.currencyCode
          ? `${charge.currencyAmount} ${charge.currencyCode}`
          : '';
      const term =
        FREIGHT_TERMS[charge.paymentTermCode] ?? charge.paymentTermCode ?? '';
      const detail = [amount, term, charge.calculationBasis]
        .filter(Boolean)
        .join(' · ');
      writer.row(charge.chargeName ?? 'Charge', detail);
    }
  }

  // Terms and Conditions
  if (document.termsAndConditions) {
    writer.section('Terms and Conditions');
    writer.text(document.termsAndConditions, {
      font: fonts.regular,
      size: 8.5,
      colour: COLOURS.muted,
      lineGap: 1.35,
    });
  }

  // Electronic Chain of Title & Ledger Record
  writer.section('Electronic Chain of Title & Ledger Record');
  for (const entry of chain) {
    const step = STEP_LABELS[entry.command] ?? entry.command;
    const path = [
      entry.from ? `from ${orgLabel(entry.from, organisationNames)}` : null,
      entry.to ? `to ${orgLabel(entry.to, organisationNames)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const byActor = entry.actor?.name
      ? `${entry.actor.name} (${orgLabel(entry.actor.org, organisationNames)})`
      : orgLabel(entry.actor?.org ?? null, organisationNames);
    const details = [
      `${step}${path ? ` (${path})` : ''}`,
      `By: ${byActor} · ${formatDateTime(entry.at)}`,
    ].join('\n');
    writer.row(`Step ${entry.seq}`, details);
  }
  writer.row(
    'Document hash (SHA-256)',
    version?.documentHash ?? title.documentHash,
    {
      mono: true,
    },
  );
  if (switchEntry?.entryHash) {
    writer.row('Switch entry hash', switchEntry.entryHash, {mono: true});
  }
  writer.row(
    'Verification',
    'Electronic signatures recorded on the platform ledger and anchored on the blockchain.',
  );

  // Carrier signature / paper originals block
  writer.section('Paper Originals & Countersignature');
  writer.callout(
    'For physical issue / carrier endorsement',
    'Carrier authorised signature & stamp: ____________________________________     Date: _______________     Originals issued: _____ / _____',
  );

  addFooters(pdfDoc, writer, fonts, record.recordNo);
  const bytes = await pdfDoc.save();
  return {bytes, filename};
}
