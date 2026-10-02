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

export function makeService() {
    const repo = createMemoryRepo();
    const store = createMemoryStore();
    const events = createEventBus({ driver: 'memory', source: 'edrms' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const clock = makeClock();
    const service = new EdrmsService({ repo, store, events, clock });
    return { repo, store, service, published, clock };
}

export async function makeApp() {
    const ctx = makeService();
    const app = await buildApp({ service: ctx.service, jwtSecret: JWT_SECRET, contentUrl: { base: '/api/document-content', secret: 'content-secret' } });
    await app.ready();
    const userToken = (perms, extra = {}) => app.jwt.sign({ typ: 'access', sub: 'u3', name: 'Aina Mwandingi', perms, ...extra });
    const serviceToken = (name) => app.jwt.sign({ typ: 'service', sub: name });
    const bearer = (t) => ({ authorization: `Bearer ${t}` });
    return { ...ctx, app, userToken, serviceToken, bearer };
}
