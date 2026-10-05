import { expect } from 'chai';
import { makeWithEdrms, actor, users, erf1873 } from './helpers.js';
import { propertyMatches } from '../src/records.service.js';
import { buildApp } from '../src/app.js';
import { SECRET } from './helpers.js';

describe('finding documents for a land record', () => {
    it('property matching: whole words of the parcel, no other portion or erf', () => {
        expect(propertyMatches(erf1873(), 'Erf 1873, Klein Windhoek')).to.equal(true);
        expect(propertyMatches(erf1873(), 'ERF 1873 KLEIN-WINDHOEK')).to.equal(true);
        expect(propertyMatches(erf1873(), 'Erf 18730, Klein Windhoek')).to.equal(false);
        expect(propertyMatches(erf1873(), 'Erf 1873, Eros')).to.equal(false);
        expect(propertyMatches(erf1873(), 'Portion 2 of Erf 1873, Klein Windhoek')).to.equal(false);
        expect(propertyMatches({ ...erf1873(), portion: '2' }, 'Portion 2 of Erf 1873, Klein Windhoek')).to.equal(true);
        expect(propertyMatches({ kind: 'farm_portion', farmName: 'Finkenstein', farmNumber: '32', portion: '3' }, 'Portion 3 of the Farm Finkenstein No. 32')).to.equal(true);
    });

    describe('with the sample documents in edrms', () => {
        let ctx, record;
        const refs = (res) => res.items.map(d => d.ref);
        before(async () => {
            ctx = await makeWithEdrms();
            record = await ctx.service.createRecord({ parcel: erf1873() }, actor(users.rec));
        });

        it('searches by reference, owner (also misspelled), ID number, type and field', async () => {
            expect(refs(await ctx.service.searchDocuments({ q: 'T 2210/2008' }))[0]).to.equal('T 2210/2008');
            expect(refs(await ctx.service.searchDocuments({ q: 'Ngishidi' })).sort()).to.deep.equal(['T 2210/2008', 'T 4521/2019']);
            expect(refs(await ctx.service.searchDocuments({ q: '01112500379' }))).to.deep.equal(['T 4521/2019']);
            expect(refs(await ctx.service.searchDocuments({ docType: 'sg_diagram' }))).to.deep.equal(['A 412/2007']);
            expect(refs(await ctx.service.searchDocuments({ fields: { priorTitle: 'T 2210/2008' } }))).to.deep.equal(['T 4521/2019']);
            const item = (await ctx.service.searchDocuments({ q: 'A 412/2007' })).items[0];
            expect(item).to.include({ ref: 'A 412/2007', docType: 'sg_diagram', property: 'Erf 1873, Klein Windhoek', currentVersion: 1, inThisRecord: false });
            expect(item.edrmsNo).to.match(/^EDR-NA-2026-\d{6}$/);
            expect(item.linkedTo).to.deep.equal([]);
        });

        it('suggests every document whose property is this parcel, with the reason; not the other parcel', async () => {
            const s = await ctx.service.suggestions(record.id);
            expect(s.parcel).to.equal('Erf 1873, Klein Windhoek');
            expect(refs(s).sort()).to.deep.equal(['A 412/2007', 'G 88/1978', 'T 1502/1996', 'T 2210/2008', 'T 4521/2019']);
            expect(s.items.find(d => d.ref === 'T 2210/2008').reasons).to.deep.equal(['Property: Erf 1873, Klein Windhoek']);
        });

        it('adds reasons from the chain of documents already in the record, and marks them', async () => {
            const draft = await ctx.repo.getVersion(record.id, 1);
            await ctx.repo.updateVersion(record.id, 1, { data: { ...draft.data, documents: [await ctx.pin(ctx.docs.t2008)] } });
            const s = await ctx.service.suggestions(record.id);
            const by = (ref) => s.items.find(d => d.ref === ref);
            expect(by('T 2210/2008')).to.include({ inThisRecord: true });
            expect(by('A 412/2007').reasons).to.include('SG diagram cited by T 2210/2008');
            expect(by('T 1502/1996').reasons).to.include('Prior title of T 2210/2008');
            expect(by('T 4521/2019').reasons).to.include('Cites T 2210/2008 as prior title');
            expect(s.items.at(-1).ref).to.equal('T 2210/2008');      // already in this record: last
            const search = await ctx.service.searchDocuments({ q: 'T 2210/2008', recordId: record.id });
            expect(search.items[0]).to.include({ inThisRecord: true });
        });

        it('shows where a document is already linked in another record', async () => {
            const other = await ctx.service.createRecord({ parcel: { ...erf1873(), number: '1874' } }, actor(users.rec));
            const v = await ctx.repo.getVersion(other.id, 1);
            await ctx.repo.updateVersion(other.id, 1, { data: { ...v.data, documents: [await ctx.pin(ctx.docs.sg)] } });
            const item = (await ctx.service.searchDocuments({ q: 'A 412/2007', recordId: record.id })).items[0];
            expect(item.linkedTo).to.deep.equal([{ recordId: other.id, recordNo: other.recordNo, label: 'Erf 1874, Klein Windhoek' }]);
        });

        it('over HTTP: record.view, field filters, unknown record', async () => {
            const app = await buildApp({ service: ctx.service, jwtSecret: SECRET });
            await app.ready();
            const as = (u) => ({ authorization: `Bearer ${app.jwt.sign({ typ: 'access', sub: u.id, name: u.name, perms: u.perms })}` });
            const res = await app.inject({ url: `/records/document-search?q=Nghishidi&field.priorTitle=T%201502%2F1996&recordId=${record.id}`, headers: as(users.sup) });
            expect(res.statusCode).to.equal(200);
            expect(res.json().items.map(d => d.ref)).to.deep.equal(['T 2210/2008']);
            expect((await app.inject({ url: `/records/${record.id}/suggestions`, headers: as(users.rec) })).json().items).to.have.length(5);
            expect((await app.inject({ url: '/records/document-search?q=x', headers: as(users.scan) })).statusCode).to.equal(403);
            expect((await app.inject({ url: '/records/00000000-0000-4000-8000-000000000000/suggestions', headers: as(users.rec) })).statusCode).to.equal(404);
            expect((await app.inject({ url: '/records/document-search?recordId=not-a-uuid', headers: as(users.rec) })).statusCode).to.equal(400);
        });
    });
});
