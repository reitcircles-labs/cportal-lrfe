import { strict as assert } from 'node:assert';
import { actor, makeWithEdrms, makeWithReview, openDraft, users } from './helpers.js';

const rec = actor(users.rec);
const sup = actor(users.sup);

/** Erf 1873 from the five sample documents, suggestions accepted: every check passes. */
async function readyDraft(ctx, keys = ['t1996', 'sg', 't2008', 't2019']) {
    let r = await ctx.service.createRecord({ edrmsDocumentId: ctx.docs.grant.id }, rec);
    for (const k of keys) r = await ctx.service.addDocument(r.id, { revision: r.draft.revision, edrmsDocumentId: ctx.docs[k].id }, rec);
    return ctx.service.updateDraft(r.id, { revision: r.draft.revision, accept: ['owners', 'extent'], changes: { tenure: 'freehold', attributes: { zoning: 'Residential' } } }, rec);
}

describe('review and commit (API-647)', () => {
    it('submit → a second person approves in the task inbox → v1 committed, sealed and current', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        assert.equal(r.draftState, 'in_review');
        assert.equal(r.draft.state, 'in_review');
        assert.equal(r.draft.submittedById, users.rec.id);
        assert.ok(r.draft.reviewInstanceId);
        assert.ok(ctx.published.some(e => e.type === 'records.draft.submitted'));

        // frozen while in review
        await assert.rejects(ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { tenure: 'leasehold' } }, rec), e => e.statusCode === 409);

        // the task: in the approver's inbox, not the submitter's (who also holds record.finalize)
        assert.deepEqual(await ctx.inbox(users.rec), []);
        const [task] = await ctx.inbox(users.sup);
        assert.equal(task.title, `Approve land record ${r.recordNo} (Erf 1873, Klein Windhoek) version 1`);
        const own = await ctx.decide(users.rec, task.id, { outcome: 'approved' });
        assert.equal(own.statusCode, 403);
        assert.match(own.json().message, /four-eyes/);

        const done = await ctx.decide(users.sup, task.id, { outcome: 'approved', comment: 'Chain and shares checked' });
        assert.equal(done.statusCode, 200);
        assert.equal(done.json().instance.status, 'completed');
        assert.equal(done.json().instance.outcome, 'committed');

        r = await ctx.service.getRecord(r.id);
        assert.equal(r.status, 'committed');
        assert.equal(r.currentVersion, 1);
        assert.equal(r.draft, null);
        assert.equal(r.current.state, 'committed');
        assert.equal(r.current.approvedById, users.sup.id);
        assert.equal(r.current.submittedById, users.rec.id);
        assert.match(r.current.seal, /^[0-9a-f]{64}$/);
        assert.equal(r.current.previousSeal, null);
        assert.deepEqual(r.current.changes.slice(-2).map(c => [c.action, c.byId]), [['submit', 'u7'], ['commit', 'u1']]);
        const v = await ctx.service.verify(r.id);
        assert.equal(v.intact, true);
        const committed = ctx.published.find(e => e.type === 'records.record.committed');
        assert.equal(committed.data.seal, r.current.seal);
        assert.equal(committed.data.approvedBy.id, users.sup.id);
    });

    it('reject needs a comment; the draft returns with it, is edited and resubmitted, then approved', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        let [task] = await ctx.inbox(users.sup);
        assert.equal((await ctx.decide(users.sup, task.id, { outcome: 'rejected' })).statusCode, 400);
        const rejected = await ctx.decide(users.sup, task.id, { outcome: 'rejected', comment: 'Zoning is General Residential 1' });
        assert.equal(rejected.json().instance.outcome, 'rejected');

        r = await ctx.service.getRecord(r.id);
        assert.equal(r.draftState, 'draft');
        assert.equal(r.draft.state, 'draft');
        assert.equal(r.draft.reviewComment, 'Zoning is General Residential 1');
        assert.equal(r.draft.reviewInstanceId, null);
        assert.equal(r.draft.changes.at(-1).action, 'reject');
        assert.ok(ctx.published.some(e => e.type === 'records.draft.rejected' && e.data.comment === 'Zoning is General Residential 1'));

        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'General Residential 1' } } }, rec);
        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        assert.equal(r.draft.reviewComment, null);
        [task] = await ctx.inbox(users.sup);
        await ctx.decide(users.sup, task.id, { outcome: 'approved' });
        r = await ctx.service.getRecord(r.id);
        assert.equal(r.current.data.attributes.zoning, 'General Residential 1');
        assert.equal(r.status, 'committed');
    });

    it('a failing check or incomplete data blocks submitting, with the list', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx, ['t1996', 'sg', 't2019']);              // T 2210/2008 missing
        await assert.rejects(ctx.service.submit(r.id, { revision: r.draft.revision }, rec), e =>
            e.statusCode === 400 && e.details.failing.some(c => c.id === 'chain_of_title') && /T 4521\/2019 cites T 2210\/2008/.test(e.message));
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { tenure: null } }, rec);
        await assert.rejects(ctx.service.submit(r.id, { revision: r.draft.revision }, rec), e => e.statusCode === 400 && e.details.problems.some(p => /tenure/.test(p)));
        assert.equal((await ctx.service.getRecord(r.id)).draftState, 'draft');
        assert.deepEqual(await ctx.inbox(users.sup), []);
    });

    it('withdraw by the submitter removes the task; nobody else can withdraw', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        const instanceId = r.draft.reviewInstanceId;
        await assert.rejects(ctx.service.withdraw(r.id, sup), e => e.statusCode === 403);
        r = await ctx.service.withdraw(r.id, rec);
        assert.equal(r.draftState, 'draft');
        assert.equal(r.draft.state, 'draft');
        assert.equal(r.draft.changes.at(-1).action, 'withdraw');
        assert.deepEqual(await ctx.inbox(users.sup), []);
        assert.equal((await ctx.engine.repo.getInstance(instanceId)).status, 'cancelled');
        await assert.rejects(ctx.service.withdraw(r.id, rec), e => e.statusCode === 409);
        // editable again
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'Business' } } }, rec);
        assert.equal(r.draft.data.attributes.zoning, 'Business');
    });

    it('a change to a committed record: the reviewer sees the difference; v2 supersedes v1 and chains to it', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        await ctx.decide(users.sup, (await ctx.inbox(users.sup))[0].id, { outcome: 'approved' });

        // a new draft is a copy of v1: nothing differs yet
        await openDraft(ctx, r.id);
        r = await ctx.service.getRecord(r.id);
        let review = await ctx.service.review(r.id);
        assert.equal(review.diff.empty, true);

        r = await ctx.service.removeDocument(r.id, ctx.docs.grant.id, { revision: r.draft.revision }, rec);
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'Business' } } }, rec);
        review = await ctx.service.review(r.id);
        assert.deepEqual(review.diff.fields, [{ path: 'attributes.zoning', before: 'Residential', after: 'Business' }]);
        assert.deepEqual(review.diff.documents.removed.map(d => d.ref), ['G 88/1978']);
        assert.deepEqual(review.diff.owners, { added: [], removed: [], changed: [] });
        assert.deepEqual(review.blocking, []);
        assert.equal(review.currentVersion.versionNumber, 1);

        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        await ctx.decide(users.sup, (await ctx.inbox(users.sup))[0].id, { outcome: 'approved' });
        r = await ctx.service.getRecord(r.id);
        assert.equal(r.currentVersion, 2);
        const versions = await ctx.service.listVersions(r.id);
        assert.deepEqual(versions.map(v => v.state), ['superseded', 'committed']);
        assert.equal(r.current.previousSeal, versions[0].seal);
        const v = await ctx.service.verify(r.id);
        assert.equal(v.intact, true);
        assert.deepEqual(v.versions.map(x => [x.intact, x.linked]), [[true, true], [true, true]]);
    });

    it('the reviewer sees overrides and, for a first version, every document as added', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        const owners = r.draft.data.owners.map(o => (o.name === 'Maria Nghishidi' ? { ...o, idNo: '75060200419' } : o));
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { owners }, reason: 'ID from the Home Affairs check' }, rec);
        const review = await ctx.service.review(r.id);
        assert.deepEqual(review.overrides, [{ what: 'owner Maria Nghishidi', by: users.rec.name, reason: 'ID from the Home Affairs check' }]);
        assert.equal(review.diff.documents.added.length, 5);
        assert.equal(review.diff.owners.added.length, 3);
        assert.equal(review.currentVersion, null);
    });

    it('if the review cannot start, the draft stays editable', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        ctx.service.bpm = { startReview: async () => { throw Object.assign(new Error('The review process cannot be reached'), { statusCode: 503 }); } };
        await assert.rejects(ctx.service.submit(r.id, { revision: r.draft.revision }, rec), e => e.statusCode === 503);
        r = await ctx.service.getRecord(r.id);
        assert.equal(r.draftState, 'draft');
        assert.equal(r.draft.state, 'draft');
        r = await ctx.service.updateDraft(r.id, { revision: r.draft.revision, changes: { attributes: { zoning: 'Business' } } }, rec);
        assert.equal(r.draft.state, 'draft');
    });

    it('decisions are only accepted from bpm, never from the submitter, and repeats are harmless', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        r = await ctx.service.submit(r.id, { revision: r.draft.revision }, rec);
        const url = `/records/${r.id}/versions/1/commit`;
        const { signServiceToken } = await import('@lrfe/common');
        const svc = (name) => ({ authorization: `Bearer ${signServiceToken(ctx.app, name)}` });
        assert.equal((await ctx.app.inject({ method: 'POST', url, headers: ctx.as(users.sup), payload: { by: sup } })).statusCode, 401);
        assert.equal((await ctx.app.inject({ method: 'POST', url, headers: svc('intake'), payload: { by: sup } })).statusCode, 403);
        assert.equal((await ctx.app.inject({ method: 'POST', url, headers: svc('bpm'), payload: { by: rec } })).statusCode, 403);
        assert.equal((await ctx.app.inject({ method: 'POST', url, headers: svc('bpm'), payload: { by: sup } })).statusCode, 200);
        const again = await ctx.app.inject({ method: 'POST', url, headers: svc('bpm'), payload: { by: sup } });
        assert.equal(again.statusCode, 200);
        assert.equal(again.json().currentVersion, 1);
        assert.equal((await ctx.app.inject({ method: 'POST', url: `/records/${r.id}/versions/1/reject`, headers: svc('bpm'), payload: { by: sup, comment: 'late' } })).statusCode, 409);
    });

    it('HTTP: submit and withdraw need record.link; review needs record.view', async () => {
        const ctx = await makeWithReview();
        let r = await readyDraft(ctx);
        const post = (u, path, payload) => ctx.app.inject({ method: 'POST', url: `/records/${r.id}${path}`, headers: ctx.as(u), ...(payload ? { payload } : {}) });
        assert.equal((await post(users.sup, '/draft/submit', { revision: r.draft.revision })).statusCode, 403);
        const ok = await post(users.rec, '/draft/submit', { revision: r.draft.revision });
        assert.equal(ok.statusCode, 200);
        assert.equal((await ctx.app.inject({ url: `/records/${r.id}/review`, headers: ctx.as(users.sup) })).statusCode, 200);
        assert.equal((await ctx.app.inject({ url: `/records/${r.id}/review`, headers: ctx.as(users.scan) })).statusCode, 403);
        assert.equal((await post(users.sup, '/draft/withdraw')).statusCode, 403);
        assert.equal((await post(users.rec, '/draft/withdraw')).statusCode, 200);
    });

    it('without bpm configured, submitting says so and changes nothing', async () => {
        const ctx = await makeWithEdrms();
        const r = await readyDraft(ctx);
        await assert.rejects(ctx.service.submit(r.id, { revision: r.draft.revision }, rec), e => e.statusCode === 503);
        assert.equal((await ctx.service.getRecord(r.id)).draftState, 'draft');
    });
});
