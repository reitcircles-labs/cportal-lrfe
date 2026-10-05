import { expect } from 'chai';
import FormData from 'form-data';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createEncryptingStore, createFakeKeyring, createMemoryStore, KeyringError } from '@lrfe/storage';
import { makeService, makeApp, deedMeta, pdfFile, PDF } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
async function readAll(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}
/** An encrypting store around a memory store, as EDRMS_ENCRYPTION=fake builds it. */
function encrypted() {
    const inner = createMemoryStore();
    const keyring = createFakeKeyring({ keyName: 'edrms-files' });
    return { inner, keyring, store: createEncryptingStore(inner, keyring) };
}
const storedBytes = (inner, version) => inner.blobs.get(version.storageKey).data;
/** A keyring whose vault is down (sealed or unreachable). */
const downKeyring = (keyName = 'edrms-files') => ({
    keyName,
    newDataKey: async () => { throw new KeyringError('OpenBao unavailable: Vault is sealed', 'EUNAVAILABLE', { status: 503 }); },
    unwrap: async () => { throw new KeyringError('OpenBao unavailable: Vault is sealed', 'EUNAVAILABLE', { status: 503 }); }
});

describe('edrms with encrypted storage', () => {
    it('files a record as ciphertext; it opens as the original, with the plain SHA-256 in the version', async () => {
        const { inner, store } = encrypted();
        const { service, repo } = makeService({ store });
        const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
        const v1 = await repo.getVersion(document.id, 1);
        expect(v1.sha256).to.equal(sha(PDF));
        expect(v1.encryption).to.include({ alg: 'AES-256-GCM-CHUNKED', keyName: 'edrms-files' });
        const bytes = storedBytes(inner, v1);
        expect(bytes.includes(Buffer.from('T 2210/2008'))).to.equal(false);
        expect(v1.encryption.cipherSha256).to.equal(sha(bytes));
        const { stream, mimeType } = await service.openContent(document.id, 1);
        expect(mimeType).to.equal('application/pdf');
        expect(await readAll(stream)).to.deep.equal(PDF);
    });

    it('the integrity check is intact, and fails for a changed stored byte', async () => {
        const { inner, store } = encrypted();
        const { service, repo } = makeService({ store });
        const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
        expect(await service.verifyVersion(document.id, 1)).to.include({ contentIntact: true, sealIntact: true, intact: true });
        const v1 = await repo.getVersion(document.id, 1);
        inner.blobs.get(v1.storageKey).data[40] ^= 1;
        const r = await service.verifyVersion(document.id, 1);
        expect(r).to.include({ contentIntact: false, sealIntact: true, intact: false, sha256: null });
    });

    it('an amendment with a new scan stores it encrypted; without one, the version keeps the previous file', async () => {
        const { inner, store } = encrypted();
        const { service, repo } = makeService({ store });
        const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
        // field change only: same file, same encryption record
        await service.amendDocument({ id: document.id, expectedVersion: 1, reason: 'Typo in division', changes: [{ k: 'regDiv', v: 'K ' }] });
        const [v1, v2] = [await repo.getVersion(document.id, 1), await repo.getVersion(document.id, 2)];
        expect(v2.storageKey).to.equal(v1.storageKey);
        expect(v2.encryption).to.deep.equal(v1.encryption);
        expect(await readAll((await service.openContent(document.id, 2)).stream)).to.deep.equal(PDF);
        expect((await service.verifyVersion(document.id, 2)).intact).to.equal(true);
        // a better rescan: a new file with its own data key
        const rescan = Buffer.concat([PDF, randomBytes(70_000)]);
        await service.amendDocument({ id: document.id, expectedVersion: 2, reason: 'Better rescan', file: { stream: Readable.from([rescan]), fileName: 'T2210-2008-rescan.pdf', mimeType: 'application/pdf' } });
        const v3 = await repo.getVersion(document.id, 3);
        expect(v3.storageKey).to.not.equal(v1.storageKey);
        expect(v3.encryption.wrappedKey).to.not.equal(v1.encryption.wrappedKey);
        expect(storedBytes(inner, v3).includes(rescan.subarray(0, 20))).to.equal(false);
        expect(await readAll((await service.openContent(document.id, 3)).stream)).to.deep.equal(rescan);
        expect((await service.verifyVersion(document.id, 3)).intact).to.equal(true);
    });

    it('versions filed before encryption still open and verify', async () => {
        const { inner, keyring } = encrypted();
        const ctx = makeService({ store: inner });                        // encryption off
        const { document } = await ctx.service.fileDocument({ meta: deedMeta(), file: pdfFile() });
        ctx.service.store = createEncryptingStore(inner, keyring);         // switched on later
        expect((await ctx.repo.getVersion(document.id, 1)).encryption).to.equal(undefined);
        expect(await readAll((await ctx.service.openContent(document.id, 1)).stream)).to.deep.equal(PDF);
        expect((await ctx.service.verifyVersion(document.id, 1)).intact).to.equal(true);
    });

    it('vault unavailable: filing answers 503 with a neutral message and stores nothing', async () => {
        const inner = createMemoryStore();
        const { service, repo } = makeService({ store: createEncryptingStore(inner, downKeyring()) });
        const err = await service.fileDocument({ meta: deedMeta(), file: pdfFile() }).catch(e => e);
        expect(err.statusCode).to.equal(503);
        expect(err.message).to.equal('The document store is temporarily unavailable. Try again shortly.');
        expect(err.message).not.to.match(/openbao|vault|bao|keyring/i);
        expect(err.cause.code).to.equal('EUNAVAILABLE');
        expect(inner.blobs.size).to.equal(0);
        expect((await repo.listDocuments({})).items ?? []).to.have.length(0);
    });

    it('vault unavailable: viewing and the integrity check answer 503', async () => {
        const { inner, keyring } = encrypted();
        const ok = makeService({ store: createEncryptingStore(inner, keyring) });
        const { document } = await ok.service.fileDocument({ meta: deedMeta(), file: pdfFile() });
        ok.service.store = createEncryptingStore(inner, downKeyring());
        expect((await ok.service.openContent(document.id, 1).catch(e => e)).statusCode).to.equal(503);
        expect((await ok.service.verifyVersion(document.id, 1).catch(e => e)).statusCode).to.equal(503);
    });
});

