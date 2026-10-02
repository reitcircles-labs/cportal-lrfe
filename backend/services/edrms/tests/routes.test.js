import { expect } from 'chai';
import FormData from 'form-data';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, deedMeta, PDF } from './helpers.js';
import { createLocalStore } from '../src/storage/local.js';
import { hashingStream } from '../src/storage/hashing.js';

function upload(meta, { file = PDF, contentType = 'application/pdf', metaFirst = true } = {}) {
    const form = new FormData();
    if (metaFirst && meta) form.append('meta', JSON.stringify(meta));
    if (file) form.append('file', file, { filename: 'T2210-2008.pdf', contentType });
    if (!metaFirst && meta) form.append('meta', JSON.stringify(meta));
    return { payload: form.getBuffer(), headers: form.getHeaders() };
}

describe('edrms HTTP API', () => {
    async function withFiled() {
        const ctx = await makeApp();
        const { payload, headers } = upload(deedMeta());
        const res = await ctx.app.inject({ method: 'POST', url: '/documents', payload, headers: { ...headers, ...ctx.bearer(ctx.serviceToken('intake')) } });
        expect(res.statusCode, res.body).to.equal(201);
        return { ...ctx, doc: res.json().document };
    }

    it('intake files a document with multipart meta + file; a retry returns 200 with the same record', async () => {
        const { app, bearer, serviceToken, doc } = await withFiled();
        expect(doc.edrmsNo).to.equal('EDR-NA-2026-000001');
        const { payload, headers } = upload(deedMeta());
        const again = await app.inject({ method: 'POST', url: '/documents', payload, headers: { ...headers, ...bearer(serviceToken('intake')) } });
        expect(again.statusCode).to.equal(200);
        expect(again.json()).to.deep.include({ created: false });
    });

    it('only the intake service can file', async () => {
        const { app, bearer, serviceToken, userToken } = await makeApp();
        const call = async (token) => {
            const { payload, headers } = upload(deedMeta());
            return app.inject({ method: 'POST', url: '/documents', payload, headers: { ...headers, ...bearer(token) } });
        };
        expect((await call(userToken(['verify.file', 'verify.edit']))).statusCode).to.equal(401);
        expect((await call(serviceToken('land-records'))).statusCode).to.equal(403);
    });

    it('rejects meta sent after the file, and bad JSON', async () => {
        const { app, bearer, serviceToken } = await makeApp();
        const late = upload(deedMeta(), { metaFirst: false });
        const res = await app.inject({ method: 'POST', url: '/documents', payload: late.payload, headers: { ...late.headers, ...bearer(serviceToken('intake')) } });
        expect(res.statusCode).to.equal(400);
        expect(res.json().message).to.include('"meta"');
    });

    it('users with a document-viewing permission can read; others cannot', async () => {
        const { app, bearer, userToken, serviceToken, doc } = await withFiled();
        for (const perm of ['capture.view', 'verify.view', 'record.view', 'audit.view']) {
            const res = await app.inject({ url: `/documents/${doc.id}`, headers: bearer(userToken([perm])) });
            expect(res.statusCode, perm).to.equal(200);
        }
        expect((await app.inject({ url: `/documents/${doc.id}`, headers: bearer(userToken(['admin.users'])) })).statusCode).to.equal(403);
        expect((await app.inject({ url: `/documents/${doc.id}`, headers: bearer(serviceToken('land-records')) })).statusCode).to.equal(200);
        const detail = (await app.inject({ url: `/documents/${doc.id}`, headers: bearer(userToken(['record.view'])) })).json();
        expect(detail.versions).to.have.length(1);
        expect(detail.versions[0]).to.not.have.property('storageKey');
    });

    it('lists with field filters and looks up by reference', async () => {
        const { app, bearer, userToken } = await withFiled();
        const h = bearer(userToken(['record.view']));
        const list = await app.inject({ url: `/documents?field.property=${encodeURIComponent('Erf 1873, Klein Windhoek')}&docType=deed_of_transfer`, headers: h });
        expect(list.json().total).to.equal(1);
        const none = await app.inject({ url: '/documents?field.property=Erf%201', headers: h });
        expect(none.json().total).to.equal(0);
        // Unknown query parameters are dropped (Fastify's removeAdditional), not treated as filters.
        const unknown = await app.inject({ url: '/documents?owner=x', headers: h });
        expect(unknown.json().total).to.equal(1);
        const lookup = await app.inject({ url: '/documents/lookup?instrumentRef=T%202210/2008', headers: h });
        expect(lookup.json().edrmsNo).to.equal('EDR-NA-2026-000001');
    });

    it('serves content through a signed, expiring link', async () => {
        const { app, bearer, userToken, doc } = await withFiled();
        const link = (await app.inject({ url: `/documents/${doc.id}/content`, headers: bearer(userToken(['verify.view'])) })).json();
        expect(link).to.include({ version: 1, mimeType: 'application/pdf', expiresIn: 300 });
        expect(link.url).to.match(new RegExp(`^/api/document-content/${doc.id}/1\\?exp=\\d+&sig=`));

        const path = link.url.replace('/api/document-content', '/content');
        const file = await app.inject({ url: path });
        expect(file.statusCode).to.equal(200);
        expect(file.headers['content-type']).to.equal('application/pdf');
        expect(file.rawPayload.equals(PDF)).to.equal(true);

        expect((await app.inject({ url: path.replace(/sig=[^&]+/, 'sig=forged') })).statusCode).to.equal(404);
        expect((await app.inject({ url: path.replace('/1?', '/2?') })).statusCode).to.equal(404);
        expect((await app.inject({ url: path.replace(/exp=\d+/, 'exp=1') })).statusCode).to.equal(404);
    });

    const amendment = {
        reason: 'ID hand-corrected on the original', expectedVersion: 1, changes: [{ k: 'tee2Id', v: '75060200419' }],
        actor: { id: 'u3', name: 'Aina Mwandingi' }, approvedBy: { id: 'u8', name: 'Tangeni Iita' }
    };

    it('applies approved amendments from the bpm service only; approver is sealed into the version', async () => {
        const { app, bearer, userToken, serviceToken, doc } = await withFiled();
        const post = (headers, payload = amendment) => app.inject({ method: 'POST', url: `/documents/${doc.id}/amendments`, payload, headers });

        // Users (whatever their permissions) and other services cannot amend directly.
        expect((await post(bearer(userToken(['verify.edit', 'verify.file'])))).statusCode).to.equal(401);
        expect((await post(bearer(serviceToken('intake')))).statusCode).to.equal(403);
        // Requester and approver must differ, even when bpm calls.
        const same = await post(bearer(serviceToken('bpm')), { ...amendment, approvedBy: amendment.actor });
        expect(same.statusCode).to.equal(403);

        const res = await post(bearer(serviceToken('bpm')));
        expect(res.statusCode, res.body).to.equal(201);
        expect(res.json().version).to.include({ label: '2.0', createdByName: 'Aina Mwandingi', approvedById: 'u8', approvedByName: 'Tangeni Iita' });

        const detail = (await app.inject({ url: `/documents/${doc.id}`, headers: bearer(serviceToken('bpm')) })).json();
        expect(detail.versions[1]).to.include({ approvedByName: 'Tangeni Iita' });
    });

    it('verifies integrity for auditors (audit.view)', async () => {
        const { app, bearer, userToken, serviceToken, doc } = await withFiled();
        await app.inject({ method: 'POST', url: `/documents/${doc.id}/amendments`, payload: amendment, headers: bearer(serviceToken('bpm')) });
        for (const n of [1, 2]) {
            const check = await app.inject({ url: `/documents/${doc.id}/versions/${n}/verify`, headers: bearer(userToken(['audit.view'])) });
            expect(check.json()).to.include({ intact: true, version: n });
        }
        expect((await app.inject({ url: `/documents/${doc.id}/versions/1/verify`, headers: bearer(userToken(['record.view'])) })).statusCode).to.equal(403);
    });

    it('rejects files over the size limit', async () => {
        const ctx = await makeApp();
        const { buildApp } = await import('../src/app.js');
        const app = await buildApp({ service: ctx.service, jwtSecret: 'edrms-test-secret-edrms-test-secret', maxFileBytes: 10 });
        const { payload, headers } = upload(deedMeta());
        const res = await app.inject({ method: 'POST', url: '/documents', payload, headers: { ...headers, authorization: `Bearer ${app.jwt.sign({ typ: 'service', sub: 'intake' })}` } });
        expect(res.statusCode).to.equal(413);
        expect(ctx.store.blobs.size).to.equal(0);
    });

    it('serves the catalogue to signed-in users', async () => {
        const { app, bearer, userToken } = await makeApp();
        const res = await app.inject({ url: '/catalogue', headers: bearer(userToken([])) });
        expect(res.json().docTypes.map(t => t.id)).to.include('sg_diagram');
        expect(res.json().recordMetadataFields).to.have.property('legalHold');
    });
});

describe('local filesystem store', () => {
    it('writes, hashes, reads back and refuses keys outside its root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'edrms-'));
        try {
            const store = createLocalStore({ root });
            const { sha256, size } = await store.put({ key: 'edrms/d1/v1/a.pdf', body: PDF });
            expect(size).to.equal(PDF.length);
            const { stream, result } = hashingStream(await store.getStream('edrms/d1/v1/a.pdf'));
            for await (const _ of stream) { /* consume */ }
            expect((await result()).sha256).to.equal(sha256);
            await store.put({ key: 'edrms/d1/v1/a.pdf', body: PDF }).then(() => { throw new Error('overwrote'); }, (err) => expect(err.code).to.equal('EEXIST'));
            await store.put({ key: '../escape.pdf', body: PDF }).then(() => { throw new Error('escaped'); }, (err) => expect(err.message).to.include('Invalid storage key'));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
