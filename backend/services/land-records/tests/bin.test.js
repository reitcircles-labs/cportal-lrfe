import {expect} from 'chai';
import {
  makeWithEdrms,
  actor,
  users,
  erf1873,
  erf1873Data,
  commitVersion,
  SECRET,
} from './helpers.js';
import {buildApp} from '../src/app.js';

const rec = actor(users.rec);
const refused = (promise, status) =>
  promise.then(
    () => expect.fail(`expected ${status}`),
    e => expect(e.statusCode).to.equal(status),
  );

describe('the bin: records never approved, and abandoned changes (API-767)', () => {
  let ctx;
  before(async () => {
    ctx = await makeWithEdrms();
  });

  it('a record never approved goes to the bin with a reason: out of the lists, parcel and documents free', async () => {
    const r = await ctx.service.createRecord(
      {edrmsDocumentId: ctx.docs.grant.id},
      rec,
    );
    await refused(ctx.service.moveToBin(r.id, {reason: ' '}, rec), 400);
    const binned = await ctx.service.moveToBin(
      r.id,
      {reason: 'Township read wrongly: recreated'},
      rec,
    );
    expect(binned).to.include({inBin: true, recordNo: r.recordNo});

    // out of the lists, in the bin's own
    expect(
      (await ctx.service.listRecords()).items.map(x => x.id),
    ).not.to.include(r.id);
    expect(
      (await ctx.service.listRecords({status: 'in_bin'})).items.map(x => x.id),
    ).to.deep.equal([r.id]);
    // its documents are free again
    const found = await ctx.service.searchDocuments({q: 'G 88/1978'});
    expect(found.items[0].linkedTo).to.deep.equal([]);
    // it cannot be changed while in the bin
    await refused(
      ctx.service.updateDraft(
        r.id,
        {revision: binned.draft.revision, changes: {tenure: 'freehold'}},
        rec,
      ),
      409,
    );
    // the history keeps who, when and why
    const h = await ctx.service.history(r.id);
    expect(h.binLog).to.have.length(1);
    expect(h.binLog[0]).to.include({
      action: 'discarded',
      reason: 'Township read wrongly: recreated',
      byId: users.rec.id,
    });

    // restored as it was while the parcel is free
    const back = await ctx.service.restoreFromBin(r.id, rec);
    expect(back).to.include({inBin: false, parcelKey: r.parcelKey});
    expect((await ctx.service.listRecords()).items.map(x => x.id)).to.include(
      r.id,
    );
    expect(
      (await ctx.service.history(r.id)).binLog.map(e => e.action),
    ).to.deep.equal(['discarded', 'restored']);
    await refused(ctx.service.restoreFromBin(r.id, rec), 409);
  });

  it('a new record for the parcel while one is in the bin: allowed, and the old one can no longer be restored', async () => {
    const parcel = {...erf1873(), number: '1990'};
    const old = await ctx.service.createRecord({parcel}, rec);
    await ctx.service.moveToBin(old.id, {reason: 'Created twice'}, rec);
    const fresh = await ctx.service.createRecord({parcel}, rec);
    expect(fresh.parcelKey).to.equal(old.parcelKey);
    const err = await ctx.service.restoreFromBin(old.id, rec).then(
      () => expect.fail('restore must be refused'),
      e => e,
    );
    expect(err.statusCode).to.equal(409);
    expect(err.details).to.include({
      recordId: fresh.id,
      recordNo: fresh.recordNo,
    });
    expect(err.message).to.contain(fresh.recordNo);
  });

  it('an approved record never goes to the bin; a draft in review must be withdrawn first', async () => {
    const r = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1991'}},
      rec,
    );
    await commitVersion(
      ctx,
      r.id,
      1,
      erf1873Data({parcel: r.draft.data.parcel}),
    );
    await refused(ctx.service.moveToBin(r.id, {reason: 'x'}, rec), 409);
    const inReview = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1992'}},
      rec,
    );
    await ctx.repo.updateRecord(inReview.id, {draftState: 'in_review'});
    await refused(ctx.service.moveToBin(inReview.id, {reason: 'x'}, rec), 409);
  });

  it('an abandoned change of an approved record is discarded: the current version stays, the draft is kept in the log', async () => {
    const r = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1993'}},
      rec,
    );
    await commitVersion(
      ctx,
      r.id,
      1,
      erf1873Data({parcel: r.draft.data.parcel}),
    );
    const open = await ctx.service.openDraft(r.id, rec);
    await ctx.service.updateDraft(
      r.id,
      {revision: open.draft.revision, changes: {tenure: 'leasehold'}},
      rec,
    );
    await refused(ctx.service.discardDraft(r.id, {reason: ''}, rec), 400);
    await refused(ctx.service.moveToBin(r.id, {reason: 'x'}, rec), 409);
    const after = await ctx.service.discardDraft(
      r.id,
      {reason: 'The sale fell through'},
      rec,
    );
    expect(after).to.include({currentVersion: 1, draftVersion: null});
    expect(after.draft).to.equal(null);
    expect(
      (await ctx.service.listVersions(r.id)).map(v => v.versionNumber),
    ).to.deep.equal([1]);
    const [entry] = (await ctx.service.history(r.id)).binLog;
    expect(entry).to.include({
      action: 'draft_discarded',
      versionNumber: 2,
      reason: 'The sale fell through',
    });
    expect(entry.diff.fields).to.deep.include({
      path: 'tenure',
      before: 'freehold',
      after: 'leasehold',
    });
    expect(entry.changes.map(c => c.action)).to.deep.equal(['open', 'edit']);
    // a new change can be opened again
    const again = await ctx.service.openDraft(r.id, rec);
    expect(again.draftVersion).to.equal(2);
    // and nothing to discard without a draft, or on a record never approved
    const never = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1994'}},
      rec,
    );
    await refused(ctx.service.discardDraft(never.id, {reason: 'x'}, rec), 409);
  });

  it('a discarded change that had changed the parcel: the record takes the current parcel back', async () => {
    const r = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1996'}},
      rec,
    );
    await commitVersion(
      ctx,
      r.id,
      1,
      erf1873Data({parcel: r.draft.data.parcel}),
    );
    const open = await ctx.service.openDraft(r.id, rec);
    const moved = await ctx.service.updateDraft(
      r.id,
      {
        revision: open.draft.revision,
        changes: {parcel: {...r.draft.data.parcel, number: '1997'}},
      },
      rec,
    );
    expect(moved.label).to.equal('Erf 1997, Klein Windhoek');
    const after = await ctx.service.discardDraft(
      r.id,
      {reason: 'Wrong erf'},
      rec,
    );
    expect(after).to.include({
      label: 'Erf 1996, Klein Windhoek',
      parcelKey: r.parcelKey,
    });
    // the current parcel is reserved again, the abandoned one free
    await refused(
      ctx.service.createRecord({parcel: {...erf1873(), number: '1996'}}, rec),
      409,
    );
    const free = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1997'}},
      rec,
    );
    expect(free.label).to.equal('Erf 1997, Klein Windhoek');
  });

  it('a record in the bin takes no comments and cannot be approved', async () => {
    const r = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1998'}},
      rec,
    );
    await ctx.service.moveToBin(r.id, {reason: 'Test'}, rec);
    await refused(ctx.service.addComment(r.id, {body: 'hello'}, rec), 409);
    await refused(ctx.service.requireInReview(r.id, 1), 409);
  });

  it('over HTTP: record.create for all three; the bin list', async () => {
    const r = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1995'}},
      rec,
    );
    const app = await buildApp({service: ctx.service, jwtSecret: SECRET});
    await app.ready();
    const as = u => ({
      authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: u.id, name: u.name, perms: u.perms})}`,
    });
    const post = (u, url, payload) =>
      app.inject({method: 'POST', url, headers: as(u), payload});
    expect(
      (await post(users.sup, `/records/${r.id}/bin`, {reason: 'x'})).statusCode,
    ).to.equal(403);
    expect(
      (await post(users.rec, `/records/${r.id}/bin`, {})).statusCode,
    ).to.equal(400);
    expect(
      (await post(users.rec, `/records/${r.id}/bin`, {reason: 'Test record'}))
        .statusCode,
    ).to.equal(200);
    const bin = await app.inject({
      url: '/records?status=in_bin',
      headers: as(users.sup),
    });
    expect(bin.json().items.map(x => x.id)).to.include(r.id);
    expect(
      (await post(users.sup, `/records/${r.id}/restore`)).statusCode,
    ).to.equal(403);
    expect(
      (await post(users.rec, `/records/${r.id}/restore`)).statusCode,
    ).to.equal(200);
    expect(
      (await post(users.sup, `/records/${r.id}/draft/discard`, {reason: 'x'}))
        .statusCode,
    ).to.equal(403);
  });
});
