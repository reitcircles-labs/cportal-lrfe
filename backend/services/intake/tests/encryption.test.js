import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { createEncryptingStore, createFakeKeyring, KeyringError } from '@lrfe/storage';
import { makeIntake, makeHttp, answer, actor, users, pdf, fileOf } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
async function readAll(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}
const intakeKeys = () => createFakeKeyring({ keyName: 'intake-files' });
const edrmsKeys = () => createFakeKeyring({ keyName: 'edrms-files' });
/** A keyring whose vault is down (sealed or unreachable). */
const down = (keyName = 'intake-files') => ({
    keyName,
    newDataKey: async () => { throw new KeyringError('OpenBao unavailable: Vault is sealed', 'EUNAVAILABLE', { status: 503 }); },
    unwrap: async () => { throw new KeyringError('OpenBao unavailable: Vault is sealed', 'EUNAVAILABLE', { status: 503 }); }
});
/** The document row (with its encryption record) as stored. */
const row = (repo, id) => repo.getDocument(id);
/** Accept every field and file the document; returns the intake summary. */
async function reviewAndFile(service, id) {
    let d = await service.acceptClean(id, actor(users.rev));
    for (const f of d.fields.filter(x => x.status === 'pending')) d = await service.updateField(id, f.k, { status: 'accepted' }, actor(users.rev));
    return service.fileDocument(id, actor(users.rev));
}

