import { expect } from 'chai';
import { runExtraction, buildRows } from '../src/extraction/pipeline.js';
import { createMockProvider, createGeminiProvider, sanitize, DEMO_ANSWER, mockAnswer } from '../src/extraction/providers.js';
import { createChecker, noChecks } from '../src/extraction/checks.js';
import { answer, withField } from './helpers.js';

const file = { buffer: Buffer.from('%PDF-1.7 test'), mimeType: 'application/pdf', fileName: 't.pdf' };
const row = (rows, k) => rows.find(r => r.k === k);
const codes = (r) => r.checks.map(c => c.code);

describe('extraction pipeline', () => {
    it('builds review rows in schema order: required always, optional when found', async () => {
        const a = sanitize(answer({ fields: DEMO_ANSWER.fields.filter(f => f.k !== 'regDate' && f.k !== 'conveyancer') }));
        const { rows } = buildRows(a, { model: 'm' });
        expect(rows[0].k).to.equal('deedNo');
        expect(row(rows, 'regDate')).to.include({ value: '', flag: 'ok' });
        expect(codes(row(rows, 'regDate'))).to.deep.equal(['missing']);
        expect(row(rows, 'conveyancer')).to.equal(undefined);
        expect(row(rows, 'tee1Id')).to.include({ extracted: '72110800345', model: 'm', status: 'pending' });
        expect(row(rows, 'tee1Id').evidence).to.deep.equal({ page: 1, text: 'Identity No. 72110800345' });
    });

    it('catches invented evidence and values that are not in their evidence', async () => {
        let a = withField(answer(), 'price', 'N$ 650 000,00', { evidence: 'sum of N$ 650 000,00' });   // not on the page
        a = withField(a, 'tee2', 'Maria Nghishidi-Shikongo', { evidence: 'and Maria Nghishidi' });    // value not in its quote
        const { rows } = await runExtraction({ file, primary: createMockProvider({ respond: () => a }), checker: noChecks });
        expect(codes(row(rows, 'price'))).to.include('evidence_not_found');
        expect(row(rows, 'price').flag).to.equal('check');
        expect(codes(row(rows, 'tee2'))).to.include('value_not_in_evidence');
    });

    it('flags illegible values and format errors', async () => {
        let a = withField(answer(), 'tee2Id', '0111250379');
        a = withField(a, 'regDiv', 'K', { legible: false });
        const { rows } = await runExtraction({ file, primary: createMockProvider({ respond: () => a }), checker: noChecks });
        expect(row(rows, 'tee2Id')).to.include({ flag: 'conflict' });
        expect(row(rows, 'regDiv')).to.include({ flag: 'check' });
        expect(codes(row(rows, 'regDiv'))).to.include('illegible');
    });

    it('escalates a weak reading to the stronger model and marks disagreements', async () => {
        const weak = withField(answer(), 'tee2Id', '0111250379');                       // 10 digits → conflict
        const strong = withField(answer(), 'tee2Id', '01112503790');
        const r = await runExtraction({
            file, checker: noChecks,
            primary: createMockProvider({ model: 'gemini-3.1-flash-lite', respond: () => weak }),
            escalation: createMockProvider({ model: 'gemini-3.1-pro-preview', respond: () => strong })
        });
        expect(r.escalated).to.equal(true);
        expect(r.attempts.map(x => [x.role, x.model])).to.deep.equal([['primary', 'gemini-3.1-flash-lite'], ['escalation', 'gemini-3.1-pro-preview']]);
        const id = row(r.rows, 'tee2Id');
        expect(id.value).to.equal('01112503790');
        expect(id.alt).to.deep.equal({ model: 'gemini-3.1-flash-lite', reading: 'first', value: '0111250379' });
        expect(id.checks.find(c => c.code === 'models_disagree').message).to.equal('The first reading gave “0111250379”');
        expect(codes(id)).to.include('models_disagree');
        expect(id.flag).to.equal('check');
        expect(r.notes.map(n => n.code)).to.include('escalated');
    });

    it('merges readings field by field: a lazier second reading never throws away the first', async () => {
        // What the 72-page deed of sale showed: Flash-Lite found the property, price and date and
        // transcribed every page; Pro copied an empty form line, missed fields and transcribed one page.
        const lite = answer({ pages: [{ page: 1, text: DEMO_ANSWER.pages[0].text + ' '.repeat(10) + 'annexures…' }] });
        const liteWithBadId = withField(lite, 'tee2Id', '750602004');                  // error → escalate
        const pro = answer({
            fields: DEMO_ANSWER.fields.filter(f => !['price', 'regDate'].includes(f.k))
                .map(f => (f.k === 'property' ? { ...f, value: 'Erf no. ________ Klein Windhoek', evidence: 'Erf no. ________ Klein Windhoek' } : f)),
            pages: [{ page: 1, text: 'DEED OF TRANSFER' }]
        });
        const r = await runExtraction({
            file, checker: noChecks,
            primary: createMockProvider({ model: 'gemini-3.1-flash-lite', respond: () => liteWithBadId }),
            escalation: createMockProvider({ model: 'gemini-3.1-pro-preview', respond: () => pro })
        });
        expect(r.escalated).to.equal(true);
        const property = row(r.rows, 'property');
        expect(property.value).to.equal('Erf 1873, Klein Windhoek');                         // Pro's blank line lost
        expect(property.alt).to.deep.equal({ model: 'gemini-3.1-pro-preview', reading: 'second', value: 'Erf no. ________ Klein Windhoek' });
        expect(row(r.rows, 'price')).to.include({ value: 'N$ 640 000,00', flag: 'check' });  // only Flash-Lite found it
        expect(codes(row(r.rows, 'price'))).to.include('single_reading');
        expect(row(r.rows, 'regDate').value).to.equal('14 March 2008');
        expect(row(r.rows, 'tee2Id').value).to.equal('75060200418');                         // Pro fixed the bad ID
        expect(r.answer.pages[0].text).to.include('annexures');                               // longer transcription kept
    });

    it('warns when a deed of sale gives the deposit as the purchase price', async () => {
        const sale = { docType: 'deed_of_sale', languages: ['en'], handwritingPresent: true, pages: [],
            fields: [['property', 'Portion 233 of the farm Finkenstein No. 526'], ['price', 'N$70 000,00'], ['deposit', 'N$ 70 000,00'], ['saleDate', '15.09.2020']]
                .map(([k, value]) => ({ k, value, page: 1, evidence: value, legible: true })) };
        const { rows } = buildRows(sanitize(sale), { model: 'm' });
        expect(codes(row(rows, 'price'))).to.include('same_as_deposit');
        expect(row(rows, 'saleDate').normalized).to.equal('2020-09-15');
    });

    it('does not re-read long documents automatically', async () => {
        const r = await runExtraction({
            file, checker: noChecks, pages: 72, maxEscalationPages: 10,
            primary: createMockProvider({ respond: () => withField(answer(), 'tee2Id', '123') }),
            escalation: createMockProvider({ respond: () => { throw new Error('should not be called'); } })
        });
        expect(r.escalated).to.equal(false);
        expect(r.attempts).to.have.length(1);
        expect(r.notes.find(n => n.code === 'escalation_skipped').message).to.include('72 pages');
    });

    it('does not escalate a clean reading; keeps the first reading if the escalation fails', async () => {
        const clean = await runExtraction({ file, checker: noChecks, primary: createMockProvider(), escalation: createMockProvider({ respond: () => { throw new Error('should not be called'); } }) });
        expect(clean.escalated).to.equal(false);
        expect(clean.attempts).to.have.length(1);

        const failing = { name: 'mock', model: 'pro', async extract() { const e = new Error('503 overloaded'); e.retryable = true; throw e; } };
        const r = await runExtraction({ file, checker: noChecks, primary: createMockProvider({ respond: () => answer({ docType: 'unknown' }) }), escalation: failing });
        expect(r.escalated).to.equal(false);
        expect(r.notes.map(n => n.code)).to.include('escalation_failed');
        expect(r.attempts[1]).to.include({ ok: false, role: 'escalation' });
    });

    it('a failing primary call throws with the attempt attached (for retry)', async () => {
        const failing = { name: 'gemini', model: 'x', async extract() { const e = new Error('429 quota'); e.retryable = true; throw e; } };
        try {
            await runExtraction({ file, primary: failing, checker: noChecks });
            throw new Error('should throw');
        } catch (err) {
            expect(err.retryable).to.equal(true);
            expect(err.attempts[0]).to.include({ ok: false, error: '429 quota' });
        }
    });

    it('prices each call', async () => {
        const r = await runExtraction({ file, checker: noChecks, primary: createMockProvider({ model: 'gemini-3.1-flash-lite' }) });
        expect(r.attempts[0].costUsd).to.equal(0.00205);   // 1000 in × $0.25 + 1200 out × $1.50, per 1M
    });
});

