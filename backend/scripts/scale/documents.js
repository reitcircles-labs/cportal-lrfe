/**
 * The text and the PDF of a generated document (API-810): what a deeds registry's scan would say,
 * written from the document's own fields (its number, parties, ID numbers, property, dates, prior
 * title) and from conditions and clauses in a deed's usual wording, over several pages. The page
 * text is also the AI's transcription of it, and every field's value is on one of its pages, so a
 * search for a value finds the document both in its fields and in its text.
 */
import {PDFDocument, StandardFonts} from 'pdf-lib';

/** Characters per line: Helvetica 10 pt across an A4 page with 2 cm margins. */
const LINE = 92;
/** Lines per page. */
const LINES = 58;
const PAGE = [595.28, 841.89];
const MARGIN = 56;

/** How many pages of conditions and clauses each type has after its first page, at least–at most. */
const MORE_PAGES = {
  deed_of_transfer: [2, 5],
  deed_of_grant: [1, 3],
  deed_of_sale: [2, 4],
  mortgage_bond: [3, 7],
  sg_diagram: [0, 1],
  other: [0, 2],
};

const TITLES = {
  deed_of_transfer: 'DEED OF TRANSFER',
  deed_of_grant: 'DEED OF GRANT',
  deed_of_sale: 'DEED OF SALE',
  mortgage_bond: 'MORTGAGE BOND',
  sg_diagram: 'DIAGRAM',
};

/** Sentences a deed's conditions and clauses are made of; joined at random into paragraphs. */
const CLAUSES = [
  'The property is transferred subject to the conditions referred to in the prior title deed, in so far as they are still applicable.',
  'The owner shall not be entitled to subdivide the erf without the written consent of the local authority first had and obtained.',
  'The erf shall be used for residential purposes only, and not more than one dwelling house with the usual outbuildings shall be erected on it.',
  'The local authority shall be entitled to lay sewerage and water pipes across the erf, and the owner shall allow access for their maintenance.',
  'No building shall be erected nearer than three metres to any street boundary of the erf.',
  'The land is subject to a servitude of right of way in favour of the general public, as indicated on the diagram annexed hereto.',
  'The mortgagor binds the property as a first mortgage for the capital sum, interest and costs as set out below.',
  'Interest shall be calculated daily and compounded monthly at the rate agreed between the parties from time to time.',
  'The mortgagor shall keep the buildings insured against loss or damage by fire for their full replacement value.',
  'Should the mortgagor fail to pay any amount when it is due, the whole of the outstanding amount shall at once become due and payable.',
  'The mortgagor renounces the benefits of the legal exceptions non numeratae pecuniae and non causa debiti, the meaning of which is known to the mortgagor.',
  'A certificate signed by a manager of the mortgagee shall be sufficient proof of the amount owing under this bond.',
  "The purchaser shall pay all costs of transfer, including transfer duty, stamp duty and the conveyancer's fees.",
  'Possession and occupation of the property shall be given to the purchaser on the date of registration of transfer.',
  'The property is sold voetstoots, as it stands, and the seller gives no warranty as to its condition or extent.',
  'The seller shall deliver a rates clearance certificate issued by the local authority before transfer is passed.',
  'The parties choose as their domicilia citandi et executandi the addresses set out in the schedule to this agreement.',
  'No variation of this agreement shall be of any force unless reduced to writing and signed by both parties.',
  'Wherefore the appearer, renouncing all right and title which the said transferor heretofore had to the premises, did in consequence also acknowledge the said transferor to be entirely dispossessed of and disentitled to the same.',
  'By virtue of these presents the said transferee, the heirs, executors, administrators or assigns, now is and henceforth shall be entitled thereto.',
  'The figure lettered on this diagram represents the land surveyed, the beacons being described in the schedule hereto.',
  'All distances are in metres and all directions are referred to the coordinate system of the registration division.',
  'The land is held under the provisions of the applicable laws relating to the registration of deeds and the survey of land.',
  'The State reserves to itself all rights to minerals and precious stones on and under the land.',
  'This grant is made subject to the reservation of a strip of land along the boundary for the purposes of a public road.',
  'Signed at the deeds registry in the presence of the registrar of deeds, who has attested the execution hereof.',
];

