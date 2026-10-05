import { strict as assert } from 'node:assert';
import { buildApp } from '../src/app.js';
import { checksFor, parseExtent, suggestFromDocuments } from '../src/derive.js';
import { SECRET, actor, erf1873, erf1873Data, makeService, users } from './helpers.js';
import { makeWithEdrms } from './helpers.js';

const rec = actor(users.rec);
const byId = (checks) => Object.fromEntries(checks.map(c => [c.id, c]));
const errorsOk = (checks) => checks.filter(c => c.level === 'error').map(c => [c.id, c.ok]);

/** Erf 1873 created from the Deed of Grant, then the other sample documents linked in order. */
async function buildErf1873(ctx, keys = ['t1996', 'sg', 't2008', 't2019']) {
    let r = await ctx.service.createRecord({ edrmsDocumentId: ctx.docs.grant.id }, rec);
    for (const k of keys) r = await ctx.service.addDocument(r.id, { revision: r.draft.revision, edrmsDocumentId: ctx.docs[k].id }, rec);
    return r;
}

describe('editing a draft (API-646)', () => {
    describe('Erf 1873 built from the sample documents', () => {
        it('creates the record from a filed document, reading the parcel from it', async () => {
            const ctx = await makeWithEdrms();
            const r = await ctx.service.createRecord({ edrmsDocumentId: ctx.docs.grant.id }, rec);
            assert.equal(r.label, 'Erf 1873, Klein Windhoek');
            assert.deepEqual(r.draft.data.parcel, { kind: 'erf', number: '1873', township: 'Klein Windhoek', regDiv: 'K' });
            assert.equal(r.draft.data.documents.length, 1);
            assert.equal(r.draft.revision, 2);
            // one record per parcel
            await assert.rejects(ctx.service.createRecord({ parcel: erf1873() }, rec), e => e.statusCode === 409 && e.details.recordId === r.id);
        });

        it('pins each document at its current version and seal, and logs who linked it', async () => {
            const ctx = await makeWithEdrms();
            const r = await buildErf1873(ctx);
            assert.equal(r.draft.data.documents.length, 5);
            const t2019 = r.draft.data.documents.find(d => d.ref === 'T 4521/2019');
            const full = await ctx.edrmsService.getDocument(ctx.docs.t2019.id);
            assert.equal(t2019.version, full.currentVersion);
            assert.equal(t2019.seal, full.versions.at(-1).seal);
            assert.equal(t2019.fields.priorTitle, 'T 2210/2008');
            assert.deepEqual(r.draft.changes.map(c => c.action), ['create', 'link', 'link', 'link', 'link', 'link']);
            assert.ok(r.draft.changes.every(c => c.byId === users.rec.id && c.at));
            assert.equal(ctx.published.filter(e => e.type === 'records.draft.changed').length, 5);
        });

        it('suggests the owners, shares, extent and chain of title', async () => {
            const ctx = await makeWithEdrms();
            const { derived } = (await buildErf1873(ctx)).draft;
            assert.deepEqual(derived.owners.map(o => [o.name, o.idNo, o.share, o.since]), [
                ['Maria Nghishidi', '75060200418', '1/2', 'T 2210/2008'],
                ['Ndapewa Nghishidi', '98030100562', '1/4', 'T 4521/2019'],
                ['Tomas Nghishidi', '01112500379', '1/4', 'T 4521/2019']
            ]);
            assert.deepEqual([derived.extent.value, derived.extent.unit], [1214, 'm2']);
            assert.deepEqual(derived.chain.map(c => c.ref), ['G 88/1978', 'T 1502/1996', 'T 2210/2008', 'T 4521/2019']);
        });

        it('passes 5/5 checks once the officer accepts the suggestions', async () => {
            const ctx = await makeWithEdrms();
            let r = await buildErf1873(ctx);
            r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners', 'extent'], changes: { tenure: 'freehold' } }, rec);
            assert.deepEqual(errorsOk(r.draft.checks), [['shares_sum', true], ['chain_of_title', true], ['extent_vs_sg', true], ['id_numbers', true], ['parcel_match', true]]);
            const c = byId(r.draft.checks);
            assert.equal(c.chain_of_title.message, 'G 88/1978 → T 1502/1996 → T 2210/2008 → T 4521/2019');
            assert.equal(c.documents_current.ok, true);
            assert.equal(c.overrides.ok, true);
            assert.deepEqual(r.draft.changes.at(-1), { at: r.draft.changes.at(-1).at, byId: 'u7', byName: users.rec.name, action: 'edit', fields: ['tenure', 'owners', 'extent'], accepted: ['owners', 'extent'] });
        });

        it('fails the chain of title when a deed in the middle is missing', async () => {
            const ctx = await makeWithEdrms();
            let r = await buildErf1873(ctx);
            r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners', 'extent'] }, rec);
            r = await ctx.service.removeDocument(r.id, ctx.docs.t2008.id, { revision: r.draft.revision }, rec);
            const c = byId(r.draft.checks);
            assert.equal(c.chain_of_title.ok, false);
            assert.equal(c.chain_of_title.message, 'T 4521/2019 cites T 2210/2008, which is not in the record');
            assert.equal(r.draft.changes.at(-1).action, 'unlink');
            assert.equal(r.draft.changes.at(-1).ref, 'T 2210/2008');
        });

        it('fails the ID check for an invalid ID number, which needs a reason and is marked as entered by hand', async () => {
            const ctx = await makeWithEdrms();
            let r = await buildErf1873(ctx);
            r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners', 'extent'] }, rec);
            const owners = r.draft.data.owners.map(o => (o.name === 'Tomas Nghishidi' ? { ...o, idNo: '0111250037' } : o));
            await assert.rejects(ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { owners } }, rec),
                e => e.statusCode === 400 && /reason/.test(e.message) && e.details.byHand[0] === 'owner Tomas Nghishidi');
            r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { owners }, reason: 'ID as on the certified copy' }, rec);
            const c = byId(r.draft.checks);
            assert.equal(c.id_numbers.ok, false);
            assert.match(c.id_numbers.message, /Tomas Nghishidi \(0111250037\)/);
            assert.equal(c.overrides.ok, false);
            assert.match(c.overrides.message, /Entered by hand: owner Tomas Nghishidi/);
            const tomas = r.draft.data.owners.find(o => o.name === 'Tomas Nghishidi');
            assert.deepEqual(tomas.source, { from: 'manual', by: users.rec.name, reason: 'ID as on the certified copy' });
            // the others still come from the documents
            assert.equal(r.draft.data.owners.find(o => o.name === 'Maria Nghishidi').source.from, 'document');
        });

        it('fails the parcel check for a document of another parcel', async () => {
            const ctx = await makeWithEdrms();
            let r = await buildErf1873(ctx, ['olympia']);
            const c = byId(r.draft.checks);
            assert.equal(c.parcel_match.ok, false);
            assert.match(c.parcel_match.message, /T 3329\/2011 \(Erf 3329, Olympia\)/);
            await assert.rejects(ctx.service.addDocument(r.id, { revision: r.draft.revision, edrmsDocumentId: ctx.docs.olympia.id }, rec), e => e.statusCode === 409);
        });
    });

    describe('concurrency and state', () => {
        it('refuses an edit made on an older revision', async () => {
            const ctx = await makeWithEdrms();
            const r = await ctx.service.createRecord({ parcel: erf1873() }, rec);
            const first = await ctx.service.updateDraft(r.id, { revision: 1, changes: { tenure: 'freehold' } }, rec);
            assert.equal(first.draft.revision, 2);
            await assert.rejects(ctx.service.updateDraft(r.id, { revision: 1, changes: { attributes: { zoning: 'Business' } } }, rec),
                e => e.statusCode === 409 && e.details.revision === 2);
            await assert.rejects(ctx.service.addDocument(r.id, { revision: 1, edrmsDocumentId: ctx.docs.sg.id }, rec), e => e.statusCode === 409);
            assert.equal((await ctx.service.getRecord(r.id)).draft.data.attributes, undefined);
        });

        it('refuses edits while the draft is in review', async () => {
            const ctx = await makeWithEdrms();
            const r = await ctx.service.createRecord({ parcel: erf1873() }, rec);
            await ctx.repo.updateRecord(r.id, { draftState: 'in_review' });
            await assert.rejects(ctx.service.updateDraft(r.id, { revision: 1, changes: { tenure: 'freehold' } }, rec), e => e.statusCode === 409 && /in review/.test(e.message));
        });

        it('validates changes: known fields, same parcel kind, schema types, a free parcel', async () => {
            const ctx = await makeWithEdrms();
            const r = await ctx.service.createRecord({ parcel: erf1873() }, rec);
            const edit = (body) => ctx.service.updateDraft(r.id, { revision: 1, ...body }, rec);
            await assert.rejects(edit({ changes: { documents: [] } }), e => e.statusCode === 400 && /Cannot change: documents/.test(e.message));
            await assert.rejects(edit({ changes: { parcel: { kind: 'farm_portion', farmName: 'X', farmNumber: '1', regDiv: 'K' } } }), e => e.statusCode === 400 && /kind cannot change/.test(e.message));
            await assert.rejects(edit({ changes: { tenure: 'rental' } }), e => e.statusCode === 400 && e.details.problems.length > 0);
            await assert.rejects(edit({ accept: ['owners'] }), e => e.statusCode === 400 && /suggest no owners/.test(e.message));
            await assert.rejects(edit({}), e => e.statusCode === 400);
            const other = await ctx.service.createRecord({ parcel: { ...erf1873(), number: '1874' } }, rec);
            await assert.rejects(ctx.service.updateDraft(other.id, { revision: 1, changes: { parcel: erf1873() } }, rec), e => e.statusCode === 409);
            // a parcel correction moves the record's label and key
            const moved = await ctx.service.updateDraft(other.id, { revision: 1, changes: { parcel: { ...erf1873(), number: '1875' } } }, rec);
            assert.equal(moved.label, 'Erf 1875, Klein Windhoek');
        });

        it('reads no parcel from a document without a usable property field', async () => {
            const ctx = await makeWithEdrms();
            await assert.rejects(ctx.service.createRecord({ edrmsDocumentId: ctx.docs.t2019.id }, rec), e => e.statusCode === 400 && /regDiv/.test(e.message));
        });
    });

    describe('comments', () => {
        it('keeps comments with the version open at the time', async () => {
            const { service } = makeService();
            const r = await service.createRecord({ parcel: erf1873() }, rec);
            await service.addComment(r.id, { body: '  Waiting for the SG diagram  ' }, actor(users.sup));
            const { items } = await service.listComments(r.id);
            assert.deepEqual(items.map(c => [c.body, c.authorName, c.versionNumber]), [['Waiting for the SG diagram', users.sup.name, 1]]);
            await assert.rejects(service.addComment(r.id, { body: '   ' }, rec), e => e.statusCode === 400);
        });
    });

    describe('HTTP and permissions', () => {
        async function http() {
            const ctx = await makeWithEdrms();
            const app = await buildApp({ service: ctx.service, jwtSecret: SECRET });
            await app.ready();
            const as = (u) => ({ authorization: `Bearer ${app.jwt.sign({ typ: 'access', sub: u.id, name: u.name, perms: u.perms })}` });
            return { ...ctx, app, as };
        }

        it('creates, links, edits, unlinks and comments with the right permissions', async () => {
            const { app, as, docs } = await http();
            const created = await app.inject({ method: 'POST', url: '/records', headers: as(users.rec), payload: { edrmsDocumentId: docs.grant.id } });
            assert.equal(created.statusCode, 201);
            const id = created.json().id;
            assert.equal(created.json().draft.data.documents.length, 1);

            const link = await app.inject({ method: 'POST', url: `/records/${id}/draft/documents`, headers: as(users.rec), payload: { revision: 2, edrmsDocumentId: docs.t1996.id } });
            assert.equal(link.statusCode, 200);
            assert.equal(link.json().draft.revision, 3);

            const patch = await app.inject({ method: 'PATCH', url: `/records/${id}/draft`, headers: as(users.rec), payload: { revision: 3, accept: ['owners'] } });
            assert.equal(patch.statusCode, 200);
            assert.deepEqual(patch.json().draft.data.owners.map(o => [o.name, o.share]), [['Johannes Shikongo', '1/1']]);
            const stale = await app.inject({ method: 'PATCH', url: `/records/${id}/draft`, headers: as(users.rec), payload: { revision: 3, changes: { tenure: 'freehold' } } });
            assert.equal(stale.statusCode, 409);

            const del = await app.inject({ method: 'DELETE', url: `/records/${id}/draft/documents/${docs.t1996.id}?revision=4`, headers: as(users.rec) });
            assert.equal(del.statusCode, 200);
            assert.equal(del.json().draft.data.documents.length, 1);

            const comment = await app.inject({ method: 'POST', url: `/records/${id}/comments`, headers: as(users.sup), payload: { body: 'Please add the SG diagram' } });
            assert.equal(comment.statusCode, 201);
            const list = await app.inject({ method: 'GET', url: `/records/${id}/comments`, headers: as(users.sup) });
            assert.equal(list.json().items.length, 1);
        });

        it('refuses users without the permission', async () => {
            const { app, as, docs } = await http();
            const id = (await app.inject({ method: 'POST', url: '/records', headers: as(users.rec), payload: { parcel: erf1873() } })).json().id;
            const calls = [
                [users.scan, 'POST', '/records', { parcel: { ...erf1873(), number: '2' } }],
                [users.sup, 'POST', '/records', { parcel: { ...erf1873(), number: '2' } }],
                [users.sup, 'PATCH', `/records/${id}/draft`, { revision: 1, changes: { tenure: 'freehold' } }],
                [users.sup, 'POST', `/records/${id}/draft/documents`, { revision: 1, edrmsDocumentId: docs.sg.id }],
                [users.sup, 'DELETE', `/records/${id}/draft/documents/${docs.sg.id}?revision=1`],
                [users.scan, 'POST', `/records/${id}/comments`, { body: 'hi' }],
                [users.scan, 'GET', `/records/${id}/comments`]
            ];
            for (const [u, method, url, payload] of calls) {
                const res = await app.inject({ method, url, headers: as(u), ...(payload ? { payload } : {}) });
                assert.equal(res.statusCode, 403, `${u.name} ${method} ${url}`);
            }
            // record.link alone may edit the draft
            const linker = { id: 'u9', name: 'Linker', perms: ['record.view', 'record.link'] };
            const ok = await app.inject({ method: 'PATCH', url: `/records/${id}/draft`, headers: as(linker), payload: { revision: 1, changes: { tenure: 'freehold' } } });
            assert.equal(ok.statusCode, 200);
        });

        it('refuses bad bodies', async () => {
            const { app, as } = await http();
            const bad = [
                ['POST', '/records', {}],
                ['PATCH', '/records/00000000-0000-4000-8000-000000000000/draft', { changes: {} }],
                ['PATCH', '/records/00000000-0000-4000-8000-000000000000/draft', { revision: 1, accept: ['documents'] }]
            ];
            for (const [method, url, payload] of bad) assert.equal((await app.inject({ method, url, headers: as(users.rec), payload })).statusCode, 400, `${method} ${url} ${JSON.stringify(payload)}`);
        });
    });

    describe('checks on version data', () => {
        it('checks shares, extent units and a missing SG diagram', () => {
            const data = erf1873Data();
            let c = byId(checksFor({ ...data, owners: data.owners.slice(0, 2) }));
            assert.equal(c.shares_sum.ok, false);
            assert.equal(c.shares_sum.message, 'Shares add up to 3/4, not 1');
            c = byId(checksFor(data));
            assert.equal(c.extent_vs_sg.level, 'warning');
            assert.deepEqual(parseExtent('12,3456 ha'), { value: 12.3456, unit: 'ha' });
            assert.deepEqual(parseExtent('2 500 m²'), { value: 2500, unit: 'm2' });
        });

        it('takes stated shares from the deed', () => {
            const docs = [{ docType: 'deed_of_transfer', ref: 'T 1/2020', edrmsNo: 'E1', fields: { tee1: 'A Person', tee1Id: '80010100123', tee2: 'B Person', tee2Id: '80010100124', share: 'undivided ½ share each' } }];
            const { owners, notes } = suggestFromDocuments(docs);
            assert.deepEqual(owners.map(o => o.share), ['1/2', '1/2']);
            assert.deepEqual(notes, []);
        });
    });
});