describe('intake with encrypted staging', () => {
    it('stores the scan as ciphertext, with its encryption record; size and SHA-256 are the plain file\'s', async () => {
        const { service, repo, plainStore } = await makeIntake({ keyring: intakeKeys() });
        const bytes = pdf('T 2210/2008 encrypted capture');
        const batch = await service.createBatch({ source: 'Vault 3' }, actor(users.scan));
        const doc = await service.captureDocument({ batchId: batch.id, file: fileOf(bytes) }, actor(users.scan));
        const stored = await row(repo, doc.id);
        expect(stored.sha256).to.equal(sha(bytes));
        expect(stored.size).to.equal(bytes.length);
        expect(stored.encryption).to.include({ alg: 'AES-256-GCM-CHUNKED', keyName: 'intake-files' });
        const raw = plainStore.blobs.get(stored.fileKey).data;
        expect(raw.subarray(0, 4).toString()).to.equal('LRFE');
        expect(raw.includes(Buffer.from('T 2210/2008'))).to.equal(false);
    });

    it('the reader, the viewer and the page count get the plain scan', async () => {
        const seen = [];
        const { service, captureAndExtract } = await makeIntake({ keyring: intakeKeys(), respond: (f) => { seen.push(f.buffer); return answer(); } });
        const bytes = pdf('reader sees plain');
        const doc = await captureAndExtract(bytes);
        expect(doc.status).to.equal('ready');
        expect(seen[0].equals(bytes)).to.equal(true);
        const f = await service.openFile(doc.id);
        expect(await readAll(f.stream)).to.deep.equal(bytes);
    });

    it('the same file twice is still refused (the duplicate check uses the plain SHA-256)', async () => {
        const { service, batch } = await makeIntake({ keyring: intakeKeys() });
        const bytes = pdf('twice');
        await service.captureDocument({ batchId: batch.id, file: fileOf(bytes) }, actor(users.scan));
        const err = await service.captureDocument({ batchId: batch.id, file: fileOf(bytes, 'again.pdf') }, actor(users.scan)).catch(e => e);
        expect(err.statusCode).to.equal(409);
    });

    it('filing hands the plain scan to edrms, which stores it encrypted under its own key', async () => {
        const { service, captureAndExtract, edrmsService, edrmsPlainStore } = await makeIntake({ keyring: intakeKeys(), edrmsKeyring: edrmsKeys() });
        const bytes = pdf('filed encrypted');
        const doc = await captureAndExtract(bytes);
        const filed = await reviewAndFile(service, doc.id);
        expect(filed.status).to.equal('filed');
        const v1 = await edrmsService.repo.getVersion(filed.filedDocumentId, 1);
        expect(v1.sha256).to.equal(sha(bytes));
        expect(v1.encryption.keyName).to.equal('edrms-files');
        expect(edrmsPlainStore.blobs.get(v1.storageKey).data.subarray(0, 4).toString()).to.equal('LRFE');
        expect(await readAll((await edrmsService.openContent(filed.filedDocumentId, 1)).stream)).to.deep.equal(bytes);
        expect((await edrmsService.verifyVersion(filed.filedDocumentId, 1)).intact).to.equal(true);
    });

    it('scans captured before encryption keep working (read, reader, filing)', async () => {
        const ctx = await makeIntake();                                   // encryption off
        const bytes = pdf('captured before');
        const doc = await ctx.service.captureDocument({ batchId: ctx.batch.id, file: fileOf(bytes) }, actor(users.scan));
        ctx.service.store = createEncryptingStore(ctx.plainStore, intakeKeys());   // switched on later
        await ctx.worker.drain();
        expect((await ctx.service.getDocument(doc.id)).status).to.equal('ready');
        expect(await readAll((await ctx.service.openFile(doc.id)).stream)).to.deep.equal(bytes);
        expect((await reviewAndFile(ctx.service, doc.id)).status).to.equal('filed');
    });

    it('vault unavailable at capture: 503 with a neutral message, nothing stored', async () => {
        const { service, batch, plainStore, repo } = await makeIntake({ keyring: down() });
        const err = await service.captureDocument({ batchId: batch.id, file: fileOf(pdf('no vault')) }, actor(users.scan)).catch(e => e);
        expect(err.statusCode).to.equal(503);
        expect(err.message).to.equal('The document store is temporarily unavailable. Try again shortly.');
        expect(err.message).not.to.match(/openbao|vault|bao|keyring/i);
        expect(plainStore.blobs.size).to.equal(0);
        expect((await repo.listDocuments({})).items).to.have.length(0);
    });

    it('vault unavailable when reading: the job waits a minute without using an attempt, then reads', async () => {
        const keys = intakeKeys();
        const ctx = await makeIntake({ keyring: keys });
        const doc = await ctx.service.captureDocument({ batchId: ctx.batch.id, file: fileOf(pdf('paused')) }, actor(users.scan));
        ctx.service.store = createEncryptingStore(ctx.plainStore, down());
        for (let i = 0; i < 5; i++) {                                     // an outage longer than maxAttempts readings
            await ctx.worker.drain();
            ctx.clock.advance(61_000);
        }
        let d = await ctx.service.getDocument(doc.id);
        expect(d.status).to.equal('queued');
        expect(d.extractionError).to.equal('Reading paused: the document store is temporarily unavailable; it will be tried again automatically.');
        expect(ctx.calls).to.have.length(0);                              // no model was called
        const [job] = await ctx.repo.listJobs(doc.id);
        expect(job).to.include({ status: 'queued', attempts: 0 });
        ctx.service.store = createEncryptingStore(ctx.plainStore, keys); // vault back
        await ctx.worker.drain();
        d = await ctx.service.getDocument(doc.id);
        expect(d.status).to.equal('ready');
    });

    it('vault unavailable: viewing and filing answer 503', async () => {
        const keys = intakeKeys();
        const ctx = await makeIntake({ keyring: keys });
        const doc = await ctx.captureAndExtract(pdf('later down'));
        let d = await ctx.service.acceptClean(doc.id, actor(users.rev));
        for (const f of d.fields.filter(x => x.status === 'pending')) d = await ctx.service.updateField(doc.id, f.k, { status: 'accepted' }, actor(users.rev));
        ctx.service.store = createEncryptingStore(ctx.plainStore, down());
        expect((await ctx.service.openFile(doc.id).catch(e => e)).statusCode).to.equal(503);
        expect((await ctx.service.fileDocument(doc.id, actor(users.rev)).catch(e => e)).statusCode).to.equal(503);
        expect((await ctx.service.getDocument(doc.id)).status).to.equal('ready');   // nothing filed; can be filed later
    });
});

describe('intake HTTP API with encrypted staging', () => {
    it('serves the plain scan through the signed link, and never sends the encryption record', async () => {
        const { app, as, captureAndExtract } = await makeHttp({ keyring: intakeKeys() });
        const bytes = pdf('http plain');
        const doc = await captureAndExtract(bytes);
        const link = (await app.inject({ url: `/documents/${doc.id}/file-link`, headers: as(users.aud) })).json();
        const file = await app.inject({ url: link.url.replace('/api/intake', '') });
        expect(file.statusCode).to.equal(200);
        expect(file.rawPayload.equals(bytes)).to.equal(true);
        for (const url of [`/documents/${doc.id}`, '/documents', `/batches`]) {
            const res = await app.inject({ url, headers: as(users.rev) });
            expect(res.statusCode, url).to.equal(200);
            expect(res.body, url).not.to.match(/encryption|wrappedKey|fake:v1:|vault:v1:/);
        }
    });
});
