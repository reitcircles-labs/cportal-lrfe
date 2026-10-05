import { createEventBus } from '@lrfe/common';
import { RecordsService } from '../src/records.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { sealOf } from '../src/seal.js';
import { buildApp } from '../src/app.js';

export const SECRET = 'records-test-secret-records-test-secret';
export const users = {
    rec: { id: 'u7', name: 'Josef Gawaseb', perms: ['dashboard.view', 'record.view', 'record.create', 'record.link', 'record.unlink', 'record.comment', 'record.finalize'] },
    sup: { id: 'u1', name: 'Elina Shivute', perms: ['dashboard.view', 'record.view', 'record.comment', 'record.finalize'] },
    scan: { id: 'u2', name: 'Kristofina Iipinge', perms: ['dashboard.view', 'capture.view', 'capture.scan'] }
};
export const actor = (u) => ({ id: u.id, name: u.name });

export const erf1873 = () => ({ kind: 'erf', number: '1873', township: 'Klein Windhoek', regDiv: 'K', region: 'Khomas' });
export const seal64 = (c = 'a') => c.repeat(64);

/** Version data for Erf 1873 as committed after T 4521/2019 (README.md section 2). */
export function erf1873Data(overrides = {}) {
    return {
        schemaVersion: 'erf/1',
        parcel: erf1873(),
        extent: { value: 1214, unit: 'm2', source: { from: 'document', edrmsNo: 'EDR-NA-2026-000003' } },
        tenure: 'freehold',
        owners: [
            { name: 'Maria Nghishidi', idNo: '75060200418', share: '1/2', since: 'T 4521/2019', source: { from: 'document', edrmsNo: 'EDR-NA-2026-000005' } },
            { name: 'Ndapewa Nghishidi', idNo: '98030100562', share: '1/4', since: 'T 4521/2019', source: { from: 'document', edrmsNo: 'EDR-NA-2026-000005' } },
            { name: 'Tomas Nghishidi', idNo: '01112500379', share: '1/4', since: 'T 4521/2019', source: { from: 'document', edrmsNo: 'EDR-NA-2026-000005' } }
        ],
        encumbrances: [],
        attributes: { zoning: 'Residential' },
        documents: [{
            edrmsDocumentId: '6f1c2b0e-4d3a-4c1b-9a8e-1b2c3d4e5f60', edrmsNo: 'EDR-NA-2026-000005', version: 1, seal: seal64('b'),
            docType: 'deed_of_transfer', ref: 'T 4521/2019', addedBy: 'u7', addedAt: '2026-10-05T09:12:00.000Z',
            fields: { deedNo: 'T 4521/2019', priorTitle: 'T 2210/2008' }
        }],
        ...overrides
    };
}

export function makeClock(start = Date.parse('2026-10-05T08:00:00Z')) {
    let now = start;
    const clock = () => new Date(now);
    clock.advance = (ms) => { now += ms; };
    return clock;
}

export function makeService() {
    const repo = createMemoryRepo();
    const events = createEventBus({ driver: 'memory', source: 'land-records' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const clock = makeClock();
    const service = new RecordsService({ repo, events, clock });
    return { repo, service, published, clock };
}

/**
 * Commit a version directly through the repo, as the review step will (API-647): put it in review
 * with `data`, then commit it with its seal chained to the previous current version.
 */
export async function commitVersion({ repo, clock }, recordId, versionNumber, data, { submitter = users.rec, approver = users.sup } = {}) {
    const record = await repo.getRecord(recordId);
    const previous = record.currentVersion ? await repo.getVersion(recordId, record.currentVersion) : null;
    await repo.updateVersion(recordId, versionNumber, { data, state: 'in_review', submittedAt: clock(), submittedById: submitter.id, submittedByName: submitter.name });
    clock.advance(60_000);
    const v = { ...(await repo.getVersion(recordId, versionNumber)), approvedById: approver.id, approvedByName: approver.name, committedAt: clock(), previousSeal: previous?.seal ?? null };
    const seal = sealOf(record, v);
    return repo.commit({
        recordId, versionNumber,
        versionPatch: { approvedById: approver.id, approvedByName: approver.name, committedAt: v.committedAt, previousSeal: v.previousSeal, seal },
        recordPatch: { status: 'committed', currentVersion: versionNumber, draftVersion: null, draftState: null, updatedAt: clock() },
        supersede: previous?.versionNumber
    });
}

/** Open a new draft (a copy of the current version), as a change will (API-648). */
export async function openDraft({ repo, clock }, recordId) {
    const record = await repo.getRecord(recordId);
    const current = await repo.getVersion(recordId, record.currentVersion);
    const n = current.versionNumber + 1;
    await repo.addVersion({ ...current, id: `00000000-0000-4000-8000-00000000000${n}`, versionNumber: n, state: 'draft', revision: 1, seal: null, previousSeal: null, committedAt: null, approvedById: null, approvedByName: null, submittedAt: null, submittedById: null, submittedByName: null, createdAt: clock(), updatedAt: clock() });
    await repo.updateRecord(recordId, { draftVersion: n, draftState: 'draft' });
    return n;
}

export async function makeHttp() {
    const ctx = makeService();
    const app = await buildApp({ service: ctx.service, jwtSecret: SECRET });
    await app.ready();
    const as = (u) => ({ authorization: `Bearer ${app.jwt.sign({ typ: 'access', sub: u.id, name: u.name, perms: u.perms })}` });
    return { ...ctx, app, as };
}

/**
 * land-records with a real in-process edrms (its routes, its search) holding the testers' sample
 * documents for Erf 1873 and one other parcel (edrms tests/helpers.js fileSamples).
 */
export async function makeWithEdrms() {
    const { createServiceTokenSigner } = await import('@lrfe/common');
    const { createMemoryStore } = await import('@lrfe/storage');
    const { EdrmsService } = await import('../../edrms/src/edrms.service.js');
    const { createMemoryRepo: edrmsRepo } = await import('../../edrms/src/repo/memory.js');
    const { buildApp: buildEdrms } = await import('../../edrms/src/app.js');
    const { fileSamples } = await import('../../edrms/tests/helpers.js');
    const { createEdrmsClient } = await import('../src/edrms-client.js');

    const edrmsService = new EdrmsService({ repo: edrmsRepo(), store: createMemoryStore(), events: createEventBus({ driver: 'memory', source: 'edrms' }) });
    const docs = await fileSamples(edrmsService);
    const edrmsApp = await buildEdrms({ service: edrmsService, jwtSecret: SECRET });
    await edrmsApp.ready();
    const fetchImpl = async (url, { method, headers }) => {
        const u = new URL(url);
        const r = await edrmsApp.inject({ method, url: u.pathname + u.search, headers });
        return { status: r.statusCode, text: async () => r.body };
    };
    const edrms = createEdrmsClient({ baseUrl: 'http://edrms', serviceToken: createServiceTokenSigner({ secret: SECRET, service: 'land-records' }), fetchImpl });
    const ctx = makeService();
    ctx.service.edrms = edrms;
    /** A document as it is pinned into a record version (README.md section 2). */
    ctx.pin = async (doc) => {
        const full = await edrmsService.getDocument(doc.id);
        const v = full.versions.find(x => x.versionNumber === full.currentVersion);
        return { edrmsDocumentId: full.id, edrmsNo: full.edrmsNo, version: v.versionNumber, seal: v.seal, docType: full.docType, ref: full.instrumentRef, fields: full.props };
    };
    return { ...ctx, edrmsService, docs };
}