describe('Gemini provider (fake client)', () => {
    function fakeClient({ text = JSON.stringify(DEMO_ANSWER), error } = {}) {
        const seen = { calls: [], uploads: [], deletes: [] };
        return {
            seen,
            models: {
                async generateContent(req) {
                    seen.calls.push(req);
                    if (error) throw error;
                    return { text, usageMetadata: { promptTokenCount: 980, candidatesTokenCount: 1100, thoughtsTokenCount: 250 }, candidates: [{ finishReason: 'STOP' }] };
                }
            },
            files: {
                async upload({ file, config }) { seen.uploads.push({ size: file.size, config }); return { name: 'files/abc', uri: 'https://files/abc' }; },
                async delete({ name }) { seen.deletes.push(name); }
            }
        };
    }

    it('sends the PDF inline with the schema, medium resolution and low thinking; maps usage', async () => {
        const client = fakeClient();
        const p = createGeminiProvider({ model: 'gemini-3.1-flash-lite', client });
        const r = await p.extract(file);
        const req = client.seen.calls[0];
        expect(req.model).to.equal('gemini-3.1-flash-lite');
        expect(req.contents[0].parts[0].inlineData).to.deep.equal({ mimeType: 'application/pdf', data: file.buffer.toString('base64') });
        expect(req.contents[0].parts[1].text).to.include('Deeds Registry of the Republic of Namibia');
        expect(req.config).to.include({ responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' });
        expect(req.config.thinkingConfig).to.deep.equal({ thinkingLevel: 'LOW' });
        expect(req.config.responseJsonSchema.required).to.include('fields');
        expect(r.usage).to.deep.equal({ inputTokens: 980, outputTokens: 1100, thoughtsTokens: 250 });
        expect(r.result.fields).to.have.length(DEMO_ANSWER.fields.length);
    });

    it('uses a thinking budget for Gemini 2.x', async () => {
        const client = fakeClient();
        await createGeminiProvider({ model: 'gemini-2.5-flash-lite', client }).extract(file);
        expect(client.seen.calls[0].config.thinkingConfig).to.deep.equal({ thinkingBudget: 0 });
    });

    it('uploads large files through the Files API and deletes them afterwards', async () => {
        const client = fakeClient();
        const big = { ...file, buffer: Buffer.alloc(16 * 1024 * 1024, 1) };
        await createGeminiProvider({ model: 'gemini-3.1-flash-lite', client }).extract(big);
        expect(client.seen.uploads[0]).to.deep.include({ size: big.buffer.length });
        expect(client.seen.calls[0].contents[0].parts[0].fileData).to.deep.equal({ fileUri: 'https://files/abc', mimeType: 'application/pdf' });
        expect(client.seen.deletes).to.deep.equal(['files/abc']);
    });

    it('invalid JSON is retryable; a 400 is not; a 429 is', async () => {
        const bad = createGeminiProvider({ model: 'm', client: fakeClient({ text: 'not json' }) });
        await bad.extract(file).then(() => { throw new Error('should fail'); }, e => expect(e.retryable).to.equal(true));
        const four = createGeminiProvider({ model: 'm', client: fakeClient({ error: Object.assign(new Error('bad schema'), { status: 400 }) }) });
        await four.extract(file).then(() => { throw new Error('should fail'); }, e => expect(e.retryable).to.equal(false));
        const quota = createGeminiProvider({ model: 'm', client: fakeClient({ error: Object.assign(new Error('quota'), { status: 429 }) }) });
        await quota.extract(file).then(() => { throw new Error('should fail'); }, e => expect(e.retryable).to.equal(true));
    });

    it('refuses to start without credentials', () => {
        expect(() => createGeminiProvider({ model: 'm' })).to.throw(/GEMINI_API_KEY/);
    });
});

describe('cross-document checks', () => {
    const edrmsWith = (docs) => ({ async lookupRef(ref) { return docs[ref] ?? null; } });
    const rowsFor = (a) => buildRows(sanitize(a), { model: 'm' }).rows;

    it('flags a duplicate, and a prior title that is missing', async () => {
        const rows = rowsFor(answer());
        await createChecker({ edrms: edrmsWith({ 'T 2210/2008': { id: 'd1', edrmsNo: 'EDR-NA-2026-000009' } }) }).check('deed_of_transfer', rows);
        expect(row(rows, 'deedNo').checks.find(c => c.code === 'duplicate')).to.include({ level: 'error', message: 'T 2210/2008 is already filed as EDR-NA-2026-000009' });
        expect(codes(row(rows, 'priorTitle'))).to.include('prior_missing');
    });

    it('checks the chain of title and the SG diagram area', async () => {
        const rows = rowsFor(answer());
        await createChecker({
            edrms: edrmsWith({
                'T 1502/1996': { id: 'p', edrmsNo: 'EDR-NA-2025-000412', props: { property: 'Erf 1873, Klein Windhoek', tee1: 'Johannes Shikongo' } },
                'A 412/2007': { id: 's', edrmsNo: 'EDR-NA-2026-000005', props: { extent: '1 241 m²' } }
            })
        }).check('deed_of_transfer', rows);
        expect(codes(row(rows, 'priorTitle'))).to.include('prior_found');
        expect(codes(row(rows, 'transferor'))).to.include('chain_ok');
        expect(codes(row(rows, 'extent'))).to.include('extent_mismatch');
    });

    it('warns when the transferor was not a holder, or the prior title is another property', async () => {
        const rows = rowsFor(answer());
        await createChecker({ edrms: edrmsWith({ 'T 1502/1996': { id: 'p', edrmsNo: 'E', props: { property: 'Erf 1837, Klein Windhoek', tee1: 'S. Kaura' } } }) }).check('deed_of_transfer', rows);
        expect(codes(row(rows, 'transferor'))).to.include('chain');
        expect(codes(row(rows, 'property'))).to.include('prior_property');
    });

    it('deeds of sale: the seller must be a holder under the title deed; no duplicate check (no registry number)', async () => {
        const sale = {
            docType: 'deed_of_sale', languages: ['en'], handwritingPresent: false, pages: [],
            fields: [
                ['property', 'Portion 3 of the Farm Finkenstein No. 32'], ['priorTitle', 'T 1234/1999'],
                ['seller1', 'Finkenstein Family Trust'], ['buyer1', 'A. Purchaser'], ['price', 'N$ 2 500 000,00'], ['saleDate', '15 September 2020']
            ].map(([k, value]) => ({ k, value, page: 1, evidence: value, legible: true }))
        };
        const rows = rowsFor(sale);
        expect(rows.map(r => r.k)).to.include.members(['property', 'seller1', 'buyer1', 'price', 'saleDate']);
        await createChecker({ edrms: edrmsWith({ 'T 1234/1999': { id: 'p', edrmsNo: 'E1', props: { property: 'Portion 3 of the Farm Finkenstein No. 32', tee1: 'Someone Else' } } }) }).check('deed_of_sale', rows);
        expect(codes(row(rows, 'seller1'))).to.include('chain');
        expect(rows.some(r => codes(r).includes('duplicate'))).to.equal(false);
    });

    it('an unreachable EDRMS degrades to a warning, not a failure', async () => {
        const rows = rowsFor(answer());
        await createChecker({ edrms: { async lookupRef() { throw new Error('ECONNREFUSED'); } } }).check('deed_of_transfer', rows);
        expect(codes(row(rows, 'deedNo'))).to.include('crosscheck_unavailable');
    });
});

describe('mock provider', () => {
    it('reads the deed number from the file name when it carries one, else answers T 2210/2008', async () => {
        const mock = createMockProvider();
        const other = (await mock.extract({ fileName: 'deed-T4821-2008-ab12.pdf' })).result;
        expect(other.fields.find(f => f.k === 'deedNo')).to.include({ value: 'T 4821/2008', evidence: 'DEED OF TRANSFER No. T 4821/2008' });
        expect(other.pages[0].text).to.include('DEED OF TRANSFER No. T 4821/2008');
        expect(other.fields.find(f => f.k === 'priorTitle').value).to.equal('T 1502/1996');
        expect(mockAnswer({ fileName: 'scan-0001.pdf' })).to.equal(DEMO_ANSWER);
    });

    it('answers an SG diagram for a file named like one', async () => {
        const { result } = await createMockProvider().extract({ fileName: '03-SG-A-412-2007-diagram.pdf' });
        expect(result.docType).to.equal('sg_diagram');
        expect(result.fields.find(f => f.k === 'sgNo').value).to.equal('A 412/2007');
        expect(result.fields.find(f => f.k === 'extent').value).to.equal('1 214 square metres');
    });
});

describe('nothing the screen shows names a model or provider', () => {
    const MODEL_NAMES = /gemini|flash|pro-preview|google|vertex|model/i;
    const shown = (r) => JSON.stringify([r.rows.map(x => x.checks.map(c => c.message)), r.notes.map(n => n.message)]);

    it('after a second reading: disagreements, single readings and the escalation note', async () => {
        const weak = withField(answer(), 'tee2Id', '0111250379');
        const strong = answer({ fields: DEMO_ANSWER.fields.filter(f => f.k !== 'conveyancer').map(f => (f.k === 'tee2Id' ? { ...f, value: '01112503790', evidence: f.evidence.replace(f.value, '01112503790') } : f)) });
        const r = await runExtraction({
            file, checker: noChecks,
            primary: createMockProvider({ model: 'gemini-3.1-flash-lite', respond: () => weak }),
            escalation: createMockProvider({ model: 'gemini-3.1-pro-preview', respond: () => strong })
        });
        expect(codes(row(r.rows, 'tee2Id'))).to.include('models_disagree');
        expect(row(r.rows, 'conveyancer').checks.find(c => c.code === 'single_reading').message).to.equal('Found by the first reading only');
        expect(r.notes.find(n => n.code === 'escalated').message).to.match(/^Read a second time \(/);
        expect(shown(r)).not.to.match(MODEL_NAMES);
    });

    it('when the second reading fails, or the readings disagree on the type', async () => {
        const weak = withField(answer(), 'tee2Id', '0111250379');
        const failing = { name: 'gemini', model: 'gemini-3.1-pro-preview', extract: async () => { throw new Error('gemini-3.1-pro-preview call failed: 500 INTERNAL'); } };
        const r1 = await runExtraction({ file, checker: noChecks, primary: createMockProvider({ respond: () => weak }), escalation: failing });
        expect(r1.notes.find(n => n.code === 'escalation_failed').message).to.equal('Second reading failed; showing the first reading');
        expect(r1.attempts[1].error).to.contain('gemini-3.1-pro-preview');          // kept for the backend
        expect(shown(r1)).not.to.match(MODEL_NAMES);

        const other = answer({ docType: 'mortgage_bond' });
        const r2 = await runExtraction({ file, checker: noChecks, primary: createMockProvider({ respond: () => weak }), escalation: createMockProvider({ model: 'gemini-3.1-pro-preview', respond: () => other }) });
        expect(r2.notes.find(n => n.code === 'doctype_disagree').message).to.equal('The two readings disagree on the document type (Deed of transfer / Mortgage bond); keeping Deed of transfer');
        expect(shown(r2)).not.to.match(MODEL_NAMES);
    });
});
