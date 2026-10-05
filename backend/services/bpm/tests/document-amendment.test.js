import { expect } from 'chai';
import { Readable } from 'node:stream';
import { createEventBus, signServiceToken } from '@lrfe/common';
import { BpmEngine } from '../src/engine/engine.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { createConnectors } from '../src/connectors/index.js';
import { loadDefinitions } from '../src/definitions/index.js';
import { buildApp as buildBpm } from '../src/app.js';
// The real edrms service, in-process.
import { EdrmsService } from '../../edrms/src/edrms.service.js';
import { createMemoryRepo as edrmsRepo } from '../../edrms/src/repo/memory.js';
import { createMemoryStore } from '../../edrms/src/storage/memory.js';
import { buildApp as buildEdrms } from '../../edrms/src/app.js';
import { users, rejects } from './helpers.js';

const SECRET = 'shared-jwt-secret-shared-jwt-secret';

/** fetch() over app.inject(), so bpm's connectors talk to the real edrms routes. */
const injectFetch = (app) => async (url, { method, headers, body }) => {
    const u = new URL(url);
    const res = await app.inject({ method, url: u.pathname + u.search, headers, payload: body });
    return { ok: res.statusCode < 400, status: res.statusCode, text: async () => res.body };
};

async function setup() {
    const edrmsService = new EdrmsService({ repo: edrmsRepo(), store: createMemoryStore(), events: createEventBus({ driver: 'memory', source: 'edrms' }) });
    const edrms = await buildEdrms({ service: edrmsService, jwtSecret: SECRET });
    await edrms.ready();

    const engine = new BpmEngine({ repo: createMemoryRepo(), events: createEventBus({ driver: 'memory', source: 'bpm' }) });
    const bpm = await buildBpm({ engine, jwtSecret: SECRET });
    engine.connectors = createConnectors({ urls: { edrms: 'http://edrms' }, serviceToken: () => signServiceToken(bpm, 'bpm'), fetchImpl: injectFetch(edrms) });
    for (const d of await loadDefinitions()) await engine.deployDefinition(d);
    await bpm.ready();

    const { document } = await edrmsService.fileDocument({
        meta: {
            sourceId: 'intake-doc-c', batchId: 'WDH-B017', docType: 'deed_of_transfer', title: 'Deed of Transfer', pages: 3,
            reviewedBy: { id: users.aina.id, name: users.aina.name },
            fields: [
                { k: 'deedNo', label: 'Deed number', v: 'T 4521/2019' },
                { k: 'tee2', label: 'Transferee 2', v: 'Tomas Nghishidi' },
                { k: 'tee2Id', label: 'Transferee 2 ID no.', v: '0111250379' }
            ]
        },
        file: { stream: Readable.from([Buffer.from('%PDF-1.7 T 4521/2019')]), fileName: 't4521.pdf', mimeType: 'application/pdf' }
    });

    const token = (u) => bpm.jwt.sign({ typ: 'access', sub: u.id, name: u.name, perms: u.perms, roles: u.roles });
    const as = (u) => ({ authorization: `Bearer ${token(u)}` });
    const request = (u, variables) => bpm.inject({ method: 'POST', url: '/processes/document-amendment/instances', headers: as(u), payload: { variables } });
    const fix = { documentId: document.id, expectedVersion: 1, reason: 'Transferee 2 ID is 10 digits; the original shows 01112500379', changes: [{ k: 'tee2Id', v: '01112500379' }] };
    return { edrms, edrmsService, bpm, engine, document, as, request, fix };
}

