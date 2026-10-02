import { expect } from 'chai';
import FormData from 'form-data';
import { makeHttp, users, pdf } from './helpers.js';

function upload(buffer = pdf(), filename = 'WDH-B001_0001.pdf', contentType = 'application/pdf') {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType });
    return { payload: form.getBuffer(), headers: form.getHeaders() };
}

describe('intake HTTP API', () => {
    it('a scan operator uploads; the worker extracts; a reviewer reviews and files', async () => {
        const { app, as, worker, batch } = await makeHttp();
        const up = upload();
        const created = await app.inject({ method: 'POST', url: `/batches/${batch.id}/documents`, payload: up.payload, headers: { ...up.headers, ...as(users.scan) } });
        expect(created.statusCode, created.body).to.equal(201);
        expect(created.json()).to.include({ status: 'queued', batchId: batch.id });
        const id = created.json().id;

        await worker.drain();
        const doc = (await app.inject({ url: `/documents/${id}`, headers: as(users.rev) })).json();
        expect(doc).to.include({ status: 'ready', ref: 'T 2210/2008' });

        // scan operators may not review; reviewers may
        expect((await app.inject({ method: 'POST', url: `/documents/${id}/accept-clean`, headers: as(users.scan) })).statusCode).to.equal(403);
        const accepted = await app.inject({ method: 'POST', url: `/documents/${id}/accept-clean`, headers: as(users.rev) });
        // Everything but the prior title, which is flagged: it is not in the (empty) EDRMS yet.
        expect(accepted.json().reviewed).to.equal(accepted.json().total - 1);
        expect(accepted.json().fields.find(f => f.status === 'pending')).to.include({ k: 'priorTitle', flag: 'check' });
        const early = await app.inject({ method: 'POST', url: `/documents/${id}/file`, headers: as(users.rev) });
        expect(early.json().details.blockers[0]).to.include('Prior title');
        // The reviewer looks at it and accepts it deliberately.
        await app.inject({ method: 'PUT', url: `/documents/${id}/fields/priorTitle`, payload: { status: 'accepted' }, headers: as(users.rev) });

        const filed = await app.inject({ method: 'POST', url: `/documents/${id}/file`, headers: as(users.rev) });
        expect(filed.statusCode, filed.body).to.equal(200);
        expect(filed.json()).to.include({ status: 'filed', edrmsNo: 'EDR-NA-2026-000001' });
    });

    it('filing reports what blocks it', async () => {
        const { app, as, captureAndExtract } = await makeHttp();
        const doc = await captureAndExtract();
        const res = await app.inject({ method: 'POST', url: `/documents/${doc.id}/file`, headers: as(users.rev) });
        expect(res.statusCode).to.equal(409);
        expect(res.json().details.blockers[0]).to.match(/field\(s\) not reviewed/);
    });

    it('field updates: validation of the body and permissions', async () => {
        const { app, as, captureAndExtract } = await makeHttp();
        const doc = await captureAndExtract();
        const put = (u, body) => app.inject({ method: 'PUT', url: `/documents/${doc.id}/fields/tee1Id`, payload: body, headers: as(u) });
        expect((await put(users.aud, { status: 'accepted' })).statusCode).to.equal(403);
        expect((await put(users.rev, { status: 'maybe' })).statusCode).to.equal(400);
        const ok = await put(users.rev, { value: '72110800346' });
        expect(ok.json().fields.find(f => f.k === 'tee1Id')).to.include({ value: '72110800346', status: 'edited' });
    });

    it('rejects a second upload of the same file with the existing document id', async () => {
        const { app, as, batch } = await makeHttp();
        const bytes = pdf();
        await app.inject({ method: 'POST', url: `/batches/${batch.id}/documents`, ...(() => { const u = upload(bytes); return { payload: u.payload, headers: { ...u.headers, ...as(users.scan) } }; })() });
        const u = upload(bytes, 'again.pdf');
        const dup = await app.inject({ method: 'POST', url: `/batches/${batch.id}/documents`, payload: u.payload, headers: { ...u.headers, ...as(users.scan) } });
        expect(dup.statusCode).to.equal(409);
        expect(dup.json().details.documentId).to.be.a('string');
    });

    it('serves the staged file through a signed, expiring link', async () => {
        const { app, as, captureAndExtract } = await makeHttp();
        const bytes = pdf('signed link');
        const doc = await captureAndExtract(bytes);
        const link = (await app.inject({ url: `/documents/${doc.id}/file-link`, headers: as(users.aud) })).json();
        expect(link.url).to.match(new RegExp(`^/api/intake/files/${doc.id}\\?exp=\\d+&sig=`));
        const path = link.url.replace('/api/intake', '');
        const file = await app.inject({ url: path });
        expect(file.statusCode).to.equal(200);
        expect(file.rawPayload.equals(bytes)).to.equal(true);
        expect((await app.inject({ url: path.replace(/sig=[^&]+/, 'sig=x') })).statusCode).to.equal(404);
    });

    it('batches, catalogue, usage and permissions', async () => {
        const { app, as, captureAndExtract } = await makeHttp();
        await captureAndExtract();
        expect((await app.inject({ url: '/batches' })).statusCode).to.equal(401);
        expect((await app.inject({ method: 'POST', url: '/batches', payload: { source: 'Vault 4' }, headers: as(users.rev) })).statusCode).to.equal(403);
        const created = await app.inject({ method: 'POST', url: '/batches', payload: { source: 'Vault 4 · SG diagrams' }, headers: as(users.scan) });
        expect(created.json().id).to.equal('WDH-B002');
        const cat = (await app.inject({ url: '/catalogue', headers: as(users.aud) })).json();
        expect(cat.docTypes.find(t => t.id === 'sg_diagram').fields.map(f => f.k)).to.include('beacons');
        expect((await app.inject({ url: '/usage', headers: as(users.rev) })).statusCode).to.equal(403);
        const usage = (await app.inject({ url: '/usage?month=2026-09', headers: as(users.aud) })).json();
        expect(usage).to.include({ month: '2026-09', documents: 1 });
    });
});
