import { strict as assert } from 'node:assert';
import C from '@emurgo/cardano-serialization-lib-nodejs';
import { addressOf, readAnchorMetadata, LABEL } from '../src/cardano/tx.js';
import { EvidenceService, createEvidenceSources } from '../src/evidence.service.js';
import { createEventBus, createServiceTokenSigner } from '@lrfe/common';
import { AnchorService } from '../src/anchor.service.js';
import { TrailService } from '../src/trail.service.js';
import { TreeService } from '../src/tree.service.js';
import { ProofService, createVerifySources } from '../src/proof.service.js';
import { SignoffService, createSignoffClients } from '../src/signoff.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { createCardanoAdapter } from '../src/cardano/adapter.js';
import { createLocalSigner } from '../src/cardano/signer.js';
import { buildApp } from '../src/app.js';
import { AuditListService, createListSources } from '../src/audit-list.service.js';
import { AnchoringsService, createCoverageSources } from '../src/anchorings.service.js';
import { AnchorLookupService, createLookupSources } from '../src/lookup.service.js';
import { fakeDriver } from './helpers.js';
import { actor, makeWithReview, users, SECRET } from '../../land-records/tests/helpers.js';

export const MINUTE = 60_000;
export const quiet = { info() {}, warn() {}, error() {} };
export const rec = actor(users.rec);
export const asService = (service) => createServiceTokenSigner({ secret: SECRET, service });
// the auditor, the registrar who approves (sup, u1) and the records officer (rec, u7), with their roles
export const people = {
    aud: { id: 'u3', name: 'Martha Nakale', perms: ['record.view', 'audit.view', 'audit.signoff', 'audit.export'], roles: ['aud'] },
    aud2: { id: 'u4', name: 'Second Auditor', perms: ['record.view', 'audit.view', 'audit.signoff'], roles: ['aud'] },
    sup: { ...users.sup, perms: [...users.sup.perms, 'audit.view'], roles: ['sup'] },
    rec: { ...users.rec, roles: ['rec'] },
    // the registrar who approved, also given audit.signoff (the role-level rule switched off): refused
    supAuditing: { ...users.sup, perms: [...users.sup.perms, 'audit.view', 'audit.signoff'], roles: ['sup', 'aud'] },
    // the same person later moved to auditing (no record.finalize any more): still refused for the version they approved
    formerRegistrar: { id: users.sup.id, name: users.sup.name, perms: ['record.view', 'audit.view', 'audit.signoff'], roles: ['aud'] },
    // a records officer who can finalize, also given audit.signoff, who did not approve this version
    recAuditing: { ...users.rec, perms: [...users.rec.perms, 'audit.view', 'audit.signoff'], roles: ['rec', 'aud'] }
};

/**
 * Shared by the sign-off (API-659) and evidence pack (API-660) tests.
 *
 * Erf 1873 committed through the review (version 1, approved by the registrar), with the audit
 * service following every event: trail, tree, sign-offs and findings over HTTP to land-records,
 * edrms and bpm, and anchoring on the fake chain.
 */
