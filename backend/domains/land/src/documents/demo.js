/**
 * The land registry's demo readings (CB-3; before, in intake's extraction/providers.js): what
 * intake's stand-in reader (EXTRACTION_PROVIDER=mock, and the tests) answers for a file, with no
 * model, no key and no cost. The demo parcel is Erf 1873, Klein Windhoek.
 */

const DEMO_PAGE =
  'DEED OF TRANSFER No. T 2210/2008, registered at the Deeds Registry, Windhoek, on 14 March 2008. ' +
  'BE IT HEREBY MADE KNOWN THAT H. van Wyk, conveyancer, appeared before me, the Registrar of Deeds, duly authorised by power of attorney granted by Johannes Shikongo (Identity No. 61042500187). ' +
  'AND THE APPEARER DECLARED that the transferor had truly and legally sold the property for the sum of N$ 640 000,00, and ceded and transferred it in full and free property to ' +
  'Petrus Nghishidi (Identity No. 72110800345) and Maria Nghishidi (Identity No. 75060200418), married in community of property, in ½ share each: ' +
  'Erf 1873, Klein Windhoek, situated in the Municipality of Windhoek, Registration Division "K", Khomas Region; measuring 1 214 square metres; ' +
  'as will more fully appear from Diagram S.G. No. A 412/2007, and held under Deed of Transfer No. T 1502/1996.';

/**
 * The demo's T 2210/2008, or the same deed under another number when the file name carries one
 * ("deed-T4821-2008.pdf" → T 4821/2008). The EDRMS files each instrument once, so the end-to-end
 * tests use this to file several distinct deeds on one stack. A file name with an SG number reads
 * as the parcel's diagram, one with a bond number ("B-77-2019-mortgage-bond.pdf") as a bond over it.
 * @param {{fileName?: string}} file the uploaded file
 * @return {object} the model's answer, as intake's providers give it
 */
function demoReading(file) {
  const sg = /SG[ _-]?A[ _-]?(\d{1,6})[ _-](\d{4})/i.exec(file?.fileName || '');
  if (sg) return sgAnswer(`A ${Number(sg[1])}/${sg[2]}`);
  const bond = /(?:^|[^a-z])B[ _-]?(\d{1,6})[ _-]((?:19|20)\d{2})(?!\d)/i.exec(
    file?.fileName || '',
  );
  if (bond) return bondAnswer(`B ${Number(bond[1])}/${bond[2]}`);
  const m = /T[ _-]?(\d{1,6})[ _-](\d{4})/i.exec(file?.fileName || '');
  if (!m) return DEMO_ANSWER;
  const deedNo = `T ${Number(m[1])}/${m[2]}`;
  return {
    ...DEMO_ANSWER,
    fields: DEMO_ANSWER.fields.map(f =>
      f.k === 'deedNo'
        ? {...f, value: deedNo, evidence: `DEED OF TRANSFER No. ${deedNo}`}
        : f,
    ),
    pages: [{page: 1, text: DEMO_PAGE.replace('T 2210/2008', deedNo)}],
  };
}

/** The demo parcel's survey diagram (the testers' sample 03), under the given diagram number. */
function sgAnswer(sgNo) {
  const page =
    `DIAGRAM S.G. No. ${sgNo}. The figure lettered A B C D E F represents Erf 1873, Klein Windhoek, situated in the Municipality of Windhoek, ` +
    'Registration Division "K", Khomas Region, measuring 1 214 square metres. Beacons A–F (6): iron pegs. Surveyed on 22 October 2007 by me, ' +
    'L. Hamutenya, Professional Land Surveyor, PLS 0417. Approved by the Surveyor-General on 30 November 2007.';
  return {
    docType: 'sg_diagram',
    docTypeReason: 'Titled "Diagram" with an S.G. number.',
    languages: ['en'],
    handwritingPresent: false,
    fields: [
      ['sgNo', sgNo, `S.G. No. ${sgNo}`],
      [
        'property',
        'Erf 1873, Klein Windhoek',
        'represents Erf 1873, Klein Windhoek',
      ],
      ['regDiv', 'K', 'Registration Division "K"'],
      ['extent', '1 214 square metres', 'measuring 1 214 square metres'],
      ['beacons', 'A–F (6)', 'Beacons A–F (6)'],
      ['surveyDate', '22 October 2007', 'Surveyed on 22 October 2007'],
      [
        'surveyor',
        'L. Hamutenya, PLS 0417',
        'L. Hamutenya, Professional Land Surveyor, PLS 0417',
      ],
      [
        'approved',
        '30 November 2007',
        'Approved by the Surveyor-General on 30 November 2007',
      ],
    ].map(([k, value, evidence]) => ({
      k,
      value,
      page: 1,
      evidence,
      legible: true,
    })),
    pages: [{page: 1, text: page}],
  };
}

