import { expect } from 'chai';
import { formatRecordNo, parcelKey, parcelLabel, validateVersion, schemaFor, PARCEL_KINDS } from '../src/catalogue.js';
import { sealOf } from '../src/seal.js';
import { makeService, makeHttp, actor, users, erf1873, erf1873Data, commitVersion, seal64 } from './helpers.js';

async function rejects(promise, statusCode, messagePart) {
    const err = await promise.then(() => null, e => e);
    expect(err, `expected a ${statusCode} error`).to.not.equal(null);
    expect(err.statusCode, err.message).to.equal(statusCode);
    if (messagePart) expect(err.message).to.include(messagePart);
    return err;
}

describe('catalogue: parcel kinds and schemas', () => {
    it('knows erf, farm portion and sectional unit, each with a versioned schema', () => {
        expect(PARCEL_KINDS.map(k => k.schemaVersion)).to.deep.equal(['erf/1', 'farm_portion/1', 'sectional_unit/1']);
        expect(schemaFor('erf/1').required).to.include.members(['parcel', 'extent', 'tenure', 'owners']);
    });

    it('a complete Erf 1873 version is valid; a draft may be incomplete', () => {
        expect(validateVersion(erf1873Data(), { complete: true })).to.deep.equal([]);
        const draft = { schemaVersion: 'erf/1', parcel: { kind: 'erf', number: '1873' } };
        expect(validateVersion(draft)).to.deep.equal([]);
        const problems = validateVersion(draft, { complete: true });
        expect(problems.join(' ')).to.include("must have required property 'extent'");
        expect(problems.join(' ')).to.include("must have required property 'township'");
    });

    it('refuses wrong types, unknown fields, a share that is not a fraction, an unknown schema', () => {
        expect(validateVersion(erf1873Data({ tenure: 'rented' }))[0]).to.match(/^\/tenure: must be equal to one of the allowed values \(freehold, leasehold, other\)/);
        expect(validateVersion(erf1873Data({ colour: 'red' }))[0]).to.include('must NOT have additional properties (colour)');
        const bad = erf1873Data();
        bad.owners[0].share = '½';
        expect(validateVersion(bad)[0]).to.match(/^\/owners\/0\/share: must match pattern/);
        bad.owners[0].share = '1/2';
        bad.documents[0].seal = 'not-a-seal';
        expect(validateVersion(bad)[0]).to.match(/^\/documents\/0\/seal/);
        expect(validateVersion({ schemaVersion: 'erf/9', parcel: {} })[0]).to.include('unknown "erf/9"');
    });

    it('attributes are free JSON', () => {
        expect(validateVersion(erf1873Data({ attributes: { zoning: 'Residential', municipal: { account: 12345, notes: ['a', 'b'] } } }), { complete: true })).to.deep.equal([]);
    });

    it('parcel keys are normalised, so one parcel has one key', () => {
        expect(parcelKey(erf1873())).to.equal('erf:K:KLEIN WINDHOEK:1873');
        expect(parcelKey({ ...erf1873(), township: '  klein   windhoek ', portion: '' })).to.equal('erf:K:KLEIN WINDHOEK:1873');
        expect(parcelKey({ ...erf1873(), portion: '2' })).to.equal('erf:K:KLEIN WINDHOEK:1873:2');
        expect(parcelKey({ kind: 'farm_portion', farmName: 'Finkenstein', farmNumber: '32', portion: '3', regDiv: 'K' })).to.equal('farm_portion:K:FINKENSTEIN:32:3');
        expect(parcelKey({ kind: 'castle' })).to.equal(null);
    });

    it('names parcels and numbers records', () => {
        expect(parcelLabel(erf1873())).to.equal('Erf 1873, Klein Windhoek');
        expect(parcelLabel({ kind: 'farm_portion', farmName: 'Finkenstein', farmNumber: '32', portion: '3' })).to.equal('Portion 3 of the Farm Finkenstein No. 32');
        expect(parcelLabel({ kind: 'sectional_unit', unit: '4', schemeName: 'Eros Gardens', schemeNumber: '17/2004' })).to.equal('Unit 4, Eros Gardens (SS 17/2004)');
        expect(formatRecordNo('NA', 2026, 1)).to.equal('LR-NA-2026-000001');
    });
});

