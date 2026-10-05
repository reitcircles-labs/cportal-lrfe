import { Readable } from 'node:stream';
import { createEventBus, createServiceTokenSigner } from '@lrfe/common';
import { createEncryptingStore, createMemoryStore } from '@lrfe/storage';
import { IntakeService } from '../src/intake.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { createEdrmsClient } from '../src/edrms-client.js';
import { createChecker } from '../src/extraction/checks.js';
import { createMockProvider, DEMO_ANSWER } from '../src/extraction/providers.js';
import { ExtractionWorker } from '../src/worker.js';
import { buildApp } from '../src/app.js';
// The real edrms service, in-process
import { EdrmsService } from '../../edrms/src/edrms.service.js';
import { createMemoryRepo as edrmsRepo } from '../../edrms/src/repo/memory.js';
import { buildApp as buildEdrms } from '../../edrms/src/app.js';

export const SECRET = 'intake-test-secret-intake-test-secret';
export const users = {
    scan: { id: 'u2', name: 'Kristofina Iipinge', perms: ['dashboard.view', 'capture.view', 'capture.scan', 'capture.rescan'] },
    rev: { id: 'u3', name: 'Aina Mwandingi', perms: ['dashboard.view', 'capture.view', 'capture.rescan', 'verify.view', 'verify.edit', 'verify.file', 'record.view'] },
    rev2: { id: 'u8', name: 'Tangeni Iita', perms: ['dashboard.view', 'verify.view', 'verify.edit', 'verify.file'] },
    aud: { id: 'u5', name: 'Maria Nakale', perms: ['dashboard.view', 'capture.view', 'verify.view', 'record.view', 'audit.view'] }
};
export const actor = (u) => ({ id: u.id, name: u.name });
export const answer = (patch = {}) => ({ ...structuredClone(DEMO_ANSWER), ...patch });
export const withField = (a, k, value, extra = {}) => ({ ...a, fields: a.fields.map(f => (f.k === k ? { ...f, value, evidence: extra.evidence ?? f.evidence.replace(f.value, value), ...extra } : f)) });
export const pdf = (label = 'T 2210/2008') => Buffer.from(`%PDF-1.7\n% ${label} ${Math.random()}\n%%EOF\n`);
export const fileOf = (buffer = pdf(), name = 'WDH-B017_0001.pdf', mimeType = 'application/pdf') => ({ stream: Readable.from([buffer]), fileName: name, mimeType });

export function makeClock(start = Date.parse('2026-09-29T08:00:00Z')) {
    let now = start;
    const clock = () => new Date(now);
    clock.advance = (ms) => { now += ms; };
    return clock;
}

/** fetch() over app.inject(), so the edrms client talks to the real edrms routes. */
export const injectFetch = (app) => async (url, { method, headers, body }) => {
    const u = new URL(url);
    let payload = body, h = { ...headers };
    if (body instanceof FormData) {
        const res = new Response(body);
        payload = Buffer.from(await res.arrayBuffer());
        h['content-type'] = res.headers.get('content-type');
    }
    const r = await app.inject({ method, url: u.pathname + u.search, headers: h, payload });
    return { ok: r.statusCode < 400, status: r.statusCode, text: async () => r.body };
};

/**
 * Intake + worker + a real in-process edrms. `respond` scripts the model's answer per call
 * (default: the demo deed); `escalation` optionally scripts a second model; `jev` an optional
 * cross-check judge (e.g. createFakeJev); `keyring` / `edrmsKeyring` encrypt intake's / edrms's stored files.
 */
export async function makeIntake({ respond, escalation, budgetUsd = null, jev = null, jevConfig = null, keyring = null, edrmsKeyring = null } = {}) {
    const clock = makeClock();
    const edrmsPlainStore = createMemoryStore();
    const edrmsService = new EdrmsService({ repo: edrmsRepo(), store: edrmsKeyring ? createEncryptingStore(edrmsPlainStore, edrmsKeyring) : edrmsPlainStore, events: createEventBus({ driver: 'memory', source: 'edrms' }), clock });
    const edrmsApp = await buildEdrms({ service: edrmsService, jwtSecret: SECRET });
    await edrmsApp.ready();
    const edrms = createEdrmsClient({ baseUrl: 'http://edrms', serviceToken: createServiceTokenSigner({ secret: SECRET, service: 'intake' }), fetchImpl: injectFetch(edrmsApp) });

    const repo = createMemoryRepo();
    const plainStore = createMemoryStore();
    const store = keyring ? createEncryptingStore(plainStore, keyring) : plainStore;
    const events = createEventBus({ driver: 'memory', source: 'intake' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const checker = createChecker({ edrms });
    const service = new IntakeService({ repo, store, events, edrms, checker, clock });
    const calls = [];
    const primary = createMockProvider({ model: 'gemini-3.1-flash-lite', respond: async (f) => { calls.push(['primary', f.fileName]); return respond ? respond(f, calls.length) : answer(); } });
    const esc = escalation ? createMockProvider({ model: 'gemini-3.1-pro-preview', respond: async (f) => { calls.push(['escalation', f.fileName]); return escalation(f); } }) : null;
    const worker = new ExtractionWorker({ repo, service, store, primary, escalation: esc, checker, jev, jevConfig, clock, monthlyBudgetUsd: budgetUsd, logger: { warn() {}, error() {}, info() {} } });

    const batch = await service.createBatch({ source: 'Vault 3 · T-series 2008' }, actor(users.scan));
    /** Capture a file and run the worker until the queue is empty. */
    async function captureAndExtract(buffer = pdf(), name) {
        const doc = await service.captureDocument({ batchId: batch.id, file: fileOf(buffer, name) }, actor(users.scan));
        await worker.drain();
        return service.getDocument(doc.id);
    }
    /** File a finished record straight into edrms (for cross-check scenarios). */
    async function seedEdrms(meta) {
        return (await edrmsService.fileDocument({ meta: { reviewedBy: actor(users.rev), title: 'Seed', pages: 1, ...meta }, file: fileOf(pdf(meta.sourceId)) })).document;
    }
    return { clock, repo, store, plainStore, service, worker, edrmsService, edrmsPlainStore, edrmsApp, published, calls, batch, captureAndExtract, seedEdrms };
}

export async function makeHttp(opts) {
    const ctx = await makeIntake(opts);
    const app = await buildApp({ service: ctx.service, jwtSecret: SECRET });
    await app.ready();
    const token = (u) => app.jwt.sign({ typ: 'access', sub: u.id, name: u.name, perms: u.perms });
    const as = (u) => ({ authorization: `Bearer ${token(u)}` });
    return { ...ctx, app, as };
}

export async function rejects(promise, statusCode, messagePart) {
    try {
        await promise;
    } catch (err) {
        if (err.statusCode !== statusCode) throw err;
        if (messagePart && !err.message.includes(messagePart)) throw new Error(`expected "${messagePart}" in "${err.message}"`);
        return err;
    }
    throw new Error(`expected a ${statusCode} error`);
}
