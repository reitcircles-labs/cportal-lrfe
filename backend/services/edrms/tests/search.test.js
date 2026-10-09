import { expect } from 'chai';
import { makeService, fileSamples } from './helpers.js';
import { normalizeSearch, wordSimilarity, matchScore } from '../src/search.js';

describe('document search', () => {
    it('normalises: lowercase, no accents or punctuation, letters split from digits', () => {
        expect(normalizeSearch('Hoäeb, T 2210/2008 !Naruseb')).to.equal('hoaeb t 2210 2008 naruseb');
        expect(normalizeSearch('T2210/2008')).to.equal('t 2210 2008');
        expect(normalizeSearch('EDR-NA-2026-000001')).to.equal('edr na 2026 000001');
        expect(wordSimilarity('ngishidi', 'nghishidi')).to.be.above(0.5);
        expect(wordSimilarity('nghishidi', 'shikongo')).to.be.below(0.2);
        expect(matchScore('wind', 'erf 1873 klein windhoek')).to.be.above(0);
        expect(matchScore('erf 9999', 'erf 1873 klein windhoek')).to.equal(0);
    });

    describe('over filed documents', () => {
        let service, docs;
        const refs = async (query) => (await service.searchDocuments(query)).items.map(d => d.instrumentRef);
        before(async () => {
            ({ service } = makeService());
            docs = await fileSamples(service);
        });

        it('exact references, however they are typed', async () => {
            // its own document first; then the deed that cites it as prior title
            expect(await refs({ q: 'T 2210/2008' })).to.deep.equal(['T 2210/2008', 'T 4521/2019']);
            expect(await refs({ q: 't2210 / 2008' })).to.deep.equal(['T 2210/2008', 'T 4521/2019']);
            expect(await refs({ q: 'A 412/2007' })).to.deep.include('A 412/2007');
            expect(await refs({ q: docs.sg.edrmsNo })).to.deep.equal(['A 412/2007']);
        });

        it('an ID number finds the deeds that name that person', async () => {
            expect((await refs({ q: '61042500187' })).sort()).to.deep.equal(['T 1502/1996', 'T 2210/2008']);
            expect(await refs({ q: '01112500379' })).to.deep.equal(['T 4521/2019']);
        });

        it('words across all metadata, best match first', async () => {
            const found = await refs({ q: 'Klein Windhoek Shikongo' });
            expect(found.sort()).to.deep.equal(['T 1502/1996', 'T 2210/2008']);
            const nghishidi = await refs({ q: 'Nghishidi Klein Windhoek' });
            expect(nghishidi.sort()).to.deep.equal(['T 2210/2008', 'T 4521/2019']);
        });

        it('a misspelled owner name still finds them', async () => {
            expect((await refs({ q: 'Ngishidi' })).sort()).to.deep.equal(['T 2210/2008', 'T 4521/2019']);
            expect(await refs({ q: 'Shikongu' })).to.have.members(['T 1502/1996', 'T 2210/2008']);
        });

        it('accents and punctuation in names do not matter', async () => {
            expect(await refs({ q: 'Hoaeb' })).to.deep.equal(['T 3329/2011']);
            expect(await refs({ q: 'Hoäeb' })).to.deep.equal(['T 3329/2011']);
            expect(await refs({ q: 'Naruseb' })).to.deep.equal(['T 3329/2011']);
        });

        it('the start of a word is enough', async () => {
            expect((await refs({ q: 'Klein Wind' })).length).to.equal(5);
            expect(await refs({ q: 'Olym' })).to.deep.equal(['T 3329/2011']);
        });

        it('combines with field filters and the document type', async () => {
            expect((await refs({ q: 'Erf 1873', docType: 'deed_of_transfer' })).sort()).to.deep.equal(['T 1502/1996', 'T 2210/2008', 'T 4521/2019']);
            expect(await refs({ props: { priorTitle: 'T 2210/2008' } })).to.deep.equal(['T 4521/2019']);
            expect(await refs({ q: 'Nghishidi', props: { priorTitle: 'T 1502/1996' } })).to.deep.equal(['T 2210/2008']);
            expect(await refs({ docType: 'sg_diagram' })).to.deep.equal(['A 412/2007']);
        });

        it('finds nothing for words that are not there, and never returns the search text', async () => {
            expect(await refs({ q: 'Erf 9999' })).to.deep.equal([]);
            const { items } = await service.searchDocuments({ q: 'T 2210/2008' });
            expect(items[0]).to.not.have.property('searchText');
        });

        it('an amendment updates what a document is found by', async () => {
            await service.amendDocument({ id: docs.olympia.id, expectedVersion: 1, reason: 'Name misread', changes: [{ k: 'tee2', v: 'Hilma Haimbodi' }] });
            expect(await refs({ q: 'Haimbodi' })).to.deep.equal(['T 3329/2011']);
            expect(await refs({ q: 'Naruseb' })).to.deep.equal([]);
        });
    });
});
