import { expect } from 'chai';
import { normalize, parseDate, parseExtent, sameName, occursIn } from '../src/extraction/normalize.js';
import { buildPrompt, buildResponseSchema, PROMPT_VERSION } from '../src/extraction/prompt.js';
import { costUsd } from '../src/extraction/pricing.js';
import { ALL_FIELD_KEYS, DOC_TYPES } from '../src/doc-types.js';

const codes = (r) => r.checks.map(c => `${c.level}:${c.code}`);

describe('normalisation & format checks', () => {
    it('dates in English, Afrikaans and German, and day-first numerics', () => {
        expect(parseDate('14 March 2008')).to.equal('2008-03-14');
        expect(parseDate('the 14th day of March, 2008')).to.equal('2008-03-14');
        expect(parseDate('14 Maart 2008')).to.equal('2008-03-14');
        expect(parseDate('9 Julie 2019')).to.equal('2019-07-09');
        expect(parseDate('2. Mai 1956')).to.equal('1956-05-02');
        expect(parseDate('14/03/2008')).to.equal('2008-03-14');
        expect(parseDate('2008-03-14')).to.equal('2008-03-14');
        expect(parseDate('31 February 2008')).to.equal(null);
        expect(codes(normalize('date', 'sometime in spring'))).to.deep.equal(['warn:date_format']);
        expect(codes(normalize('date', '14 March 2999'))).to.deep.equal(['warn:date_range']);
    });

    it('extents in m² and hectares, including Namibian number formats', () => {
        expect(parseExtent('1 214 square metres')).to.equal(1214);
        expect(parseExtent('1 214 m²')).to.equal(1214);
        expect(parseExtent('1,214 sq m')).to.equal(1214);
        expect(parseExtent('12,3456 hectares')).to.equal(123456);
        expect(parseExtent('856,5 ha')).to.equal(8565000);
        expect(parseExtent('1 214 vierkante meter')).to.equal(1214);
        expect(parseExtent('about one hectare')).to.equal(null);
    });

    it('Namibian ID numbers: 11 digits, date of birth, company numbers', () => {
        expect(normalize('id_number', '7211 0800 345')).to.include({ value: '72110800345', normalized: '72110800345' });
        expect(codes(normalize('id_number', '0111250379'))).to.deep.equal(['error:id_length']);
        expect(codes(normalize('id_number', '72139900345'))).to.deep.equal(['warn:id_dob']);
        expect(codes(normalize('id_number', '72I10800345'))).to.deep.equal(['error:id_digits']);
        expect(codes(normalize('id_number', 'CC/2005/1234'))).to.deep.equal(['info:registration_number']);
        expect(codes(normalize('id_number', '6508122-01-5'))).to.deep.equal(['warn:id_format']);
    });

    it('deed and diagram references are formatted canonically', () => {
        expect(normalize('deed_ref', 't2210 / 2008').value).to.equal('T 2210/2008');
        expect(normalize('deed_ref', 'No. T 02210/2008').value).to.equal('T 2210/2008');
        expect(normalize('sg_ref', 'S.G. No. A412/2007').value).to.equal('A 412/2007');
        expect(codes(normalize('deed_ref', 'Deed 2210 of 2008'))).to.deep.equal(['warn:format']);
        expect(codes(normalize('deed_ref', 'T 1/1776'))).to.deep.equal(['warn:year']);
    });

    it('flags values copied from an empty form line', () => {
        expect(codes(normalize('text', 'Erf no. _________________ FINKENSTEIN'))).to.deep.equal(['warn:blank_template']);
        expect(codes(normalize('date', 'this ........ day of ........'))).to.include('warn:blank_template');
    });

    it('registration division, money, text', () => {
        expect(normalize('reg_div', 'Registration Division “K”').value).to.equal('K');
        expect(normalize('money', 'N$ 640 000,00').normalized).to.equal('640000');
        expect(codes(normalize('money', 'inheritance, no consideration'))).to.deep.equal(['info:no_amount']);
        expect(normalize('text', '  Erf 1873,   Klein Windhoek ').value).to.equal('Erf 1873, Klein Windhoek');
    });

    it('name and evidence matching', () => {
        expect(sameName('Estate Late Petrus Nghishidi', 'Petrus Nghishidi')).to.equal(true);
        expect(sameName('Johannes Shikongo', 'Maria Nghishidi')).to.equal(false);
        expect(occursIn('Identity No.  61042500187', 'granted by Johannes Shikongo (Identity No. 61042500187).')).to.equal(true);
    });
});

describe('prompt, schema and pricing', () => {
    it('the prompt and schema cover every field of every document type', () => {
        const prompt = buildPrompt();
        for (const t of DOC_TYPES) for (const f of t.fields) expect(prompt).to.include(`- ${f.k}`);
        const schema = buildResponseSchema();
        expect(schema.properties.fields.items.properties.k.enum).to.deep.equal(ALL_FIELD_KEYS);
        expect(schema.properties.docType.enum).to.include.members(['deed_of_transfer', 'sg_diagram', 'unknown']);
        expect(buildPrompt({ transcribe: false })).to.include('Return "pages" as an empty list');
        expect(PROMPT_VERSION).to.be.a('string');
    });

    it('computes cost from tokens (thinking billed as output), with dated prices and batch discount', () => {
        const usage = { inputTokens: 1000, outputTokens: 1200, thoughtsTokens: 300 };
        expect(costUsd('gemini-3.1-flash-lite', usage)).to.equal(0.0025);
        expect(costUsd('gemini-3.1-flash-lite', usage, { batch: true })).to.equal(0.00125);
        expect(costUsd('gemini-3.8-flash', usage, { at: new Date('2026-12-31T12:00:00Z') })).to.equal(0.006375);
        expect(costUsd('gemini-3.8-flash', usage, { at: new Date('2027-01-01T00:00:00Z') })).to.equal(0.01275);
        expect(costUsd('some-new-model', usage)).to.equal(null);
    });
});
