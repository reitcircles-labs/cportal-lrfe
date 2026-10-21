import {
  PDFDocument,
  StandardFonts,
  beginMarkedContent,
  endMarkedContent,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingColor,
} from 'pdf-lib';
import {COLOURS, MARGIN, PageWriter} from './page-writer.js';
import {qrModules} from './qr.js';
import {
  extentText,
  idNumberShown,
  shareText,
  tenureText,
  titleDeeds,
} from './wording.js';

/** The QR code's side on the page, in points (about 42 mm: easy to scan from a printout). */
const QR_SIDE = 120;

/** The public check page for an extract: the configured address, then its token. */
export const checkUrl = (base, token) =>
  `${String(base).replace(/\/+$/, '')}/${token}`;

/** The name of the proof attached inside the PDF. */
export const proofFileName = versionNumber =>
  `record-v${versionNumber}.proof.json`;

/** The proof as the evidence pack writes it (audit's evidence.service.js): the same bytes. */
export const proofJson = proof => `${JSON.stringify(proof, null, 2)}\n`;

/** "21 October 2026, 10:41" (`long`) or "21 Oct 2026, 10:41", in `timeZone` (the server's when unset). */
export function dateTimeText(value, timeZone, month = 'long') {
  const at = new Date(value);
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month,
    year: 'numeric',
    timeZone,
  }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
  return `${date}, ${time}`;
}

/**
 * The ownership extract as a PDF document, not saved or sealed yet (README.md, "The PDF"), laid out
 * as the design draft (API-690): the registry, the extract and its issue; the record's version as
 * it stands; its owners with only the last 4 digits of each ID number; the check against the
 * blockchain with the QR code; the warning to scan it; the seal notice and the legal wording. The
 * proof of the version is attached inside it.
 * @param {{extract: !Object, record: !Object, proof: !Object, explorerUrl: ?string,
 *     settings: !Object}} input
 *     settings: {org, checkUrlBase, legalText, timeZone} (extractSettingsFromEnv)
 * @return {!Promise<!PDFDocument>}
 */
export async function renderExtract({
  extract,
  record,
  proof,
  explorerUrl,
  settings,
}) {
  const pdfDoc = await PDFDocument.create();
  const issuedAt = new Date(extract.issuedAt);
  const registry = registryName(settings.org);
  pdfDoc.setTitle(`Ownership extract ${extract.id}`);
  pdfDoc.setSubject(
    `${record.recordNo}, version ${extract.versionNumber}: ${record.label ?? ''}`,
  );
  pdfDoc.setAuthor(settings.org.name);
  pdfDoc.setCreator(settings.org.name);
  pdfDoc.setProducer(settings.org.name);
  pdfDoc.setCreationDate(issuedAt);
  pdfDoc.setModificationDate(issuedAt);
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    mono: await pdfDoc.embedFont(StandardFonts.Courier),
  };
  const writer = new PageWriter(pdfDoc, fonts);
  const facts = {
    extract,
    record,
    version: record.current,
    proof,
    explorerUrl,
    settings,
    registry,
  };

  header(writer, facts);
  landRecord(writer, facts);
  owners(writer, facts);
  check(writer, facts);
  warning(writer);
  seal(writer, facts);
  footers(pdfDoc, fonts, facts);

  await pdfDoc.attach(
    Buffer.from(proofJson(proof), 'utf8'),
    proofFileName(extract.versionNumber),
    {
      mimeType: 'application/json',
      description: `The proof that ties version ${extract.versionNumber} of ${record.recordNo} to the blockchain transaction`,
      creationDate: issuedAt,
      modificationDate: issuedAt,
    },
  );
  return pdfDoc;
}

/** "Deeds Registry, Republic of Namibia", or the name alone. */
function registryName(org) {
  return org.subtitle ? `${org.name}, ${org.subtitle}` : org.name;
}

function header(writer, {extract, settings}) {
  const {bold, regular, mono} = writer.fonts;
  writer.textRight('Ownership extract', {font: bold, size: 16, top: 0});
  writer.textRight(extract.id, {font: mono, size: 8, top: 22});
  writer.textRight(
    `Issued ${dateTimeText(extract.issuedAt, settings.timeZone)}`,
    {size: 9, top: 34, colour: COLOURS.muted},
  );
  const nameWidth = writer.width * 0.55;
  writer.text(settings.org.name, {font: bold, size: 14, width: nameWidth});
  if (settings.org.subtitle) {
    writer.text(settings.org.subtitle, {
      font: regular,
      size: 10,
      width: nameWidth,
      colour: COLOURS.muted,
    });
  }
  writer.y = Math.min(writer.y, writer.page.getHeight() - MARGIN - 48);
  writer.rule(12);
}

