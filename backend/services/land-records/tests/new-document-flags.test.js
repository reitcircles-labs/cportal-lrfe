import {expect} from 'chai';
import {makeWithEdrms, actor, users, erf1873, SECRET} from './helpers.js';
import {buildApp} from '../src/app.js';
import {deedMeta, pdfFile} from '../../edrms/tests/helpers.js';

/** The `edrms.document.filed` event of a filed document, as edrms publishes it. */
const filedEvent = doc => ({
  documentId: doc.id,
  edrmsNo: doc.edrmsNo,
  docType: doc.docType,
  instrumentRef: doc.instrumentRef,
  props: doc.props,
});

describe('a new document filed for a parcel flags its land record (API-766)', () => {
  let ctx;
  let record;
  let other;
  let n = 0;
  const file = async fields =>
    (
      await ctx.edrmsService.fileDocument({
        meta: deedMeta({
          sourceId: `new-${++n}`,
          fields: Object.entries(fields).map(([k, v]) => ({k, label: k, v})),
        }),
        file: pdfFile(Buffer.from(`%PDF-1.7 new-${n}`)),
      })
    ).document;
  const flagsOf = async id => (await ctx.repo.getRecord(id)).flags;

  before(async () => {
    ctx = await makeWithEdrms();
    record = await ctx.service.createRecord(
      {parcel: erf1873()},
      actor(users.rec),
    );
    const v = await ctx.repo.getVersion(record.id, 1);
    await ctx.repo.updateVersion(record.id, 1, {
      data: {...v.data, documents: [await ctx.pin(ctx.docs.t2008)]},
    });
    other = await ctx.service.createRecord(
      {parcel: {...erf1873(), number: '1874'}},
      actor(users.rec),
    );
  });

  it('by its property: the record of that parcel, not the one with the next erf number', async () => {
    const deed = await file({
      deedNo: 'T 7001/2026',
      property: 'Erf 1873, Klein Windhoek',
      regDiv: 'K',
    });
    expect(await ctx.service.onDocumentFiled(filedEvent(deed))).to.deep.equal([
      record.id,
    ]);
    const [flag] = await flagsOf(record.id);
    expect(flag).to.include({
      type: 'document_filed',
      edrmsDocumentId: deed.id,
      edrmsNo: deed.edrmsNo,
      ref: 'T 7001/2026',
      docType: 'deed_of_transfer',
      matchedBy: 'property',
      message:
        'New document for this parcel: T 7001/2026. Open a change to add it.',
    });
    expect(await flagsOf(other.id)).to.deep.equal([]);

    // the list: a new document, not "needs review"; the filter finds it
    const summary = await ctx.service.getRecord(record.id);
    expect(summary).to.include({newDocuments: 1, needsReview: false});
    const listed = await ctx.service.listRecords({status: 'new_document'});
    expect(listed.items.map(r => r.id)).to.deep.equal([record.id]);
    expect(
      (await ctx.service.listRecords({status: 'needs_review'})).items,
    ).to.deep.equal([]);

    // the same event again: one flag
    expect(await ctx.service.onDocumentFiled(filedEvent(deed))).to.deep.equal(
      [],
    );
    expect(await flagsOf(record.id)).to.have.length(1);
  });

  it('as the next link in the chain: it names a title deed of the record as its prior title', async () => {
    const deed = await file({
      deedNo: 'T 7002/2026',
      property: 'Remainder of the property held under T 2210/2008',
      priorTitle: 'T 2210/2008',
    });
    expect(await ctx.service.onDocumentFiled(filedEvent(deed))).to.deep.equal([
      record.id,
    ]);
    const flag = (await flagsOf(record.id)).find(
      f => f.edrmsDocumentId === deed.id,
    );
    expect(flag.matchedBy).to.equal('chain');
  });

  it('no flag for a record that already holds the document, or a document about another parcel', async () => {
    expect(
      await ctx.service.onDocumentFiled(filedEvent(ctx.docs.t2008)),
    ).to.deep.equal([]);
    const elsewhere = await file({
      deedNo: 'T 7003/2026',
      property: 'Erf 3329, Olympia',
    });
    expect(
      await ctx.service.onDocumentFiled(filedEvent(elsewhere)),
    ).to.deep.equal([]);
  });

  it('the flag ends when its document is added to the draft', async () => {
    const deed = await file({
      deedNo: 'T 7004/2026',
      property: 'Erf 1874, Klein Windhoek',
    });
    await ctx.service.onDocumentFiled(filedEvent(deed));
    expect((await flagsOf(other.id)).map(f => f.edrmsDocumentId)).to.deep.equal(
      [deed.id],
    );
    const fresh = await ctx.service.getRecord(other.id);
    const added = await ctx.service.addDocument(
      other.id,
      {revision: fresh.draft.revision, edrmsDocumentId: deed.id},
      actor(users.rec),
    );
    expect(added.flags).to.deep.equal([]);
    expect(added.newDocuments).to.equal(0);
    const log = (await ctx.repo.getRecord(other.id)).flagLog;
    expect(log).to.have.length(1);
    expect(log[0]).to.include({
      outcome: 'added',
      versionNumber: 1,
      byId: users.rec.id,
    });

    // taken out of the draft again: the flag comes back, so it is not lost without a reason
    const removed = await ctx.service.removeDocument(
      other.id,
      deed.id,
      {revision: added.draft.revision},
      actor(users.rec),
    );
    expect(removed.flags.map(f => f.edrmsDocumentId)).to.deep.equal([deed.id]);
    expect((await ctx.repo.getRecord(other.id)).flagLog).to.deep.equal([]);
  });

  it('dismissed with a reason: kept in the flag log, and the document does not flag the record again', async () => {
    const deed = await file({
      deedNo: 'T 7005/2026',
      property: 'Erf 1873, Klein Windhoek',
    });
    await ctx.service.onDocumentFiled(filedEvent(deed));
    const dismiss = reason =>
      ctx.service.dismissFlag(
        record.id,
        {edrmsDocumentId: deed.id, reason},
        actor(users.rec),
      );
    await dismiss('  ').then(
      () => expect.fail('a reason is needed'),
      e => expect(e.statusCode).to.equal(400),
    );
    const r = await dismiss('A copy of T 7001/2026, filed twice');
    expect(r.flags.some(f => f.edrmsDocumentId === deed.id)).to.equal(false);
    const h = await ctx.service.history(record.id);
    expect(h.flagLog).to.have.length(1);
    expect(h.flagLog[0]).to.include({
      outcome: 'dismissed',
      dismissedById: users.rec.id,
      dismissedByName: users.rec.name,
      reason: 'A copy of T 7001/2026, filed twice',
    });
    expect(h.flagLog[0].flag).to.include({edrmsDocumentId: deed.id});
    expect(await ctx.service.onDocumentFiled(filedEvent(deed))).to.deep.equal(
      [],
    );
    await dismiss('again').then(
      () => expect.fail('no such flag any more'),
      e => expect(e.statusCode).to.equal(404),
    );
  });

  it('over HTTP: dismissing needs record.link and a reason; the list filters by new document', async () => {
    const deed = await file({
      deedNo: 'T 7006/2026',
      property: 'Erf 1873, Klein Windhoek',
    });
    await ctx.service.onDocumentFiled(filedEvent(deed));
    const app = await buildApp({service: ctx.service, jwtSecret: SECRET});
    await app.ready();
    const as = u => ({
      authorization: `Bearer ${app.jwt.sign({typ: 'access', sub: u.id, name: u.name, perms: u.perms})}`,
    });
    const dismiss = (u, payload) =>
      app.inject({
        method: 'POST',
        url: `/records/${record.id}/flags/dismiss`,
        headers: as(u),
        payload,
      });
    expect(
      (
        await app.inject({
          url: '/records?status=new_document',
          headers: as(users.sup),
        })
      )
        .json()
        .items.map(r => r.id),
    ).to.include(record.id);
    expect(
      (await dismiss(users.sup, {edrmsDocumentId: deed.id, reason: 'x'}))
        .statusCode,
    ).to.equal(403);
    expect(
      (await dismiss(users.rec, {edrmsDocumentId: deed.id})).statusCode,
    ).to.equal(400);
    const ok = await dismiss(users.rec, {
      edrmsDocumentId: deed.id,
      reason: 'Not this parcel',
    });
    expect(ok.statusCode).to.equal(200);
    expect(ok.json().flags.some(f => f.edrmsDocumentId === deed.id)).to.equal(
      false,
    );
  });
});