export async function audited() {
    const repo = createMemoryRepo();
    let now = Date.parse('2026-10-11T08:00:00Z');
    const clock = () => new Date(now);
    clock.advance = (ms) => { now += ms; };
    const trail = new TrailService({ repo, clock, logger: quiet });
    const tree = new TreeService({ repo, clock, logger: quiet });
    const pending = [];
    let signoffs;
    // the audit service's consumer: every service's events, and its own
    const consume = (event) => { pending.push(trail.record(event).then(() => tree.fromEvent(event)).then(() => signoffs?.onEvent(event))); };
    const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const reg = await makeWithReview({ tap: consume });
    const events = createEventBus({ driver: 'memory', source: 'audit' });
    events.subscribe('*', consume);

    let r = await reg.service.createRecord({ edrmsDocumentId: reg.docs.grant.id }, rec);
    for (const k of ['t1996', 'sg', 't2008', 't2019']) r = await reg.service.addDocument(r.id, { revision: r.draft.revision, edrmsDocumentId: reg.docs[k].id }, rec);
    r = await reg.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners', 'extent'], changes: { tenure: 'freehold', attributes: { zoning: 'Residential' } } }, rec);
    await reg.service.submit(r.id, { revision: r.draft.revision }, rec);
    const decideAll = async (u, outcome = 'approved') => {
        const [task] = await reg.inbox(u);
        assert.equal((await reg.decide(u, task.id, { outcome })).statusCode, 200);
    };
    await decideAll(users.sup);
    await settle();

    const { buildApp: buildEdrms } = await import('../../edrms/src/app.js');
    const edrmsApp = await buildEdrms({ service: reg.edrmsService, jwtSecret: SECRET });
    await edrmsApp.ready();
    let bpmDown = false;
    const inject = (app) => async (url, init = {}) => {
        const u = new URL(url);
        const res = await app.inject({ method: init.method || 'GET', url: u.pathname + u.search, headers: init.headers, payload: init.body });
        return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body, arrayBuffer: async () => res.rawPayload };
    };
    const routed = (url, init) => {
        if (url.startsWith('http://bpm')) { if (bpmDown) throw new Error('connect ECONNREFUSED'); return inject(reg.bpm)(url, init); }
        return (url.startsWith('http://records') ? inject(reg.app) : inject(edrmsApp))(url, init);
    };
    // anchoring on the fake chain, proofs (the owning services recompute the seals), sign-off and the evidence pack
    const driver = fakeDriver();
    const cardano = createCardanoAdapter({ driver, signer: createLocalSigner(), network: 'preview', logger: quiet });
    const job = new AnchorService({ repo, tree, cardano, logger: quiet, clock, config: { confirmations: 10 } });
    const proofs = new ProofService({ repo, tree, cardano, clock, logger: quiet, sources: createVerifySources({ recordsUrl: 'http://records', edrmsUrl: 'http://edrms', serviceToken: asService('audit'), fetchImpl: routed }) });
    signoffs = new SignoffService({ repo, events, proofs, clock, logger: quiet, ...createSignoffClients({ recordsUrl: 'http://records', edrmsUrl: 'http://edrms', bpmUrl: 'http://bpm', serviceToken: asService('audit'), fetchImpl: routed }) });
    const evidence = new EvidenceService({ trail, proofs, signoffs, events, cardano, clock, logger: quiet, organisation: 'Land Titles Office · Testland', sources: createEvidenceSources({ recordsUrl: 'http://records', edrmsUrl: 'http://edrms', serviceToken: asService('audit'), fetchImpl: routed }) });
    /** Run the hourly job until an anchoring is confirmed (a block a minute). */
    const anchor = async () => {
        clock.advance(3_600_000);
        for (let i = 0; i < 40; i++) {
            if ((await job.tick()).action === 'confirmed') return;
            clock.advance(MINUTE); driver.chain.height++; driver.chain.slot += 60;
        }
        throw new Error('no anchoring confirmed');
    };
    const auditList = new AuditListService({ repo, proofs, sources: createListSources({ recordsUrl: 'http://records', serviceToken: asService('audit'), fetchImpl: routed }) });
    const anchorings = new AnchoringsService({ repo, tree, clock, sources: createCoverageSources({ recordsUrl: 'http://records', serviceToken: asService('audit'), fetchImpl: routed }) });
    const lookup = new AnchorLookupService({ repo, proofs, anchorings, clock, sources: createLookupSources({ recordsUrl: 'http://records', edrmsUrl: 'http://edrms', serviceToken: asService('audit'), fetchImpl: routed }) });
    const auditApp = await buildApp({ service: trail, proofs, signoffs, evidence, auditList, anchorings, lookup, jwtSecret: SECRET });
    await auditApp.ready();
    const as = (u) => ({ authorization: `Bearer ${auditApp.jwt.sign({ typ: 'access', sub: u.id, name: u.name, perms: u.perms, roles: u.roles })}` });
    const api = async (u, method, url, payload) => { const res = await auditApp.inject({ method, url, headers: as(u), payload }); await settle(); return res; };
    /** A user's bpm inbox (roles decide who gets a finding). */
    const inbox = async (u) => (await reg.bpm.inject({ url: '/tasks', headers: as(u) })).json().tasks;
    const record = await reg.service.getRecord(r.id);
    return { ...reg, repo, clock, trail, tree, events, signoffs, settle, auditApp, api, as, inbox, record, edrmsApp, decideAll, setBpmDown: (v) => { bpmDown = v; },
        driver, cardano, job, proofs, evidence, anchor, anchorings, lookup };
}

/** A second version of the record, through the review: submitted by the officer, approved by the registrar. */
export async function secondVersion(a) {
    let r = await a.service.openDraft(a.record.id, rec);
    r = await a.service.updateDraft(a.record.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'General Residential 1' } } }, rec);
    await a.service.submit(a.record.id, { revision: r.draft.revision }, rec);
    await a.decideAll(users.sup);
    await a.settle();
}

/** Koios as the offline verifier reads it, answering from the fake chain. */
export function publicSource(driver) {
    const payer = (cbor) => addressOf(C.Transaction.from_hex(cbor).witness_set().vkeys().get(0).vkey().public_key().as_bytes(), 'preview');
    return async (url, init) => {
        const [tx] = JSON.parse(init.body)._tx_hashes;
        const b = driver.chain.blocks.find(x => x.id === tx);
        const reply = (body) => ({ ok: true, status: 200, json: async () => body });
        if (url.endsWith('/tx_metadata')) return reply(b ? [{ tx_hash: tx, metadata: { [LABEL]: readAnchorMetadata(b.cbor) } }] : []);
        if (url.endsWith('/tx_status')) return reply([{ tx_hash: tx, num_confirmations: b ? driver.chain.height - b.height + 1 : null }]);
        return reply(b ? [{ tx_hash: tx, block_height: b.height, inputs: [{ payment_addr: { bech32: payer(b.cbor) } }] }] : []);
    };
}
