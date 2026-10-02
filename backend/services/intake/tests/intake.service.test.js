import { expect } from 'chai';
import { makeIntake, answer, withField, actor, users, pdf, fileOf, rejects } from './helpers.js';

const field = (doc, k) => doc.fields.find(f => f.k === k);

describe('intake: capture → extract → review → file', () => {
    it('captures a file, extracts it in the worker, and puts it in review with flags', async () => {
        const { captureAndExtract, published, calls, service } = await makeIntake();
        const doc = await captureAndExtract();
        expect(doc).to.include({ status: 'ready', docType: 'deed_of_transfer', docTypeLabel: 'Deed of transfer', ref: 'T 2210/2008', property: 'Erf 1873, Klein Windhoek' });
        expect(doc.total).to.equal(17);
        expect(doc.reviewed).to.equal(0);
        expect(calls).to.have.length(1);
        expect(doc.extractions[0]).to.include({ role: 'primary', ok: true, model: 'gemini-3.1-flash-lite', costUsd: 0.00205 });
        expect(doc.transcription[0].text).to.include('DEED OF TRANSFER No. T 2210/2008');
        // Cross-checks ran against the (empty) EDRMS: the prior title is not there yet.
        expect(field(doc, 'priorTitle').checks.map(c => c.code)).to.include('prior_missing');
        expect(published.map(e => e.type)).to.deep.equal(['intake.document.captured', 'intake.document.extracted']);
        const events = await service.listEvents(doc.id);
        expect(events.map(e => e.action)).to.deep.equal(['captured', 'extracted']);
    });

    it('refuses the same file twice and unsupported types', async () => {
        const { service, batch } = await makeIntake();
        const bytes = pdf();
        await service.captureDocument({ batchId: batch.id, file: fileOf(bytes) }, actor(users.scan));
        const err = await rejects(service.captureDocument({ batchId: batch.id, file: fileOf(bytes, 'again.pdf') }, actor(users.scan)), 409, 'already captured');
        expect(err.details.documentId).to.be.a('string');
        await rejects(service.captureDocument({ batchId: batch.id, file: fileOf(Buffer.from('II*'), 'scan.tif', 'image/tiff') }, actor(users.scan)), 400, 'TIFF');
        await rejects(service.captureDocument({ batchId: 'WDH-B999', file: fileOf() }, actor(users.scan)), 404);
    });

    it('cross-checks against what is already filed: prior title found, chain of title ok', async () => {
        const { captureAndExtract, seedEdrms } = await makeIntake();
        await seedEdrms({ sourceId: 'seed-g2', docType: 'deed_of_transfer', fields: [{ k: 'deedNo', v: 'T 1502/1996' }, { k: 'property', v: 'Erf 1873, Klein Windhoek' }, { k: 'tee1', v: 'Johannes Shikongo' }] });
        const doc = await captureAndExtract();
        expect(field(doc, 'priorTitle').checks.map(c => c.code)).to.include('prior_found');
        expect(field(doc, 'transferor').checks.map(c => c.code)).to.include('chain_ok');
        expect(field(doc, 'priorTitle').flag).to.equal('ok');
    });

    it('review: claim lock, correct a value (re-checked), accept the rest, file into the EDRMS with provenance', async () => {
        const { captureAndExtract, service, edrmsService, published } = await makeIntake({ respond: () => withField(answer(), 'tee2Id', '7506020041') });
        let doc = await captureAndExtract();
        expect(field(doc, 'tee2Id')).to.include({ flag: 'conflict', value: '7506020041' });

        await service.claim(doc.id, actor(users.rev));
        await rejects(service.claim(doc.id, actor(users.rev2)), 409, 'Aina Mwandingi is reviewing');

        doc = await service.acceptClean(doc.id, actor(users.rev));
        const cleanCount = doc.fields.filter(f => f.flag === 'ok' && f.value).length;
        expect(doc.reviewed).to.equal(cleanCount);
        await rejects(service.fileDocument(doc.id, actor(users.rev)), 409, 'Not ready to file');

        doc = await service.updateField(doc.id, 'tee2Id', { value: '7506 0200 418' }, actor(users.rev));
        expect(field(doc, 'tee2Id')).to.include({ value: '75060200418', status: 'edited', flag: 'ok', extracted: '7506020041' });
        for (const f of doc.fields.filter(x => x.status === 'pending')) doc = await service.updateField(doc.id, f.k, { status: 'accepted' }, actor(users.rev));

        const filed = await service.fileDocument(doc.id, actor(users.rev));
        expect(filed).to.include({ status: 'filed', edrmsNo: 'EDR-NA-2026-000001' });
        const record = await edrmsService.getDocument(filed.filedDocumentId);
        expect(record.props.tee2Id).to.equal('75060200418');
        expect(record.fields.find(f => f.k === 'tee2Id').edited).to.equal(true);
        const v1 = await edrmsService.getVersion(filed.filedDocumentId, 1);
        expect(v1.provenance).to.deep.include({ provider: 'mock', model: 'gemini-3.1-flash-lite', intakeDocumentId: doc.id, corrected: ['tee2Id'] });
        expect(v1.provenance.extracted.tee2Id).to.equal('7506020041');
        expect((await edrmsService.verifyVersion(filed.filedDocumentId, 1)).intact).to.equal(true);
        expect(published.map(e => e.type)).to.include('intake.document.filed');

        const events = (await service.listEvents(doc.id)).map(e => e.action);
        expect(events).to.include.members(['fields_accepted', 'field_edited', 'filed']);
        const edit = (await service.listEvents(doc.id)).find(e => e.action === 'field_edited');
        expect(edit).to.include({ k: 'tee2Id', from: '7506020041', to: '75060200418', byName: 'Aina Mwandingi' });
    });

    it('a corrected deed number is re-checked: a duplicate blocks filing', async () => {
        const { captureAndExtract, service, seedEdrms } = await makeIntake();
        await seedEdrms({ sourceId: 'seed-dup', docType: 'deed_of_transfer', fields: [{ k: 'deedNo', v: 'T 2211/2008' }] });
        let doc = await captureAndExtract();
        doc = await service.updateField(doc.id, 'deedNo', { value: 't 2211 / 2008' }, actor(users.rev));
        expect(field(doc, 'deedNo')).to.include({ value: 'T 2211/2008', flag: 'conflict' });
        expect(field(doc, 'deedNo').checks.find(c => c.code === 'duplicate').message).to.include('already filed as EDR-NA-2026-000001');
    });

    it('a reviewer can add a field the model missed; wrong keys are refused', async () => {
        const { captureAndExtract, service } = await makeIntake({ respond: () => answer({ fields: answer().fields.filter(f => f.k !== 'conveyancer') }) });
        let doc = await captureAndExtract();
        expect(field(doc, 'conveyancer')).to.equal(undefined);
        doc = await service.updateField(doc.id, 'conveyancer', { value: 'H. van Wyk' }, actor(users.rev));
        expect(field(doc, 'conveyancer')).to.include({ value: 'H. van Wyk', status: 'edited', extracted: null });
        expect(doc.fields.map(f => f.k).indexOf('conveyancer')).to.equal(doc.fields.length - 1);
        await rejects(service.updateField(doc.id, 'sgNo', { value: 'A 1/2000' }, actor(users.rev)), 400, 'not a field of Deed of transfer');
    });

    it('rejecting keeps the document; a filed one cannot be rejected', async () => {
        const { captureAndExtract, service } = await makeIntake();
        const doc = await captureAndExtract();
        await rejects(service.rejectDocument(doc.id, '', actor(users.rev)), 400);
        const r = await service.rejectDocument(doc.id, 'Duplicate scan of page 2', actor(users.rev));
        expect(r).to.include({ status: 'rejected', rejectedReason: 'Duplicate scan of page 2' });
    });
});