/** A paragraph's sentences: 3 to 6 clauses drawn at random. */
function paragraph(random) {
  const n = random.int(3, 6);
  return Array.from({length: n}, () => random.pick(CLAUSES)).join(' ');
}

/** Breaks a paragraph into lines of at most LINE characters, at spaces. */
function wrap(text) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > LINE) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A field as the deed states it: "Deed number: T 4521/2019". Its value stays whole on one line. */
function stated(label, value) {
  return `${label}: ${value}`;
}

/**
 * The first page: the heading and every field in the deed's own words, each value on a line of
 * its own so that its evidence is one line. Returns [{k, line}] beside the lines.
 */
function firstPage(document, profile) {
  const props = document.props;
  const heading = TITLES[document.docType] ?? document.title.toUpperCase();
  const lines = [
    ...profile.deedsHeading,
    '',
    heading,
    document.instrumentRef ? `No. ${document.instrumentRef}` : '',
    '',
  ];
  const evidence = new Map();
  for (const f of document.fields) {
    const line = stated(f.label, f.v);
    evidence.set(f.k, line);
    // never wrapped: the line is the field's evidence, its value whole
    lines.push(line);
  }
  lines.push('');
  if (props.property) {
    lines.push(
      ...wrap(
        `CERTAIN ${props.property}${props.regDiv ? `, situated in Registration Division "${props.regDiv}"` : ''}${props.extent ? `, measuring ${props.extent}` : ''}.`,
      ),
    );
  }
  if (props.priorTitle) {
    lines.push(
      ...wrap(
        `First registered and held under Deed of Transfer No. ${props.priorTitle}, with the diagram relating thereto.`,
      ),
    );
  }
  return {lines, evidence};
}

/**
 * The document's pages, [{page, text}], and each field's evidence ({k → {page, text}}): the first
 * page states the fields, the next ones carry the conditions and clauses, and the last one the
 * signatures and the parties again. `profile`: the country's heading and registry town.
 */
export function pagesOf(random, document, profile) {
  const {lines: first, evidence} = firstPage(document, profile);
  const [min, max] = MORE_PAGES[document.docType] ?? [0, 2];
  const pages = [first];
  const more = random.int(min, max);
  for (let i = 0; i < more; i++) {
    const lines = [
      `${document.instrumentRef ?? document.title} – page ${i + 2}`,
      '',
    ];
    while (lines.length < LINES - 8) {
      lines.push(...wrap(paragraph(random)), '');
    }
    pages.push(lines.slice(0, LINES));
  }
  const parties = document.fields
    .filter(f =>
      /^(tee\d|transferor|mortgagor|mortgagee|seller\d|buyer\d|grantor|surveyor|conveyancer)$/.test(
        f.k,
      ),
    )
    .map(f => f.v);
  const last = pages.at(-1);
  const closing = [
    '',
    ...wrap(
      `Signed and executed at ${profile.registryTown}. Before me, Registrar of Deeds. Parties: ${parties.join('; ') || 'as above'}.`,
    ),
  ];
  if (last.length + closing.length <= LINES) {
    last.push(...closing);
  } else {
    pages.push(closing);
  }
  return {
    pages: pages.map((lines, i) => ({page: i + 1, text: lines.join('\n')})),
    evidence: Object.fromEntries(
      [...evidence].map(([k, text]) => [k, {page: 1, text}]),
    ),
  };
}

/**
 * The PDF of these pages: A4, Helvetica 10 pt, one line of text per line of the page. Dated with
 * `at`, so that the same register gives the same files; `scan` (its batch and place in it) makes
 * every file different, as every scan is.
 */
export async function pdfOf(pages, {title, at, scan}) {
  const pdf = await PDFDocument.create({updateMetadata: false});
  pdf.setTitle(title);
  pdf.setSubject(scan);
  pdf.setProducer('LRFE test register');
  pdf.setCreationDate(at);
  pdf.setModificationDate(at);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const {text} of pages) {
    const page = pdf.addPage(PAGE);
    let y = PAGE[1] - MARGIN;
    for (const line of text.split('\n')) {
      if (line) page.drawText(line, {x: MARGIN, y, size: 10, font});
      y -= 12.6;
    }
  }
  return Buffer.from(await pdf.save());
}