describe('creating a record', () => {
    it('creates a draft v1 with a record number; announces it', async () => {
        const { service, published } = makeService();
        const r = await service.createRecord({ parcel: erf1873() }, actor(users.rec));
        expect(r).to.include({ recordNo: 'LR-NA-2026-000001', label: 'Erf 1873, Klein Windhoek', status: 'draft', currentVersion: null, draftVersion: 1, draftState: 'draft', needsReview: false });
        expect(r.current).to.equal(null);
        expect(r.draft).to.include({ versionNumber: 1, state: 'draft', revision: 1, schemaVersion: 'erf/1', createdByName: 'Josef Gawaseb' });
        expect(r.draft.data).to.deep.include({ parcel: erf1873(), owners: [], documents: [] });
        expect(published.map(e => e.type)).to.include('records.record.created');
        const second = await service.createRecord({ parcel: { ...erf1873(), number: '1874' } }, actor(users.rec));
        expect(second.recordNo).to.equal('LR-NA-2026-000002');
    });

    it('one record per parcel, whatever the spelling', async () => {
        const { service } = makeService();
        await service.createRecord({ parcel: erf1873() }, actor(users.rec));
        await rejects(service.createRecord({ parcel: { ...erf1873(), township: 'KLEIN  windhoek' } }, actor(users.rec)), 409, 'Erf 1873, KLEIN  windhoek already has a land record (LR-NA-2026-000001)');
    });

    it('refuses an unknown kind, a missing parcel field, invalid data', async () => {
        const { service } = makeService();
        await rejects(service.createRecord({ parcel: { kind: 'castle' } }), 400, 'parcel.kind must be one of erf, farm_portion, sectional_unit');
        await rejects(service.createRecord({ parcel: { kind: 'erf', number: '1873', regDiv: 'K' } }), 400, 'The parcel needs: township');
        const err = await rejects(service.createRecord({ parcel: { ...erf1873(), colour: 'red' } }), 400, 'not valid');
        expect(err.details.problems[0]).to.include('additional properties (colour)');
    });
});

