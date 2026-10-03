import { expect } from 'chai';
import { runExtraction } from '../src/extraction/pipeline.js';
import { createMockProvider } from '../src/extraction/providers.js';
import { noChecks } from '../src/extraction/checks.js';
import { buildQuestions, statePages, XCHECK_CODES } from '../src/extraction/crosscheck.js';
import { createFakeJev, JevError } from '../src/extraction/jev.js';
import { answer, withField, makeIntake, actor, users } from './helpers.js';

const file = { buffer: Buffer.from('%PDF-1.7 test'), mimeType: 'application/pdf', fileName: 't.pdf' };
const row = (rows, k) => rows.find(r => r.k === k);
const codes = (r) => r.checks.map(c => c.code);
const primary = (a = answer()) => createMockProvider({ model: 'gemini-3.1-flash-lite', respond: () => a });
/** A judge that doubts the marital regime (wrong party), like the real mistake on sample 05. */
const doubtsMarital = (p = 0.86) => createFakeJev({ respond: () => ({ 'marital|wrongParty': p }) });

describe('automatic cross-check of extracted fields', () => {
    it('without a judge, nothing changes and no call is made', async () => {
        const r = await runExtraction({ file, primary: primary(), checker: noChecks });
        expect(r.attempts.map(a => a.role)).to.deep.equal(['primary']);
        expect(r.rows.every(x => !x.xcheck)).to.equal(true);
    });

    it('asks two questions per field with a value and one per empty required field, in one call', async () => {
        const jev = createFakeJev();
        const a = withField(answer(), 'transferor', '');           // required, left empty
        const r = await runExtraction({ file, primary: primary(a), checker: noChecks, jev });
        expect(jev.calls).to.have.length(1);
        const ids = Object.keys(jev.calls[0].questions);
        const valued = r.rows.filter(x => x.value).length;
        expect(ids).to.have.length(valued * 2 + 1);
        expect(ids).to.include.members(['deedNo|unsupported', 'deedNo|wrongParty', 'transferor|present']);
        expect(ids).not.to.include('transferor|wrongParty');
        expect(jev.calls[0].state.document.type).to.equal('Deed of transfer');
        expect(jev.calls[0].state.document.pages[0].text).to.contain('T 2210/2008');
        const q = jev.calls[0].questions['marital|wrongParty'];
        expect(q.type).to.equal('noul');
        expect(q.instructions.field).to.include({ label: 'Marital regime', value: 'married in community of property' });
        expect(q.criteria).to.have.keys('true', 'false');
    });

    it('marks a doubted field "check" with a neutral message and keeps the probabilities on the row', async () => {
        const r = await runExtraction({ file, primary: primary(), checker: noChecks, jev: doubtsMarital() });
        const m = row(r.rows, 'marital');
        expect(m.flag).to.equal('check');
        expect(codes(m)).to.include('xcheck_wrong_party');
        expect(m.xcheck).to.deep.equal({ unsupported: 0.02, wrongParty: 0.86 });
        expect(row(r.rows, 'deedNo').flag).to.equal('ok');
        expect(row(r.rows, 'deedNo').xcheck.unsupported).to.equal(0.02);
    });

    it('respects the threshold', async () => {
        const r = await runExtraction({ file, primary: primary(), checker: noChecks, jev: doubtsMarital(0.6), jevConfig: { flagAt: 0.7 } });
        expect(row(r.rows, 'marital').flag).to.equal('ok');
        expect(row(r.rows, 'marital').xcheck.wrongParty).to.equal(0.6);
    });

    it('never names the tool or the model in anything the screen shows', async () => {
        const jev = createFakeJev({ respond: ({ questions }) => Object.fromEntries(Object.keys(questions).map(id => [id, 0.99])) });
        const r = await runExtraction({ file, primary: primary(withField(answer(), 'transferor', '')), checker: noChecks, jev });
        const shown = JSON.stringify([r.rows.map(x => x.checks), r.notes]);
        expect(r.rows.flatMap(x => x.checks).filter(c => XCHECK_CODES.includes(c.code))).to.have.length.greaterThan(10);
        expect(shown).not.to.match(/jev|typesafe|fake|gemini|model/i);
    });

    it('a code error still wins over the cross-check', async () => {
        const jev = createFakeJev({ respond: () => ({ 'tee2Id|unsupported': 0.9 }) });
        const r = await runExtraction({ file, primary: primary(withField(answer(), 'tee2Id', '0111250379')), checker: noChecks, jev });
        expect(row(r.rows, 'tee2Id').flag).to.equal('conflict');
        expect(codes(row(r.rows, 'tee2Id'))).to.include('xcheck_unsupported');
    });

    it('records the call as a cross-check attempt with tokens and time', async () => {
        const r = await runExtraction({ file, primary: primary(), checker: noChecks, jev: doubtsMarital() });
        const x = r.attempts.find(a => a.role === 'crosscheck');
        expect(x).to.include({ ok: true, provider: 'fake', model: 'fake-jev' });
        expect(x.usage.inputTokens).to.be.greaterThan(0);
        expect(x.promptVersion).to.match(/^xcheck-/);
        expect(x.answer.answers['marital|wrongParty'].noul).to.equal(0.86);
    });

    it('when the judge fails, the fields stay as they are, with one neutral note', async () => {
        const jev = { name: 'typesafe', model: 'jev-latest', ask: async () => { throw new JevError('Jev did not answer within 5000 ms'); } };
        const r = await runExtraction({ file, primary: primary(), checker: noChecks, jev });
        const plain = await runExtraction({ file, primary: primary(), checker: noChecks });
        expect(r.rows.map(x => [x.k, x.flag, codes(x)])).to.deep.equal(plain.rows.map(x => [x.k, x.flag, codes(x)]));
        expect(r.notes.map(n => n.code)).to.deep.equal(['xcheck_unavailable']);
        expect(r.notes[0].message).to.equal('Automatic cross-check unavailable for this document');
        const x = r.attempts.find(a => a.role === 'crosscheck');
        expect(x).to.include({ ok: false, error: 'Jev did not answer within 5000 ms' });
    });

    it('does not call the judge without a transcription', async () => {
        const jev = createFakeJev();
        const r = await runExtraction({ file, primary: primary(answer({ pages: [] })), checker: noChecks, jev });
        expect(jev.calls).to.have.length(0);
        expect(r.notes.map(n => n.code)).to.include('xcheck_unavailable');
    });

    it('sends only the pages the fields cite, and page 1', () => {
        const a = answer({ pages: [1, 2, 3, 4].map(page => ({ page, text: `page ${page} text` })) });
        const rows = [{ k: 'x', evidence: { page: 3 } }, { k: 'y', evidence: { page: 3 } }];
        expect(statePages(a, rows).map(p => p.page)).to.deep.equal([1, 3]);
    });

    it('asks nothing for an unknown document type', () => {
        expect(buildQuestions('unknown', [{ k: 'deedNo', value: 'T 1/2000' }])).to.deep.equal({});
    });
});