/** One label and its value, the label in the left column. */
function row(writer, label, value, {valueFont, valueSize = 10} = {}) {
  if (value == null || value === '') return;
  const labelWidth = 130;
  const font = valueFont ?? writer.fonts.regular;
  const height = writer.text(value, {
    font,
    size: valueSize,
    x: labelWidth,
    dryRun: true,
  });
  writer.ensure(height + 4);
  const top = writer.y;
  writer.text(label, {size: 9, width: labelWidth - 8, colour: COLOURS.muted});
  writer.y = top;
  writer.text(value, {font, size: valueSize, x: labelWidth});
  writer.y = Math.min(writer.y, top - 13) - 3;
}

function heading(writer, text, size = 11) {
  writer.ensure(size * 3);
  writer.text(text, {font: writer.fonts.bold, size});
  writer.space(4);
}

function landRecord(writer, {extract, record, version}) {
  heading(
    writer,
    `The land record, version ${extract.versionNumber} (current on the issue date)`,
  );
  const data = version.data ?? {};
  row(writer, 'Parcel', record.label);
  row(
    writer,
    'Land record',
    `${record.recordNo} · version ${extract.versionNumber}`,
  );
  row(writer, 'Township', data.parcel?.township);
  row(writer, 'Registration division', data.parcel?.regDiv);
  row(writer, 'Extent', extentText(data.extent));
  row(writer, 'Tenure', tenureText(data.tenure));
  row(writer, 'Title deed', titleDeeds(data.owners));
  writer.space(6);
}

function owners(writer, {extract, version}) {
  heading(writer, 'Registered owners', 10);
  const columns = {name: 0, idNo: 260, share: 400};
  const headerRow = () => {
    const top = writer.y;
    for (const [key, label] of [
      ['name', 'Name'],
      ['idNo', 'ID number'],
      ['share', 'Share'],
    ]) {
      writer.y = top;
      writer.text(label, {size: 8.5, x: columns[key], colour: COLOURS.muted});
    }
    writer.rule(3);
  };
  headerRow();
  for (const owner of version.data?.owners ?? []) {
    const nameHeight = writer.text(owner.name, {
      dryRun: true,
      width: columns.idNo - 12,
    });
    if (writer.y - nameHeight < 70) {
      writer.newPage();
      headerRow();
    }
    const top = writer.y;
    writer.text(owner.name, {width: columns.idNo - 12});
    const bottom = writer.y;
    writer.y = top;
    writer.text(idNumberShown(owner.idNo), {
      font: writer.fonts.mono,
      x: columns.idNo,
      width: columns.share - columns.idNo - 8,
    });
    writer.y = top;
    writer.text(shareText(owner.share), {x: columns.share});
    writer.y = Math.min(writer.y, bottom) - 3;
  }
  writer.space(8);
  writer.text(
    `Issued to ${extract.ownerName}, registered owner, identity document seen at the counter.`,
  );
  writer.space(10);
}

/**
 * The QR code, drawn as filled squares, one rectangle per run of dark modules, inside a marked
 * content section tagged QR (so a test can read back exactly what was drawn).
 */
function drawQr(page, text, {x, y, side}) {
  const modules = qrModules(text);
  const quiet = 4; // the white border a scanner needs, in modules
  const cell = side / (modules.length + 2 * quiet);
  const operators = [
    beginMarkedContent('QR'),
    pushGraphicsState(),
    setFillingColor(COLOURS.ink),
  ];
  modules.forEach((dark, rowIndex) => {
    let column = 0;
    while (column < dark.length) {
      if (!dark[column]) {
        column++;
        continue;
      }
      const start = column;
      while (column < dark.length && dark[column]) column++;
      operators.push(
        rectangle(
          x + (quiet + start) * cell,
          y + side - (quiet + rowIndex + 1) * cell,
          (column - start) * cell,
          cell,
        ),
      );
    }
  });
  operators.push(fill(), popGraphicsState(), endMarkedContent());
  page.pushOperators(...operators);
}