describe('reading and searching records', () => {
    async function threeRecords() {
        const ctx = makeService();
        const a = await ctx.service.createRecord({ parcel: erf1873() }, actor(users.rec));
        await commitVersion(ctx, a.id, 1, erf1873Data());
        const b = await ctx.service.createRecord({ parcel: { ...erf1873(), number: '3329', township: 'Olympia' } }, actor(users.rec));
        const c = await ctx.service.createRecord({ parcel: { kind: 'farm_portion', farmName: 'Finkenstein', farmNumber: '32', portion: '3', regDiv: 'K' } }, actor(users.rec));
        // the committed record's search text follows its current version (set by the commit step later)
        const { searchTextOf } = await import('../src/records.service.js');
        await ctx.repo.updateRecord(a.id, { searchText: searchTextOf(await ctx.repo.getRecord(a.id), erf1873Data()) });
        return { ...ctx, a, b, c };
    }

    it('finds records by record number, parcel, owner name, ID number and deed reference', async () => {
        const { service } = await threeRecords();
        const labels = async (q) => (await service.listRecords({ q })).items.map(r => r.label);
        expect(await labels('LR-NA-2026-000002')).to.deep.equal(['Erf 3329, Olympia']);
        expect(await labels('olympia')).to.deep.equal(['Erf 3329, Olympia']);
        expect(await labels('Tomas Nghishidi')).to.deep.equal(['Erf 1873, Klein Windhoek']);
        expect(await labels('98030100562')).to.deep.equal(['Erf 1873, Klein Windhoek']);
        expect(await labels('T 4521/2019')).to.deep.equal(['Erf 1873, Klein Windhoek']);
        expect(await labels('Finkenstein')).to.deep.equal(['Portion 3 of the Farm Finkenstein No. 32']);
    });

    it('filters by status: draft, committed, in review, needs review', async () => {
        const ctx = await threeRecords();
        const by = async (status) => (await ctx.service.listRecords({ status })).items.map(r => r.label).sort();
        expect(await by('committed')).to.deep.equal(['Erf 1873, Klein Windhoek']);
        expect(await by('draft')).to.deep.equal(['Erf 3329, Olympia', 'Portion 3 of the Farm Finkenstein No. 32']);
        await ctx.repo.updateRecord(ctx.b.id, { draftState: 'in_review' });
        expect(await by('in_review')).to.deep.equal(['Erf 3329, Olympia']);
        await ctx.repo.updateRecord(ctx.a.id, { flags: [{ type: 'document_updated', edrmsNo: 'EDR-NA-2026-000005', from: 1, to: 2 }] });
        expect(await by('needs_review')).to.deep.equal(['Erf 1873, Klein Windhoek']);
        await rejects(ctx.service.listRecords({ status: 'lost' }), 400);
    });

    it('a record with its current version and open draft; its versions; one version', async () => {
        const ctx = await threeRecords();
        await ctx.service.openDraft(ctx.a.id, actor(users.rec));
        const r = await ctx.service.getRecord(ctx.a.id);
        expect(r).to.include({ status: 'committed', currentVersion: 1, draftVersion: 2 });
        expect(r.current).to.include({ versionNumber: 1, state: 'committed', approvedByName: 'Elina Shivute' });
        expect(r.draft).to.include({ versionNumber: 2, state: 'draft' });
        const versions = await ctx.service.listVersions(ctx.a.id);
        expect(versions.map(v => [v.versionNumber, v.state])).to.deep.equal([[1, 'committed'], [2, 'draft']]);
        expect(versions[0].seal).to.match(/^[0-9a-f]{64}$/);
        expect((await ctx.service.getVersion(ctx.a.id, 1)).data.owners).to.have.length(3);
        await rejects(ctx.service.getVersion(ctx.a.id, 9), 404, 'Version not found');
        await rejects(ctx.service.getRecord('00000000-0000-4000-8000-000000000000'), 404, 'Land record not found');
    });
});

