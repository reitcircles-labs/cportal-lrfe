import { strict as assert } from 'node:assert';
import { actor, makeWithReview, users } from './helpers.js';

const rec = actor(users.rec);
const sup = actor(users.sup);

/** Erf 1873 committed as v1 through submit and approval (bpm), every check passing. */
async function committedErf1873(ctx) {
    let r = await ctx.service.createRecord({ edrmsDocumentId: ctx.docs.grant.id }, rec);
    for (const k of ['t1996', 'sg', 't2008', 't2019']) r = await ctx.service.addDocument(r.id, { revision: r.draft.revision, edrmsDocumentId: ctx.docs[k].id }, rec);
    r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners', 'extent'], changes: { tenure: 'freehold', attributes: { zoning: 'Residential' } } }, rec);
    return approve(ctx, r);
}

async function approve(ctx, r) {
    await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
    const [task] = await ctx.inbox(users.sup);
    const res = await ctx.decide(users.sup, task.id, { outcome: 'approved' });
    assert.equal(res.json().instance.outcome, 'committed');
    return ctx.service.getRecord(r.id);
}

/** Correct a field of a filed document in edrms (as an approved amendment would), delivering its event. */
async function amend(ctx, doc, changes, reason = 'Transferee ID as on the original deed') {
    const before = await ctx.edrmsService.getDocument(doc.id);
    return ctx.edrmsService.amendDocument({ id: doc.id, expectedVersion: before.currentVersion, reason, changes, actor: rec, approvedBy: sup });
}