describe('document-amendment process (bpm ↔ edrms)', () => {
    it('request → second person approves → edrms v2.0 sealed with requester and approver', async () => {
        const { bpm, edrmsService, document, as, request, fix } = await setup();

        const started = await request(users.aina, fix);
        expect(started.statusCode, started.body).to.equal(201);
        const inst = started.json();
        expect(inst.variables.preview).to.deep.equal([{ k: 'tee2Id', label: 'Transferee 2 ID no.', from: '0111250379', to: '01112500379' }]);
        expect(inst.variables.document).to.include({ edrmsNo: 'EDR-NA-2026-000001', instrumentRef: 'T 4521/2019' });

        // The requester has no task; a second reviewer does.
        expect((await bpm.inject({ url: '/tasks', headers: as(users.aina) })).json().tasks).to.have.length(0);
        const inbox = (await bpm.inject({ url: '/tasks', headers: as(users.tangeni) })).json().tasks;
        expect(inbox).to.have.length(1);
        expect(inbox[0]).to.include({ title: 'Approve change to EDR-NA-2026-000001 (T 4521/2019)', overdue: false });
        expect(inbox[0].document.edrmsNo).to.equal('EDR-NA-2026-000001');

        const self = await bpm.inject({ method: 'POST', url: `/tasks/${inbox[0].id}/complete`, headers: as(users.aina), payload: { output: { outcome: 'approved' } } });
        expect(self.statusCode).to.equal(403);

        const done = await bpm.inject({ method: 'POST', url: `/tasks/${inbox[0].id}/complete`, headers: as(users.tangeni), payload: { output: { outcome: 'approved', comment: 'Matches the deed in Vault 3' } } });
        expect(done.statusCode, done.body).to.equal(200);
        expect(done.json().instance).to.include({ status: 'completed', outcome: 'amended' });

        const doc = await edrmsService.getDocument(document.id);
        expect(doc.currentVersion).to.equal(2);
        expect(doc.props.tee2Id).to.equal('01112500379');
        expect(doc.versions[1]).to.include({ kind: 'amendment', createdById: 'u3', approvedById: 'u8', approvedByName: 'Tangeni Iita' });
        expect((await edrmsService.verifyVersion(document.id, 2)).intact).to.equal(true);

        const detail = (await bpm.inject({ url: `/instances/${inst.id}`, headers: as(users.aina) })).json();
        expect(detail.variables.amendedVersion).to.equal(2);
        expect(detail.history.map(h => h.type)).to.include.members(['instance_started', 'task_created', 'task_completed', 'service_task_completed', 'instance_completed']);
    });

    it('a rejection needs a comment and leaves the record untouched', async () => {
        const { bpm, edrmsService, document, as, request, fix } = await setup();
        await request(users.aina, fix);
        const [task] = (await bpm.inject({ url: '/tasks', headers: as(users.tangeni) })).json().tasks;
        const noComment = await bpm.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: as(users.tangeni), payload: { output: { outcome: 'rejected' } } });
        expect(noComment.statusCode).to.equal(400);
        const res = await bpm.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: as(users.tangeni), payload: { output: { outcome: 'rejected', comment: 'The original shows 10 digits too; raise with the Master' } } });
        expect(res.json().instance).to.include({ outcome: 'rejected' });
        expect((await edrmsService.getDocument(document.id)).currentVersion).to.equal(1);
    });

    it('the precheck rejects stale versions, unknown fields, no-op changes and non-reviewers up front', async () => {
        const { request, fix, engine } = await setup();
        expect((await request(users.aina, { ...fix, expectedVersion: 2 })).statusCode).to.equal(409);
        expect((await request(users.aina, { ...fix, changes: [{ k: 'owner', v: 'X' }] })).statusCode).to.equal(400);
        expect((await request(users.aina, { ...fix, changes: [{ k: 'tee2Id', v: '0111250379' }] })).json().message).to.include('Nothing to change');
        expect((await request(users.kristofina, fix)).statusCode).to.equal(403);
        expect((await request(users.aina, { ...fix, reason: 'x' })).statusCode).to.equal(400);
        expect((await engine.repo.listInstances({})).total).to.equal(0);
    });

    it('one open change request per document', async () => {
        const { request, fix } = await setup();
        expect((await request(users.aina, fix)).statusCode).to.equal(201);
        const dup = await request(users.tangeni, { ...fix, reason: 'A different correction' });
        expect(dup.statusCode).to.equal(409);
    });

    it('if the record changed while waiting for approval, applying fails cleanly and can be cancelled', async () => {
        const { bpm, edrmsService, document, as, request, fix } = await setup();
        const inst = (await request(users.aina, fix)).json();
        // Meanwhile the record moved to v2 through another path.
        await edrmsService.amendDocument({ id: document.id, reason: 'Other correction', changes: [{ k: 'tee2', v: 'Tomas N. Nghishidi' }], actor: { id: 'x', name: 'X' }, approvedBy: { id: 'y', name: 'Y' } });

        const [task] = (await bpm.inject({ url: '/tasks', headers: as(users.tangeni) })).json().tasks;
        const res = await bpm.inject({ method: 'POST', url: `/tasks/${task.id}/complete`, headers: as(users.tangeni), payload: { output: { outcome: 'approved' } } });
        expect(res.json().instance.status).to.equal('error');
        const detail = (await bpm.inject({ url: `/instances/${inst.id}`, headers: as(users.aina) })).json();
        expect(detail.errorMessage).to.include('now at version 2.0');
        expect(detail.history.find(h => h.type === 'step_failed').payload.statusCode).to.equal(409);

        const cancelled = await bpm.inject({ method: 'POST', url: `/instances/${inst.id}/cancel`, headers: as(users.aina), payload: { reason: 'Superseded' } });
        expect(cancelled.json().status).to.equal('cancelled');
        expect((await edrmsService.getDocument(document.id)).currentVersion).to.equal(2);
    });

    it('HTTP guards: sign-in required; process list is public to signed-in users', async () => {
        const { bpm, as } = await setup();
        expect((await bpm.inject({ url: '/tasks' })).statusCode).to.equal(401);
        const list = (await bpm.inject({ url: '/processes', headers: as(users.kristofina) })).json().processes;
        expect(list.map(p => p.key)).to.deep.equal(['document-amendment', 'land-record-review']);
        expect(list[0].start).to.deep.equal({ perm: 'verify.edit' });
    });
});
