/* eslint-disable */
// Sample data for the Namibia land-records demo. All names, ID numbers and deed references are fictitious.
import { LandDoc, Batch, Candidate, ChainEntry } from './models';

export const DOCS: LandDoc[] = [
  { id: 'a', ref: 'T 2210/2008', title: 'Deed of Transfer', type: 'Title deed · Deed of transfer', pages: 5, cls: 0.97, edrms: 'EDR-NA-2026-018204', iso: '2008-03-14',
    header: 'REPUBLIC OF NAMIBIA · DEEDS REGISTRY WINDHOEK', sigL: 'Conveyancer', sigR: 'Registrar of Deeds', qc: 'Deskewed 0.4° · 1 blank back removed',
    fields: [
      { k: 'deedNo', label: 'Deed number', v: 'T 2210/2008', c: 0.98 },
      { k: 'regDate', label: 'Registration date', v: '14 March 2008', c: 0.96 },
      { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek', c: 0.94 },
      { k: 'regDiv', label: 'Registration division', v: 'K', c: 0.9 },
      { k: 'extent', label: 'Extent', v: '1 214 square metres', c: 0.86 },
      { k: 'sgRef', label: 'SG diagram', v: 'A 412/2007', c: 0.79 },
      { k: 'priorTitle', label: 'Prior title', v: 'T 1502/1996', c: 0.87 },
      { k: 'transferor', label: 'Transferor', v: 'Johannes Shikongo', c: 0.96 },
      { k: 'transferorId', label: 'Transferor ID no.', v: '61042500187', c: 0.8 },
      { k: 'tee1', label: 'Transferee 1', v: 'Petrus Nghishidi', c: 0.95 },
      { k: 'tee1Id', label: 'Transferee 1 ID no.', v: '72110800345', c: 0.77 },
      { k: 'tee2', label: 'Transferee 2', v: 'Maria Nghishidi', c: 0.95 },
      { k: 'tee2Id', label: 'Transferee 2 ID no.', v: '75060200418', c: 0.82 },
      { k: 'marital', label: 'Marital regime', v: 'married in community of property', c: 0.88 },
      { k: 'share', label: 'Undivided share', v: '½ share each', c: 0.84 },
      { k: 'price', label: 'Purchase price', v: 'N$ 640 000,00', c: 0.74 },
      { k: 'conveyancer', label: 'Conveyancer', v: 'H. van Wyk', c: 0.71 }
    ],
    paras: [
      ['DEED OF TRANSFER No. ', 'deedNo', ', registered at the Deeds Registry, Windhoek, on ', 'regDate', '.'],
      ['BE IT HEREBY MADE KNOWN THAT ', 'conveyancer', ', conveyancer, appeared before me, the Registrar of Deeds, duly authorised by power of attorney granted by ', 'transferor', ' (Identity No. ', 'transferorId', ').'],
      ['AND THE APPEARER DECLARED that the transferor had truly and legally sold the property for the sum of ', 'price', ', and ceded and transferred it in full and free property to ', 'tee1', ' (Identity No. ', 'tee1Id', ') and ', 'tee2', ' (Identity No. ', 'tee2Id', '), ', 'marital', ', in ', 'share', ':'],
      ['', 'property', ', situated in the Municipality of Windhoek, Registration Division “', 'regDiv', '”, Khomas Region; measuring ', 'extent', '; as will more fully appear from Diagram S.G. No. ', 'sgRef', ', and held under Deed of Transfer No. ', 'priorTitle', '.']
    ] },
  { id: 'b', ref: 'SG A 412/2007', title: 'Surveyor-General Diagram', type: 'Survey plan · SG diagram', pages: 1, cls: 0.95, edrms: 'EDR-NA-2026-018205', iso: '2007-10-22', isDiagram: true,
    header: 'OFFICE OF THE SURVEYOR-GENERAL · WINDHOEK', sigL: 'Professional land surveyor', sigR: 'Surveyor-General', qc: 'Large format 600 dpi · stitched from 2 passes',
    fields: [
      { k: 'sgNo', label: 'Diagram number', v: 'A 412/2007', c: 0.97 },
      { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek', c: 0.95 },
      { k: 'regDiv', label: 'Registration division', v: 'K', c: 0.93 },
      { k: 'extent', label: 'Area', v: '1 214 m²', c: 0.83 },
      { k: 'beacons', label: 'Beacons', v: 'A–F (6)', c: 0.9 },
      { k: 'surveyDate', label: 'Survey date', v: '22 October 2007', c: 0.88 },
      { k: 'surveyor', label: 'Land surveyor', v: 'L. Hamutenya, PLS 0417', c: 0.73 },
      { k: 'approved', label: 'Approval date', v: '30 November 2007', c: 0.86 }
    ],
    paras: [
      ['DIAGRAM S.G. No. ', 'sgNo', ' of ', 'property', ', Registration Division “', 'regDiv', '”, Khomas Region.'],
      ['Surveyed ', 'surveyDate', ' by ', 'surveyor', '. Area ', 'extent', '. Beacons ', 'beacons', ', sides in metres.'],
      ['Approved by the Surveyor-General on ', 'approved', '.']
    ] },
  { id: 'c', ref: 'T 4521/2019', title: 'Deed of Transfer', type: 'Transfer deed · Estate', pages: 3, cls: 0.93, edrms: 'EDR-NA-2026-018206', iso: '2019-07-09',
    header: 'REPUBLIC OF NAMIBIA · DEEDS REGISTRY WINDHOEK', sigL: 'Executor', sigR: 'Registrar of Deeds', qc: 'Stamp region enhanced · 300 dpi',
    fields: [
      { k: 'deedNo', label: 'Deed number', v: 'T 4521/2019', c: 0.97 },
      { k: 'regDate', label: 'Registration date', v: '9 July 2019', c: 0.95 },
      { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek', c: 0.93 },
      { k: 'regDiv', label: 'Registration division', v: 'K', c: 0.91 },
      { k: 'priorTitle', label: 'Prior title', v: 'T 2210/2008', c: 0.89 },
      { k: 'transferor', label: 'Transferor', v: 'Estate Late Petrus Nghishidi', c: 0.9 },
      { k: 'master', label: "Master's reference", v: 'E 1830/2018', c: 0.76 },
      { k: 'executor', label: 'Executor', v: 'D. Amukoto', c: 0.83 },
      { k: 'tee1', label: 'Transferee 1', v: 'Ndapewa Nghishidi', c: 0.94 },
      { k: 'tee1Id', label: 'Transferee 1 ID no.', v: '98030100562', c: 0.81 },
      { k: 'tee2', label: 'Transferee 2', v: 'Tomas Nghishidi', c: 0.93 },
      { k: 'tee2Id', label: 'Transferee 2 ID no.', v: '0111250379', c: 0.69 },
      { k: 'share', label: 'Undivided share', v: '¼ share each', c: 0.85 },
      { k: 'price', label: 'Consideration', v: 'inheritance, no consideration', c: 0.8 }
    ],
    paras: [
      ['DEED OF TRANSFER No. ', 'deedNo', ', registered at the Deeds Registry, Windhoek, on ', 'regDate', '.'],
      ['BE IT HEREBY MADE KNOWN THAT ', 'executor', ', executor testamentary in the ', 'transferor', " (Master's Ref. ", 'master', '), appeared before me, the Registrar of Deeds.'],
      ['AND THE APPEARER DECLARED that, in terms of the confirmed liquidation and distribution account and by way of ', 'price', ', the estate cedes and transfers to ', 'tee1', ' (Identity No. ', 'tee1Id', ') and ', 'tee2', ' (Identity No. ', 'tee2Id', ') the deceased’s ½ share, in ', 'share', ', in:'],
      ['', 'property', ', Registration Division “', 'regDiv', '”, Khomas Region; held under Deed of Transfer No. ', 'priorTitle', '.']
    ] }
];
export const TOTAL = DOCS.reduce((a, d) => a + d.pages, 0);
export const BASE_DOCS: LandDoc[] = [
  { id: 'g1', isBase: true, ref: 'G 88/1978', title: 'Deed of Grant', type: 'Title deed · Deed of grant', pages: 2, cls: 0.99, edrms: 'EDR-NA-2025-000411',
    header: 'DEEDS REGISTRY WINDHOEK', qc: 'Pilot back-scan 2025 · verified', fields: [
      { k: 'deedNo', label: 'Deed number', v: 'G 88/1978' }, { k: 'regDate', label: 'Registration date', v: '2 May 1978' },
      { k: 'tee1', label: 'Grantee', v: 'Municipality of Windhoek' }, { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek' },
      { k: 'regDiv', label: 'Registration division', v: 'K' }, { k: 'extent', label: 'Extent', v: '1 214 square metres' }],
    paras: [['DEED OF GRANT No. ', 'deedNo', ', registered at the Deeds Registry, Windhoek, on ', 'regDate', '.'],
      ['THE STATE hereby grants to ', 'tee1', ' the property ', 'property', ', Registration Division “', 'regDiv', '”, measuring ', 'extent', ', upon the establishment of the township.']] },
  { id: 'g2', isBase: true, ref: 'T 1502/1996', title: 'Deed of Transfer', type: 'Title deed · Deed of transfer', pages: 3, cls: 0.99, edrms: 'EDR-NA-2025-000412',
    header: 'REPUBLIC OF NAMIBIA · DEEDS REGISTRY WINDHOEK', qc: 'Pilot back-scan 2025 · verified', fields: [
      { k: 'deedNo', label: 'Deed number', v: 'T 1502/1996' }, { k: 'regDate', label: 'Registration date', v: '19 August 1996' },
      { k: 'transferor', label: 'Transferor', v: 'Municipality of Windhoek' }, { k: 'tee1', label: 'Transferee', v: 'Johannes Shikongo' },
      { k: 'tee1Id', label: 'Transferee ID no.', v: '61042500187' }, { k: 'price', label: 'Purchase price', v: 'N$ 85 000,00' },
      { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek' }, { k: 'priorTitle', label: 'Prior title', v: 'G 88/1978' }],
    paras: [['DEED OF TRANSFER No. ', 'deedNo', ', registered at the Deeds Registry, Windhoek, on ', 'regDate', '.'],
      ['The ', 'transferor', ' having sold the property for ', 'price', ', cedes and transfers it in full and free property to ', 'tee1', ' (Identity No. ', 'tee1Id', '):'],
      ['', 'property', ', Registration Division “K”, Khomas Region; held under Deed of Grant No. ', 'priorTitle', '.']] }
];
export const VIEWDOCS: LandDoc[] = [...DOCS, ...BASE_DOCS];
export const BASE: ChainEntry[] = [
  { id: 'g1', iso: '1978-05-02', ref: 'G 88/1978', type: 'Deed of grant', edrms: 'EDR-NA-2025-000411', summary: 'Republic → Municipality of Windhoek (township establishment)' },
  { id: 'g2', iso: '1996-08-19', ref: 'T 1502/1996', type: 'Deed of transfer', edrms: 'EDR-NA-2025-000412', summary: 'Municipality of Windhoek → Johannes Shikongo (whole)' }
];
export const NEW: Record<string, { type: string; summary: string; match: string; reasons: string }> = {
  a: { type: 'Deed of transfer', summary: 'Johannes Shikongo → Petrus & Maria Nghishidi, married in community of property, ½ each · N$ 640 000', match: '98%', reasons: 'erf & division exact · prior title T 1502/1996 in record · transferor ID = current owner' },
  b: { type: 'SG diagram', summary: 'Supporting survey · 1 214 m², beacons A–F', match: '96%', reasons: 'erf & division exact · diagram cited by T 2210/2008' },
  c: { type: 'Deed of transfer (estate)', summary: 'Estate late Petrus Nghishidi ½ → Ndapewa ¼, Tomas ¼', match: '94%', reasons: 'erf exact · prior title T 2210/2008 · transferor is a ½ owner' }
};
export const CANDS: Record<string, Candidate[]> = {
  a: [
    { name: 'Erf 1873, Klein Windhoek', meta: 'Reg. div K · 1 214 m² · owner Johannes Shikongo', score: 98, r: [['ok', 'Erf number'], ['ok', 'Registration division'], ['ok', 'Prior title T 1502/1996'], ['ok', 'Transferor ID = owner']] },
    { name: 'Erf 1837, Klein Windhoek', meta: 'Reg. div K · 980 m² · owner S. Kaura', score: 41, r: [['warn', 'Erf digits transposed'], ['ok', 'Registration division'], ['no', 'Owner mismatch']] },
    { name: 'Erf 1873, Windhoek West', meta: 'Reg. div K · 612 m²', score: 30, r: [['ok', 'Erf number'], ['no', 'Township mismatch'], ['no', 'Extent mismatch']] }
  ],
  b: [
    { name: 'Erf 1873, Klein Windhoek', meta: 'Reg. div K · 1 214 m²', score: 96, r: [['ok', 'Erf number'], ['ok', 'Extent 1 214 m²'], ['ok', 'Cited by T 2210/2008']] },
    { name: 'Erf 1874, Klein Windhoek', meta: 'Reg. div K · adjoining erf', score: 38, r: [['warn', 'Shares beacons B, C'], ['no', 'Erf number']] }
  ],
  c: [
    { name: 'Erf 1873, Klein Windhoek', meta: 'Reg. div K · owners P. & M. Nghishidi', score: 94, r: [['ok', 'Erf number'], ['ok', 'Prior title T 2210/2008'], ['ok', 'Deceased holds ½'], ['warn', 'Transferee 2 ID corrected']] },
    { name: 'Erf 2210, Klein Windhoek', meta: 'Reg. div K', score: 22, r: [['warn', 'Deed no. read as erf'], ['no', 'No party match']] }
  ]
};
DOCS.forEach(d => { d.batch = 'WDH-B017'; });
export const TOWNS = ['Windhoek West', 'Olympia', 'Pionierspark', 'Eros', 'Khomasdal', 'Ludwigsdorf', 'Hochland Park', 'Academia'];
export const BATCHES: Batch[] = [
  { id: 'WDH-B017', src: 'Vault 3 · T-series 2008, 2019' },
  { id: 'WDH-B016', src: 'Vault 4 · SG diagrams', n: 16, mode: 'todo' },
  { id: 'WDH-B015', src: 'Vault 3 · T-series 2011', n: 18, mode: 'mixed' },
  { id: 'WDH-B014', src: 'Vault 3 · T-series 2004', n: 14, mode: 'filed' }
];
export const rndQ = (n: number) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
export const SYN: LandDoc[] = [];
let qn = 0;
BATCHES.slice(1).forEach((b, bi) => {
  for (let i = 0; i < b.n; i++) {
    qn++;
    const t = b.mode === 'todo' ? DOCS[1] : DOCS[i % 3 === 1 ? 2 : 0];
    const erf = 1000 + (qn * 137) % 3900, town = TOWNS[qn % 8], yr = 2000 + (qn * 7) % 20;
    const num = t.id === 'b' ? 'A ' + (100 + qn * 7) + '/' + yr : 'T ' + (1000 + (qn * 389) % 8000) + '/' + yr;
    SYN.push({ ...t, id: 'q' + qn, batch: b.id, ref: t.id === 'b' ? 'SG ' + num : num, edrms: 'EDR-NA-2026-01' + (7000 + qn),
      preFiled: b.mode === 'filed' || (b.mode === 'mixed' && i < 8),
      preReviewed: b.mode === 'mixed' && i >= 8 && i < 11 ? 5 : 0,
      assignee: b.mode === 'mixed' && i >= 15 ? 'T. Haufiku' : null,
      fields: t.fields.map((f, j) => ({ ...f,
        v: f.k === 'deedNo' || f.k === 'sgNo' ? num : f.k === 'property' ? 'Erf ' + erf + ', ' + town : f.v,
        c: Math.round(Math.min(0.99, Math.max(0.62, f.c + (rndQ(qn * 31 + j) - 0.5) * 0.18)) * 100) / 100 })) });
  }
});
export const QUEUE: LandDoc[] = [...DOCS, ...SYN];

/** Land records register: one ERP record per erf, each backed by digitized EDRMS documents. */
export interface LandRecordRow {
  id: string; erf: string; township: string; region: string; regDiv: string; extent: string; tenure: string;
  owners: string[]; docs: number; docIds: string[]; lastActivity: string; batch: string; live?: boolean;
}
const FIRST = ['Johanna', 'Tjipuka', 'Selma', 'Hendrik', 'Ndapandula', 'Willem', 'Lucia', 'Tangeni', 'Anna', 'Petrus', 'Frieda', 'Kaarina', 'Simon', 'Martha', 'David', 'Hilma'];
const LAST = ['Amupanda', 'Kavari', 'Nangolo', 'van der Merwe', 'Shikongo', 'Hoaeb', 'Tjiueza', 'Iita', 'Beukes', 'Nuujoma', 'Katjiuongua', '!Naruseb', 'Haimbodi', 'Garoeb', 'Mbumba', 'Uirab'];
const DAYS = ['28 Sep 2026', '27 Sep 2026', '26 Sep 2026', '25 Sep 2026', '24 Sep 2026', '23 Sep 2026', '21 Sep 2026', '18 Sep 2026'];
export const LAND_RECORDS: LandRecordRow[] = [
  { id: 'erf1873', erf: 'Erf 1873', township: 'Klein Windhoek', region: 'Khomas', regDiv: 'K', extent: '1 214 m²', tenure: 'Freehold',
    owners: [], docs: 5, docIds: ['a', 'b', 'c'], lastActivity: '28 Sep 2026', batch: 'WDH-B017', live: true },
  ...SYN.map((d, i) => {
    const prop = d.fields.find(f => f.k === 'property')!.v;
    const [erf, township] = prop.split(', ');
    const n = 1 + (i % 3);
    const owners = Array.from({ length: n === 3 ? 2 : 1 }, (_, k) => FIRST[(i * 3 + k * 5) % FIRST.length] + ' ' + LAST[(i * 7 + (k ? 0 : 3)) % LAST.length]);
    return { id: 'r' + d.id, erf, township, region: 'Khomas', regDiv: 'K', extent: (400 + (i * 173) % 2600).toLocaleString('en-US').replace(',', ' ') + ' m²',
      tenure: i % 11 === 4 ? 'Leasehold' : 'Freehold', owners, docs: d.isDiagram ? 1 + (i % 2) : 2 + (i % 3), docIds: [d.id],
      lastActivity: DAYS[i % DAYS.length], batch: d.batch! };
  })
];
export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const ROLE = { scan: 'Scan operator', rev: 'Metadata reviewer', rec: 'Records officer', sys: 'System' };
export const hash = (s: string): string => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0).toString(16) + '00000000').slice(0, 8) + '…' + ((Math.imul(h, 31) >>> 0).toString(16) + '0000').slice(0, 4); };
export const idFmt = (k: string, v: any): string => /Id$/.test(k) ? (/^\d{11}$/.test(String(v).replace(/\s/g, '')) ? '✓ 11 digits · DOB ' + String(v).slice(4, 6) + '/' + String(v).slice(2, 4) + '/' + String(v).slice(0, 2) : '✗ Namibian ID must be 11 digits') : '';



export function flowModel() {
    const cell = (title?: string, body?: string, strong?: boolean) => ({ has: !!title, title, body, bg: strong ? 'var(--color-accent-100)' : 'transparent' });
    const E = cell();
    const lanes = [
      { name: 'Scan operator', sub: 'Registry floor', cells: [cell('Scan or drop batch', 'Live scanner with patch sheets, or files arriving in the hot folder. Tag registry & division.', true), E, E, E, E] },
      { name: 'EDRMS', sub: 'Documents of record', cells: [
        cell('Ingest & QC', 'Store images, deskew, drop blanks, check DPI.'),
        cell('Classify & extract', 'OCR; deed type; erf, division, parties, ID nos., shares — each with confidence.'),
        cell('File document', 'Verified metadata sealed with EDRMS ID and SHA-256 hash.'),
        cell('Serve to ERP', 'Referenced read-only, never copied.'), E] },
      { name: 'Reviewer', sub: 'Metadata verification', cells: [E, E, cell('Verify against image', 'Side-by-side or field-focus. Correct low-confidence values; ID format checks.', true), E, E] },
      { name: 'Records officer', sub: 'ERP linking', cells: [E, E, E, cell('Confirm matches', 'System ranks candidate erven; officer links or rejects each document.', true), cell('Commit version', 'Shares = 1, chain continuous, extent matches diagram.', true)] },
      { name: 'Auditor', sub: 'Read-only', cells: [E, E, E, E, cell('Review trail', 'Every capture, edit, link and commit, hash-chained.')] }
    ];
    const schema = [
      { a: 'Land unit ID', na: 'Erf / farm no. + portion, township, registration division', ex: 'Erf 1873, Klein Windhoek · K', nl: 'Kadastrale aanduiding (gemeente, sectie, perceelnummer)' },
      { a: 'Region / local authority', na: 'Region and municipality on title', ex: 'Khomas · Windhoek', nl: 'Gemeente' },
      { a: 'Extent', na: 'Extent on title, checked against SG diagram', ex: '1 214 m²', nl: 'Kadastrale grootte' },
      { a: 'Survey reference', na: 'SG diagram / general plan number', ex: 'A 412/2007', nl: 'Meetbrief · kadastrale kaart' },
      { a: 'Right type', na: 'Ownership (freehold), leasehold; FLTS starter / land-hold title', ex: 'Ownership', nl: 'Zakelijk recht: eigendom, erfpacht, opstal' },
      { a: 'Holder', na: 'Full name, Namibian ID (11 digits) or company reg. no.', ex: 'Maria Nghishidi · 75060200418', nl: 'Gerechtigde (BSN / KvK)' },
      { a: 'Share', na: 'Undivided share as a fraction', ex: '½, ¼, ¼', nl: 'Aandeel in recht (breuk)' },
      { a: 'Marital regime', na: 'In / out of community of property', ex: 'In community of property', nl: 'Huwelijksgoederenregime' },
      { a: 'Instrument reference', na: 'Deed no./year: T (transfer), G (grant), B (bond); registry; date', ex: 'T 2210/2008 · 14 Mar 2008', nl: 'Akte: deel / nummer, datum inschrijving' },
      { a: 'Prior title', na: 'Deed under which property was previously held', ex: 'T 1502/1996', nl: 'Vorige verkrijging' },
      { a: 'Consideration', na: 'Purchase price in N$, or inheritance / donation', ex: 'N$ 640 000,00', nl: 'Koopsom' },
      { a: 'Encumbrances', na: 'Mortgage bonds, servitudes, conditions of title', ex: 'None', nl: 'Hypotheek, beslag, erfdienstbaarheid' },
      { a: 'Executor / Master ref.', na: 'For estate transfers', ex: 'E 1830/2018', nl: 'Verklaring van erfrecht' }
    ];
  const stages = [['01', 'Capture', 'Scan station', 'capture'], ['02', 'Extract', 'Automatic', 'capture'], ['03', 'Verify', 'Review desk', 'verify'], ['04', 'Link', 'Records desk', 'link'], ['05', 'Commit & audit', 'Records desk · auditor', 'audit']]
    .map(([n, label, screen, route]) => ({ n, label, screen, route }));
  return { stages, lanes, schema };
}