function check(writer, {extract, proof, explorerUrl, settings}) {
  const {bold, mono} = writer.fonts;
  const url = checkUrl(settings.checkUrlBase, extract.token);
  const textX = QR_SIDE + 16;
  const intro =
    'Scan the QR code. The check page says whether this extract matches the registry’s record, and whether it is still the current version. No login is needed.';
  writer.ensure(QR_SIDE + 150);
  writer.space(4);
  const top = writer.y;
  drawQr(writer.page, url, {
    x: MARGIN,
    y: top - QR_SIDE,
    side: QR_SIDE,
  });
  writer.text('Check this extract against the blockchain', {
    font: bold,
    size: 11,
    x: textX,
  });
  writer.space(3);
  writer.text(intro, {size: 9.5, x: textX});
  writer.space(4);
  writer.text('No camera? Open this address:', {
    size: 9,
    x: textX,
    colour: COLOURS.muted,
  });
  writer.text(url, {font: mono, size: 7.5, x: textX});
  writer.y = Math.min(writer.y, top - QR_SIDE) - 10;

  const anchor = proof.anchor ?? {};
  const since = anchor.confirmedAt
    ? `, on the blockchain since ${dateTimeText(anchor.confirmedAt, settings.timeZone, 'short')}`
    : '';
  row(writer, 'Fingerprint', proof.item?.seal, {valueFont: mono, valueSize: 8});
  row(writer, 'Batch', `${anchor.batch}${since}`);
  row(writer, 'Transaction', anchor.tx, {valueFont: mono, valueSize: 8});
  row(writer, 'Explorer', explorerUrl, {valueFont: mono, valueSize: 7.5});
  writer.space(8);
}

/** A box around `draw`, measured first so it fits on one page. */
function box(writer, {fillColour, edgeColour, height, padding = 10}, draw) {
  writer.ensure(height + 2 * padding + 8);
  const top = writer.y;
  writer.page.drawRectangle({
    x: MARGIN,
    y: top - height - 2 * padding,
    width: writer.width,
    height: height + 2 * padding,
    color: fillColour,
    borderColor: edgeColour,
    borderWidth: edgeColour ? 0.8 : 0,
  });
  writer.y = top - padding;
  draw(padding);
  writer.y = top - height - 2 * padding - 10;
}

function warning(writer) {
  const title = 'Always scan the QR code. Don’t rely on this paper alone.';
  const body =
    'The extract shows the record on its issue date. The record may have changed since, or the registry may have withdrawn this extract: only the check page can tell you.';
  const width = writer.width - 20;
  const height =
    writer.text(title, {
      font: writer.fonts.bold,
      size: 10,
      width,
      dryRun: true,
    }) +
    3 +
    writer.text(body, {size: 9.5, width, dryRun: true});
  box(
    writer,
    {fillColour: COLOURS.warning, edgeColour: COLOURS.warningEdge, height},
    padding => {
      writer.text(title, {
        font: writer.fonts.bold,
        size: 10,
        x: padding,
        width,
      });
      writer.space(3);
      writer.text(body, {size: 9.5, x: padding, width});
    },
  );
}

function seal(writer, {settings, registry}) {
  const title = `Sealed by the ${settings.org.name}`;
  const body = `This PDF carries the electronic seal of the ${registry} and, attached inside the file, the proof that ties this record version to the blockchain transaction above. A printout carries the QR code only; the PDF file can be checked in full.`;
  const width = writer.width - 20;
  const legal = settings.legalText;
  const height =
    writer.text(title, {
      font: writer.fonts.bold,
      size: 10,
      width,
      dryRun: true,
    }) +
    3 +
    writer.text(body, {size: 9.5, width, dryRun: true}) +
    6 +
    writer.text(legal, {
      font: writer.fonts.italic,
      size: 9,
      width,
      dryRun: true,
    });
  box(writer, {fillColour: COLOURS.panel, height}, padding => {
    writer.text(title, {font: writer.fonts.bold, size: 10, x: padding, width});
    writer.space(3);
    writer.text(body, {size: 9.5, x: padding, width});
    writer.space(6);
    writer.text(legal, {
      font: writer.fonts.italic,
      size: 9,
      x: padding,
      width,
      colour: COLOURS.muted,
    });
  });
}

/** On every page: the extract, the record version and the attached proof; "Page i of n". */
function footers(pdfDoc, fonts, {extract, record}) {
  const pages = pdfDoc.getPages();
  const left = `${extract.id} · ${record.recordNo} v${extract.versionNumber} · attached: ${proofFileName(extract.versionNumber)}`;
  pages.forEach((page, index) => {
    const right = `Page ${index + 1} of ${pages.length}`;
    page.drawText(left, {
      x: MARGIN,
      y: 30,
      size: 7.5,
      font: fonts.regular,
      color: COLOURS.muted,
    });
    page.drawText(right, {
      x: page.getWidth() - MARGIN - fonts.regular.widthOfTextAtSize(right, 7.5),
      y: 30,
      size: 7.5,
      font: fonts.regular,
      color: COLOURS.muted,
    });
  });
}