describe('changes to committed records (API-648)', () => {
    it('a second version via a draft and review; the first stays current until approval', async () => {
        const ctx = await makeWithReview();
        let r = await committedErf1873(ctx);
        r = await ctx.service.openDraft(r.id, rec);
        assert.equal(r.currentVersion, 1);
        assert.equal(r.draftVersion, 2);
        assert.deepEqual(r.draft.data, r.current.data);
        assert.equal(r.draftDiff.empty, true);
        assert.deepEqual(r.draft.changes.map(c => [c.action, c.from]), [['open', 1]]);
        await assert.rejects(ctx.service.openDraft(r.id, rec), e => e.statusCode === 409);

        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { encumbrances: [{ type: 'servitude', ref: 'K 120/2021S', inFavourOf: 'City of Windhoek' }] } }, rec);
        assert.deepEqual(r.draftDiff.encumbrances.added.map(e => e.ref), ['K 120/2021S']);
        // still v1 while v2 is drafted and in review
        await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        r = await ctx.service.getRecord(r.id);
        assert.equal(r.currentVersion, 1);
        assert.deepEqual(r.current.data.encumbrances, []);
        assert.equal((await ctx.service.listRecords({ status: 'committed' })).total, 1);

        const [task] = await ctx.inbox(users.sup);
        await ctx.decide(users.sup, task.id, { outcome: 'approved' });
        r = await ctx.service.getRecord(r.id);
        assert.equal(r.currentVersion, 2);
        assert.equal(r.current.data.encumbrances[0].ref, 'K 120/2021S');
        assert.equal(r.draftVersion, null);
    });

    it('a document correction in edrms flags the record; the current version is unchanged', async () => {
        const ctx = await makeWithReview();
        ctx.edrmsService.events.subscribe('edrms.document.amended', e => ctx.service.onDocumentAmended(e.data));
        let r = await committedErf1873(ctx);
        const sealBefore = r.current.seal;
        await amend(ctx, ctx.docs.t2019, [{ k: 'tee2Id', v: '01112500380' }]);

        r = await ctx.service.getRecord(r.id);
        assert.equal(r.needsReview, true);
        assert.equal(r.flags.length, 1);
        assert.equal(r.flags[0].message, `Document updated: ${ctx.docs.t2019.edrmsNo} v1 → v2. Review needed.`);
        assert.equal(r.flags[0].reason, 'Transferee ID as on the original deed');
        assert.equal(r.current.seal, sealBefore);
        assert.equal(r.current.data.documents.find(d => d.ref === 'T 4521/2019').version, 1);
        assert.deepEqual((await ctx.service.listRecords({ status: 'needs_review' })).items.map(x => x.id), [r.id]);
        assert.ok(ctx.published.some(e => e.type === 'records.record.flagged'));

        // the same event again changes nothing; a record without the document is not flagged
        await ctx.service.onDocumentAmended({ documentId: ctx.docs.t2019.id, edrmsNo: ctx.docs.t2019.edrmsNo, version: 2 });
        assert.equal((await ctx.service.getRecord(r.id)).flags.length, 1);
        assert.deepEqual(await ctx.service.onDocumentAmended({ documentId: ctx.docs.olympia.id, version: 2 }), []);
    });

    it('adopting the corrected document is a draft change that needs review; approval clears the flag', async () => {
        const ctx = await makeWithReview();
        ctx.edrmsService.events.subscribe('edrms.document.amended', e => ctx.service.onDocumentAmended(e.data));
        let r = await committedErf1873(ctx);
        await amend(ctx, ctx.docs.t2019, [{ k: 'tee2Id', v: '01112500380' }]);

        r = await ctx.service.openDraft(r.id, rec);
        assert.equal(r.draft.checks.find(c => c.id === 'documents_current').ok, false);
        r = await ctx.service.refreshDocument(r.id, ctx.docs.t2019.id, { revision: r.draft.revision }, rec);
        const pinned = r.draft.data.documents.find(d => d.ref === 'T 4521/2019');
        const full = await ctx.edrmsService.getDocument(ctx.docs.t2019.id);
        assert.equal(pinned.version, 2);
        assert.equal(pinned.seal, full.versions.find(v => v.versionNumber === 2).seal);
        assert.equal(pinned.fields.tee2Id, '01112500380');
        assert.deepEqual(r.draft.changes.at(-1), { ...r.draft.changes.at(-1), action: 'update', fromVersion: 1, toVersion: 2 });
        assert.deepEqual(r.draftDiff.documents.updated.map(d => [d.ref, d.fromVersion, d.version]), [['T 4521/2019', 1, 2]]);
        assert.equal(r.draft.checks.find(c => c.id === 'documents_current').ok, true);
        // the suggestion follows the document; the owners are still as committed until accepted
        assert.equal(r.draft.derived.owners.find(o => o.name === 'Tomas Nghishidi').idNo, '01112500380');
        assert.equal(r.draft.data.owners.find(o => o.name === 'Tomas Nghishidi').idNo, '01112500379');
        assert.equal(r.draft.checks.find(c => c.id === 'overrides').ok, false);
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners'] }, rec);
        assert.deepEqual(r.draftDiff.owners.changed.map(o => [o.name, o.before.idNo, o.after.idNo]), [['Tomas Nghishidi', '01112500379', '01112500380']]);
        await assert.rejects(ctx.service.refreshDocument(r.id, ctx.docs.t2019.id, { revision: r.draft.revision }, rec), e => e.statusCode === 409);

        // still flagged until the reviewed version is committed
        assert.equal((await ctx.service.getRecord(r.id)).needsReview, true);
        r = await approve(ctx, r);
        assert.equal(r.currentVersion, 2);
        assert.equal(r.needsReview, false);
        assert.deepEqual(r.flags, []);
    });

    it('a flag stays when the committed change does not adopt the corrected document', async () => {
        const ctx = await makeWithReview();
        ctx.edrmsService.events.subscribe('edrms.document.amended', e => ctx.service.onDocumentAmended(e.data));
        let r = await committedErf1873(ctx);
        await amend(ctx, ctx.docs.sg, [{ k: 'extent', v: '1 215 square metres' }], 'Extent as on the approved diagram');
        r = await ctx.service.openDraft(r.id, rec);
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'Business' } } }, rec);
        r = await approve(ctx, r);
        assert.equal(r.currentVersion, 2);
        assert.equal(r.flags.length, 1);
        assert.equal(r.flags[0].edrmsNo, ctx.docs.sg.edrmsNo);
    });

    it('history: every committed version with submitter, approver, date, changes, and a verifiable seal chain', async () => {
        const ctx = await makeWithReview();
        let r = await committedErf1873(ctx);
        r = await ctx.service.openDraft(r.id, rec);
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'Business' } } }, rec);
        r = await approve(ctx, r);
        r = await ctx.service.openDraft(r.id, rec);          // an open draft is not history

        const h = await ctx.service.history(r.id);
        assert.equal(h.intact, true);
        assert.deepEqual(h.versions.map(v => [v.versionNumber, v.state, v.current, v.submittedByName, v.approvedByName, v.intact, v.linked]), [
            [2, 'committed', true, users.rec.name, users.sup.name, true, true],
            [1, 'superseded', false, users.rec.name, users.sup.name, true, true]
        ]);
        assert.equal(h.versions[0].previousSeal, h.versions[1].seal);
        assert.deepEqual(h.versions[0].diff.fields, [{ path: 'attributes.zoning', before: 'Residential', after: 'Business' }]);
        assert.equal(h.versions[1].diff.documents.added.length, 5);
        assert.ok(h.versions.every(v => v.committedAt));

        // tampering with v1 breaks its seal and v2's link
        const v1 = await ctx.repo.getVersion(r.id, 1);
        await ctx.repo.updateVersion(r.id, 1, { data: { ...v1.data, tenure: 'leasehold' } });
        const broken = await ctx.service.history(r.id);
        assert.equal(broken.intact, false);
        assert.equal(broken.versions.find(v => v.versionNumber === 1).intact, false);
    });

    it('HTTP: open a draft, adopt a document, read the history, with the right permissions', async () => {
        const ctx = await makeWithReview();
        ctx.edrmsService.events.subscribe('edrms.document.amended', e => ctx.service.onDocumentAmended(e.data));
        const r = await committedErf1873(ctx);
        await amend(ctx, ctx.docs.t2019, [{ k: 'tee2Id', v: '01112500380' }]);
        const call = (u, method, url, payload) => ctx.app.inject({ method, url: `/records/${r.id}${url}`, headers: ctx.as(u), ...(payload ? { payload } : {}) });
        assert.equal((await call(users.sup, 'POST', '/draft')).statusCode, 403);
        const opened = await call(users.rec, 'POST', '/draft');
        assert.equal(opened.statusCode, 201);
        assert.equal((await call(users.rec, 'POST', '/draft')).statusCode, 409);
        const url = `/draft/documents/${ctx.docs.t2019.id}/refresh`;
        assert.equal((await call(users.sup, 'POST', url, { revision: 1 })).statusCode, 403);
        const refreshed = await call(users.rec, 'POST', url, { revision: 1 });
        assert.equal(refreshed.statusCode, 200);
        assert.equal(refreshed.json().draft.revision, 2);
        const h = await call(users.sup, 'GET', '/history');
        assert.equal(h.statusCode, 200);
        assert.equal(h.json().versions.length, 1);
        assert.equal((await call(users.scan, 'GET', '/history')).statusCode, 403);
    });
});