describe('edrms HTTP API with encrypted storage', () => {
    async function filed() {
        const { store } = encrypted();
        const ctx = await makeApp({ store });
        const form = new FormData();
        form.append('meta', JSON.stringify(deedMeta()));
        form.append('file', PDF, { filename: 'T2210-2008.pdf', contentType: 'application/pdf' });
        const res = await ctx.app.inject({ method: 'POST', url: '/documents', payload: form.getBuffer(), headers: { ...form.getHeaders(), ...ctx.bearer(ctx.serviceToken('intake')) } });
        expect(res.statusCode, res.body).to.equal(201);
        return { ...ctx, doc: res.json().document };
    }

    it('the viewer link goes through the signed /content route (no direct link to ciphertext) and serves the original', async () => {
        const { app, doc, userToken, bearer } = await filed();
        const link = (await app.inject({ method: 'GET', url: `/documents/${doc.id}/content`, headers: bearer(userToken(['record.view'])) })).json();
        expect(link.url).to.match(/^\/api\/document-content\//);
        const res = await app.inject({ method: 'GET', url: link.url.replace('/api/document-content', '/content') });
        expect(res.statusCode).to.equal(200);
        expect(res.headers['content-type']).to.equal('application/pdf');
        expect(res.rawPayload.equals(PDF)).to.equal(true);
    });

    it('never sends the encryption record (wrapped key) to clients', async () => {
        const { app, doc, userToken, bearer } = await filed();
        const h = { headers: bearer(userToken(['record.view', 'audit.view'])) };
        for (const url of [`/documents/${doc.id}`, `/documents/${doc.id}/versions/1`, `/documents/${doc.id}/versions/1/verify`]) {
            const res = await app.inject({ method: 'GET', url, ...h });
            expect(res.statusCode, url).to.equal(200);
            expect(res.body, url).not.to.match(/encryption|wrappedKey|fake:v1:|vault:v1:/);
        }
    });
});