describe('intake: worker behaviour', () => {
    it('retries a failing model call with backoff, then succeeds', async () => {
        const { service, worker, batch, clock } = await makeIntake({
            respond: (_f, n) => { if (n === 1) { const e = new Error('503 overloaded'); e.retryable = true; throw e; } return answer(); }
        });
        const doc = await service.captureDocument({ batchId: batch.id, file: fileOf() }, actor(users.scan));
        await worker.drain();
        let d = await service.getDocument(doc.id);
        expect(d).to.include({ status: 'queued', extractionError: '503 overloaded' });
        expect(await worker.drain()).to.equal(0);          // not due yet
        clock.advance(61_000);
        await worker.drain();
        d = await service.getDocument(doc.id);
        expect(d.status).to.equal('ready');
        expect(d.extractions.map(e => e.ok)).to.deep.equal([false, true]);
    });

    it('a non-retryable error fails at once; the reviewer can request a new reading', async () => {
        let fail = true;
        const { service, worker, batch } = await makeIntake({ respond: () => { if (fail) { const e = new Error('400 invalid document'); e.retryable = false; throw e; } return answer(); } });
        const doc = await service.captureDocument({ batchId: batch.id, file: fileOf() }, actor(users.scan));
        await worker.drain();
        expect((await service.getDocument(doc.id)).status).to.equal('failed');
        fail = false;
        await service.requestExtraction(doc.id, {}, actor(users.rev));
        await rejects(service.requestExtraction(doc.id, {}, actor(users.rev)), 409, 'already queued');
        await worker.drain();
        expect((await service.getDocument(doc.id)).status).to.equal('ready');
    });

    it('escalation on request re-reads with the stronger model', async () => {
        const { captureAndExtract, service, worker, calls } = await makeIntake({ escalation: () => answer() });
        const doc = await captureAndExtract();
        expect(calls.map(c => c[0])).to.deep.equal(['primary']);
        await service.requestExtraction(doc.id, { escalate: true }, actor(users.rev));
        await worker.drain();
        expect(calls.map(c => c[0])).to.deep.equal(['primary', 'escalation']);
        expect((await service.getDocument(doc.id)).escalated).to.equal(true);
    });

    it('stops taking jobs when the monthly budget is spent, and reports usage', async () => {
        const { service, worker, batch } = await makeIntake({ budgetUsd: 0.003 });
        await service.captureDocument({ batchId: batch.id, file: fileOf() }, actor(users.scan));
        await service.captureDocument({ batchId: batch.id, file: fileOf() }, actor(users.scan));
        await service.captureDocument({ batchId: batch.id, file: fileOf() }, actor(users.scan));
        expect(await worker.drain()).to.equal(2);          // 2 × $0.00205 passes $0.003
        const usage = await service.usage();
        expect(usage).to.deep.include({ month: '2026-09', documents: 2, costUsd: 0.0041 });
        expect(usage.byModel['gemini-3.1-flash-lite']).to.include({ calls: 2, inputTokens: 2000, outputTokens: 2400 });
    });

    it('lists batches with status counts and documents with search', async () => {
        const { captureAndExtract, service, batch } = await makeIntake();
        await captureAndExtract();
        const [b] = await service.listBatches();
        expect(b).to.include({ id: batch.id, source: 'Vault 3 · T-series 2008' });
        expect(b.counts).to.deep.equal({ total: 1, ready: 1 });
        expect(batch.id).to.equal('WDH-B001');
        expect((await service.listDocuments({ q: 'Nghishidi' })).total).to.equal(1);
        expect((await service.listDocuments({ status: ['filed'] })).total).to.equal(0);
    });
});