describe('cross-check in the intake service', () => {
    it('keeps the reading (not the cross-check) as the latest extraction, and counts both calls', async () => {
        const { captureAndExtract } = await makeIntake({ jev: doubtsMarital() });
        const doc = await captureAndExtract();
        expect(doc.status).to.equal('ready');
        expect(doc.transcription[0].text).to.contain('T 2210/2008');
        expect(doc.extractions.map(e => e.role)).to.deep.equal(['primary', 'crosscheck']);
        const m = doc.fields.find(f => f.k === 'marital');
        expect(m.flag).to.equal('check');
        expect(m.checks.map(c => c.message)).to.include('May describe another party or item than this field asks for');
    });

    it('a reviewer correction clears the cross-check of that field only', async () => {
        const { service, captureAndExtract } = await makeIntake({ jev: createFakeJev({ respond: () => ({ 'marital|wrongParty': 0.9, 'conveyancer|unsupported': 0.8 }) }) });
        const doc = await captureAndExtract();
        const after = await service.updateField(doc.id, 'marital', { value: 'unmarried' }, actor(users.rev));
        const m = after.fields.find(f => f.k === 'marital');
        expect(m.checks.map(c => c.code)).not.to.include('xcheck_wrong_party');
        expect(m.xcheck).to.equal(undefined);
        expect(after.fields.find(f => f.k === 'conveyancer').checks.map(c => c.code)).to.include('xcheck_unsupported');
    });

    it('"Accept clean fields" leaves the doubted field for the reviewer', async () => {
        const { service, captureAndExtract } = await makeIntake({ jev: doubtsMarital() });
        const doc = await captureAndExtract();
        const after = await service.acceptClean(doc.id, actor(users.rev));
        expect(after.fields.find(f => f.k === 'marital').status).to.equal('pending');
        expect(after.fields.filter(f => f.status === 'pending').map(f => f.k)).to.include('marital');
    });
});
