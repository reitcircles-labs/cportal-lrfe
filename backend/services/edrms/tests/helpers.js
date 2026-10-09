import { Readable } from 'node:stream';
import { createEventBus } from '@lrfe/common';
import { EdrmsService } from '../src/edrms.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { createMemoryStore } from '../src/storage/memory.js';
import { buildApp } from '../src/app.js';

export const JWT_SECRET = 'edrms-test-secret-edrms-test-secret';
export const REVIEWER = { id: 'u3', name: 'Aina Mwandingi' };
export const PDF = Buffer.from('%PDF-1.7\n% T 2210/2008 scanned pages\n%%EOF\n');

/** T 2210/2008 from the frontend demo (fictitious). */
export function deedMeta(overrides = {}) {
    return {
        sourceId: 'intake-doc-a',
        batchId: 'WDH-B017',
        docType: 'deed_of_transfer',
        title: 'Deed of Transfer',
        pages: 5,
        capturedBy: { id: 'u2', name: 'Kristofina Iipinge' },
        reviewedBy: REVIEWER,
        fields: [
            { k: 'deedNo', label: 'Deed number', v: 't2210 / 2008', c: 0.98 },
            { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek', c: 0.94 },
            { k: 'regDiv', label: 'Registration division', v: 'K', c: 0.9 },
            { k: 'priorTitle', label: 'Prior title', v: 'T 1502/1996', c: 0.87 },
            { k: 'tee2Id', label: 'Transferee 2 ID no.', v: '75060200418', c: 0.82, edited: true }
        ],
        ...overrides
    };
}

export const sgMeta = (overrides = {}) => deedMeta({
    sourceId: 'intake-doc-b', docType: 'sg_diagram', title: 'Surveyor-General Diagram', pages: 1,
    fields: [
        { k: 'sgNo', label: 'Diagram number', v: 'A 412/2007' },
        { k: 'property', label: 'Property description', v: 'Erf 1873, Klein Windhoek' },
        { k: 'extent', label: 'Area', v: '1 214 m²' }
    ],
    ...overrides
});

export const pdfFile = (data = PDF) => ({ stream: Readable.from([data]), fileName: 'T2210-2008.pdf', mimeType: 'application/pdf' });

export function makeClock(start = Date.parse('2026-09-28T09:00:00Z')) {
    let now = start;
    const clock = () => new Date(now);
    clock.advance = (ms) => { now += ms; };
    return clock;
}

/** `store`: e.g. an encrypting store around a memory store (default: a plain memory store). */
export function makeService({ store = createMemoryStore() } = {}) {
    const repo = createMemoryRepo();
    const events = createEventBus({ driver: 'memory', source: 'edrms' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const clock = makeClock();
    const service = new EdrmsService({ repo, store, events, clock });
    return { repo, store, service, published, clock };
}

export async function makeApp(options = {}) {
    const ctx = makeService(options);
    const app = await buildApp({ service: ctx.service, jwtSecret: JWT_SECRET, contentUrl: { base: '/api/document-content', secret: 'content-secret' } });
    await app.ready();
    const userToken = (perms, extra = {}) => app.jwt.sign({ typ: 'access', sub: 'u3', name: 'Aina Mwandingi', perms, ...extra });
    const serviceToken = (name) => app.jwt.sign({ typ: 'service', sub: name });
    const bearer = (t) => ({ authorization: `Bearer ${t}` });
    return { ...ctx, app, userToken, serviceToken, bearer };
}

/** The testers' sample documents for Erf 1873 (angular-app/docs/samples), plus one other parcel. */
export async function fileSamples(service) {
    const f = (k, v) => ({ k, label: k, v });
    const file = (meta) => service.fileDocument({ meta, file: pdfFile(Buffer.from(`%PDF-1.7 ${meta.sourceId}`)) });
    const out = {};
    out.grant = (await file(deedMeta({ sourceId: 's1', docType: 'deed_of_grant', title: 'Deed of Grant', fields: [
        f('deedNo', 'G 88/1978'), f('regDate', '2 May 1978'), f('property', 'Erf 1873, Klein Windhoek'), f('regDiv', 'K'),
        f('grantor', 'the State'), f('tee1', 'Municipality of Windhoek')] }))).document;
    out.t1996 = (await file(deedMeta({ sourceId: 's2', fields: [
        f('deedNo', 'T 1502/1996'), f('property', 'Erf 1873, Klein Windhoek'), f('priorTitle', 'G 88/1978'),
        f('transferor', 'Municipality of Windhoek'), f('tee1', 'Johannes Shikongo'), f('tee1Id', '61042500187')] }))).document;
    out.sg = (await file(sgMeta({ sourceId: 's3', fields: [
        f('sgNo', 'A 412/2007'), f('property', 'Erf 1873, Klein Windhoek'), f('extent', '1 214 square metres')] }))).document;
    out.t2008 = (await file(deedMeta({ sourceId: 's4', fields: [
        f('deedNo', 'T 2210/2008'), f('property', 'Erf 1873, Klein Windhoek'), f('sgRef', 'A 412/2007'), f('priorTitle', 'T 1502/1996'),
        f('transferor', 'Johannes Shikongo'), f('transferorId', '61042500187'),
        f('tee1', 'Petrus Nghishidi'), f('tee1Id', '72110800345'), f('tee2', 'Maria Nghishidi'), f('tee2Id', '75060200418')] }))).document;
    out.t2019 = (await file(deedMeta({ sourceId: 's5', fields: [
        f('deedNo', 'T 4521/2019'), f('property', 'Erf 1873, Klein Windhoek'), f('priorTitle', 'T 2210/2008'),
        f('transferor', 'Estate of the late Petrus Nghishidi'),
        f('tee1', 'Ndapewa Nghishidi'), f('tee1Id', '98030100562'), f('tee2', 'Tomas Nghishidi'), f('tee2Id', '01112500379')] }))).document;
    out.olympia = (await file(deedMeta({ sourceId: 's6', fields: [
        f('deedNo', 'T 3329/2011'), f('property', 'Erf 3329, Olympia'), f('tee1', 'Frieda Hoäeb'), f('tee1Id', '80010100123'), f('tee2', 'Hilma !Naruseb')] }))).document;
    return out;
}