/**
 * A mortgage bond over the demo parcel (always Erf 1873), under the given bond number, in favour of a
 * fictitious lender. A test that links it to another parcel sees the parcel check fail for it.
 */
function bondAnswer(bondNo) {
  const page =
    `MORTGAGE BOND No. ${bondNo}. Maria Nghishidi, Identity No. 75060200418, the registered owner of Erf 1873, Klein Windhoek, ` +
    'Registration Division "K", Khomas Region, held under Deed of Transfer No. T 2210/2008, hereby binds the property in favour of ' +
    'Omaruru Building Society Limited for the capital sum of N$ 450 000,00. Registered at Windhoek on 2 May 2010.';
  return {
    docType: 'mortgage_bond',
    docTypeReason: 'Titled "Mortgage Bond" with a B-series number.',
    languages: ['en'],
    handwritingPresent: false,
    fields: [
      ['bondNo', bondNo, `MORTGAGE BOND No. ${bondNo}`],
      ['regDate', '2 May 2010', 'Registered at Windhoek on 2 May 2010'],
      [
        'property',
        'Erf 1873, Klein Windhoek',
        'owner of Erf 1873, Klein Windhoek',
      ],
      ['mortgagor', 'Maria Nghishidi', 'Maria Nghishidi, Identity No.'],
      ['mortgagorId', '75060200418', 'Identity No. 75060200418'],
      [
        'mortgagee',
        'Omaruru Building Society Limited',
        'in favour of Omaruru Building Society Limited',
      ],
      ['amount', 'N$ 450 000,00', 'capital sum of N$ 450 000,00'],
      ['priorTitle', 'T 2210/2008', 'Deed of Transfer No. T 2210/2008'],
    ].map(([k, value, evidence]) => ({
      k,
      value,
      page: 1,
      evidence,
      legible: true,
    })),
    pages: [{page: 1, text: page}],
  };
}

const DEMO_ANSWER = {
  docType: 'deed_of_transfer',
  docTypeReason: 'Titled "Deed of Transfer" with a T-series number.',
  languages: ['en'],
  handwritingPresent: false,
  fields: [
    ['deedNo', 'T 2210/2008', 'DEED OF TRANSFER No. T 2210/2008'],
    ['regDate', '14 March 2008', 'Windhoek, on 14 March 2008'],
    [
      'property',
      'Erf 1873, Klein Windhoek',
      'Erf 1873, Klein Windhoek, situated',
    ],
    ['regDiv', 'K', 'Registration Division "K"'],
    ['extent', '1 214 square metres', 'measuring 1 214 square metres'],
    ['sgRef', 'A 412/2007', 'Diagram S.G. No. A 412/2007'],
    ['priorTitle', 'T 1502/1996', 'Deed of Transfer No. T 1502/1996'],
    ['transferor', 'Johannes Shikongo', 'granted by Johannes Shikongo'],
    ['transferorId', '61042500187', 'Identity No. 61042500187'],
    ['tee1', 'Petrus Nghishidi', 'to Petrus Nghishidi'],
    ['tee1Id', '72110800345', 'Identity No. 72110800345'],
    ['tee2', 'Maria Nghishidi', 'and Maria Nghishidi'],
    ['tee2Id', '75060200418', 'Identity No. 75060200418'],
    [
      'marital',
      'married in community of property',
      'married in community of property',
    ],
    ['share', '½ share each', 'in ½ share each'],
    ['price', 'N$ 640 000,00', 'sum of N$ 640 000,00'],
    ['conveyancer', 'H. van Wyk', 'THAT H. van Wyk, conveyancer'],
  ].map(([k, value, evidence]) => ({
    k,
    value,
    page: 1,
    evidence,
    legible: true,
  })),
  pages: [{page: 1, text: DEMO_PAGE}],
};

/** The demo readings: `answer`, the demo deed; `reading(file)`, the answer for a file. */
export const demo = {answer: DEMO_ANSWER, reading: demoReading};