describe('seals and the version chain', () => {
    async function twoCommitted() {
        const ctx = makeService();
        const r = await ctx.service.createRecord({ parcel: erf1873() }, actor(users.rec));
        await commitVersion(ctx, r.id, 1, erf1873Data());
        await ctx.service.openDraft(r.id, actor(users.rec));
        const v2 = erf1873Data({ encumbrances: [{ type: 'bond', ref: 'B 1234/2020', inFavourOf: 'Bank Windhoek' }] });
        await commitVersion(ctx, r.id, 2, v2, { submitter: users.rec, approver: users.sup });
        return { ...ctx, id: r.id };
    }

    it('committing seals a version and chains it to the previous one; the older version is superseded', async () => {
        const ctx = await twoCommitted();
        const [v1, v2] = await ctx.repo.listVersions(ctx.id);
        expect(v1.state).to.equal('superseded');
        expect(v2.state).to.equal('committed');
        expect(v1.previousSeal).to.equal(null);
        expect(v2.previousSeal).to.equal(v1.seal);
        const result = await ctx.service.verify(ctx.id);
        expect(result.intact).to.equal(true);
        expect(result.versions.map(v => [v.versionNumber, v.intact, v.linked])).to.deep.equal([[1, true, true], [2, true, true]]);
    });

    it('changing anything in a committed version breaks its seal', async () => {
        const ctx = await twoCommitted();
        const v1 = await ctx.repo.getVersion(ctx.id, 1);
        await ctx.repo.updateVersion(ctx.id, 1, { data: { ...v1.data, owners: v1.data.owners.map((o, i) => (i ? o : { ...o, share: '3/4' })) } });
        const result = await ctx.service.verify(ctx.id);
        expect(result.intact).to.equal(false);
        expect(result.versions[0]).to.include({ intact: false });
        expect(result.versions[1]).to.include({ intact: true, linked: true });
    });

    it('rewriting an earlier version with a new seal still breaks the chain at the next version', async () => {
        const ctx = await twoCommitted();
        const record = await ctx.repo.getRecord(ctx.id);
        const v1 = await ctx.repo.getVersion(ctx.id, 1);
        const forged = { ...v1, data: { ...v1.data, tenure: 'leasehold' } };
        await ctx.repo.updateVersion(ctx.id, 1, { data: forged.data, seal: sealOf(record, forged) });
        const result = await ctx.service.verify(ctx.id);
        expect(result.versions[0]).to.include({ intact: true, linked: true });
        expect(result.versions[1]).to.include({ intact: true, linked: false });
        expect(result.intact).to.equal(false);
    });

    it('the seal covers the pinned documents\' own seals', () => {
        const record = { id: 'r1', recordNo: 'LR-NA-2026-000001' };
        const v = { versionNumber: 1, data: erf1873Data(), committedAt: '2026-10-05T08:00:00Z' };
        const other = structuredClone(v);
        other.data.documents[0].seal = seal64('c');
        expect(sealOf(record, v)).to.not.equal(sealOf(record, other));
    });

    it('a draft does not change the current version', async () => {
        const ctx = makeService();
        const r = await ctx.service.createRecord({ parcel: erf1873() }, actor(users.rec));
        await commitVersion(ctx, r.id, 1, erf1873Data());
        await ctx.service.openDraft(r.id, actor(users.rec));
        await ctx.repo.updateVersion(r.id, 2, { data: erf1873Data({ tenure: 'leasehold' }) });
        expect((await ctx.service.getRecord(r.id)).current.data.tenure).to.equal('freehold');
    });
});

describe('land-records HTTP API', () => {
    it('reading needs record.view; the catalogue any signed-in user; no token, no access', async () => {
        const { app, as, service } = await makeHttp();
        const r = await service.createRecord({ parcel: erf1873() }, actor(users.rec));
        for (const u of [users.rec, users.sup]) {
            expect((await app.inject({ url: '/records', headers: as(u) })).statusCode).to.equal(200);
            expect((await app.inject({ url: `/records/${r.id}`, headers: as(u) })).statusCode).to.equal(200);
        }
        expect((await app.inject({ url: '/records', headers: as(users.scan) })).statusCode).to.equal(403);
        expect((await app.inject({ url: `/records/${r.id}/versions`, headers: as(users.scan) })).statusCode).to.equal(403);
        expect((await app.inject({ url: '/records' })).statusCode).to.equal(401);
        const cat = await app.inject({ url: '/records/catalogue', headers: as(users.scan) });
        expect(cat.statusCode).to.equal(200);
        expect(cat.json().parcelKinds.map(k => k.id)).to.deep.equal(['erf', 'farm_portion', 'sectional_unit']);
    });

    it('lists, gets, versions, verify; validates parameters', async () => {
        const { app, as, service } = await makeHttp();
        const r = await service.createRecord({ parcel: erf1873() }, actor(users.rec));
        const h = { headers: as(users.sup) };
        expect((await app.inject({ url: '/records?q=1873', ...h })).json()).to.deep.include({ total: 1 });
        expect((await app.inject({ url: `/records/${r.id}`, ...h })).json()).to.include({ recordNo: 'LR-NA-2026-000001' });
        expect((await app.inject({ url: `/records/${r.id}/versions/1`, ...h })).json()).to.include({ state: 'draft' });
        expect((await app.inject({ url: `/records/${r.id}/verify`, ...h })).json()).to.include({ intact: true });
        expect((await app.inject({ url: '/records/not-a-uuid', ...h })).statusCode).to.equal(400);
        expect((await app.inject({ url: '/records?status=lost', ...h })).statusCode).to.equal(400);
        expect((await app.inject({ url: `/records/${r.id}/versions/0`, ...h })).statusCode).to.equal(400);
    });
});
