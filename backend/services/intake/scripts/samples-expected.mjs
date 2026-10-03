/**
 * What the AI should read from the testers' sample PDFs (angular-app/docs/samples/README.md), by
 * field key, and how a reading is compared with it. Shared by gemini-check.mjs and jev-check.mjs.
 */
import { normalize } from '../src/extraction/normalize.js';

export const EXPECTED = {
    '01': { docType: 'deed_of_grant', fields: {
        deedNo: 'G 88/1978', regDate: '2 May 1978', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', grantor: 'the State', tee1: 'Municipality of Windhoek' } },
    '02': { docType: 'deed_of_transfer', fields: {
        deedNo: 'T 1502/1996', regDate: '19 August 1996', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', priorTitle: 'G 88/1978', transferor: 'Municipality of Windhoek',
        tee1: 'Johannes Shikongo', tee1Id: '61042500187', marital: 'unmarried', price: 'N$ 85 000,00' } },
    '03': { docType: 'sg_diagram', fields: {
        sgNo: 'A 412/2007', property: 'Erf 1873, Klein Windhoek', regDiv: 'K', extent: '1 214 square metres',
        beacons: 'A–F (6)', surveyDate: '22 October 2007', surveyor: 'L. Hamutenya, PLS 0417', approved: '30 November 2007' } },
    '04': { docType: 'deed_of_transfer', fields: {
        deedNo: 'T 2210/2008', regDate: '14 March 2008', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', sgRef: 'A 412/2007', priorTitle: 'T 1502/1996', transferor: 'Johannes Shikongo',
        transferorId: '61042500187', tee1: 'Petrus Nghishidi', tee1Id: '72110800345', tee2: 'Maria Nghishidi',
        tee2Id: '75060200418', marital: 'married in community of property', share: '½ share each',
        price: 'N$ 640 000,00', conveyancer: 'H. van Wyk' } },
    '05': { docType: 'deed_of_transfer', fields: {
        deedNo: 'T 4521/2019', regDate: '9 July 2019', property: 'Erf 1873, Klein Windhoek', regDiv: 'K',
        extent: '1 214 square metres', priorTitle: 'T 2210/2008', transferor: 'Estate of the late Petrus Nghishidi',
        master: 'E 1830/2018', executor: 'D. Amukoto', tee1: 'Ndapewa Nghishidi', tee1Id: '98030100562',
        tee2: 'Tomas Nghishidi', tee2Id: '01112500379', marital: 'unmarried', share: '¼ share each',
        price: 'inheritance' },
        // Typed with 10 digits, corrected in the margin: either reading is fine if it is flagged
        note: { k: 'tee2Id', typed: '0111250379' } },
    '06': { docType: ['other', 'unknown'], fields: {} }
};

/** Same value? Typed values compare normalised (dates, extents, refs, money); text loosely. */
export function same(k, type, got, want) {
    if (!got) return false;
    if (type !== 'text') {
        const a = normalize(type, got).normalized, b = normalize(type, want).normalized;
        if (a != null && b != null) return a === b;
    }
    // Every word of the expected value, in order; extra words are fine ("L. Hamutenya, Professional
    // Land Surveyor, PLS 0417" for "L. Hamutenya, PLS 0417"; "1 214 (one thousand …) square metres")
    const words = (s) => s.toLowerCase().replace(/m²|m2\b/g, 'square metres').replace(/1\/2/g, '½').replace(/1\/4/g, '¼')
        .replace(/[–—]/g, '-').split(/[^a-z0-9½¼-]+/).filter(Boolean);
    const g = words(got);
    let i = 0;
    for (const w of words(want)) { i = g.indexOf(w, i); if (i < 0) return false; i++; }
    return true;
}
