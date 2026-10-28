import {expect} from 'chai';
import {createServiceTokenSigner} from '@lrfe/common';
import {createFakeKeyring} from '@lrfe/storage';
import {
  SECRET,
  makeIntake,
  makeHttp,
  answer,
  actor,
  users,
  pdf,
} from './helpers.js';

// Clearing intake's copy of a filed document (API-807): once the EDRMS holds it completely, intake
// keeps no fields, notes, page text, model answers or scan of it; everything of the reading that
// goes is first filed with version 1.0's provenance.

const PAGES = [
  {page: 1, text: 'DEED OF TRANSFER No. T 2210/2008 · Erf 1873 Klein Windhoek'},
  {page: 2, text: 'Signed before me, Registrar of Deeds'},
];
const withPages = () => answer({pages: structuredClone(PAGES)});
const intakeKeys = () => createFakeKeyring({keyName: 'intake-files'});

/** Accept every field and file the document; returns the intake summary. */
async function reviewAndFile(service, id) {
  const d = await service.acceptClean(id, actor(users.rev));
  for (const f of d.fields.filter(x => x.status === 'pending')) {
    await service.updateField(id, f.k, {status: 'accepted'}, actor(users.rev));
  }
  return service.fileDocument(id, actor(users.rev));
}

/** A logger that keeps what it was given. */
function makeLogger() {
  const lines = [];
  return {lines, warn: (obj, msg) => lines.push({obj, msg})};
}

/** The filing's version 1.0 in the EDRMS. */
const versionOne = (ctx, filed) =>
  ctx.edrmsService.getVersion(filed.filedDocumentId, 1);

describe('clearing filed documents (API-807)', () => {
  it("the provenance carries the filed reading's evidence and checks, and the earlier readings", async () => {
    const ctx = await makeIntake({
      respond: withPages,
      escalation: () => answer({pages: []}),
    });
    const doc = await ctx.captureAndExtract(pdf('read twice'));
    await ctx.service.requestExtraction(
      doc.id,
      {escalate: true},
      actor(users.rev),
    );
    await ctx.worker.drain();
    const read = await ctx.service.getDocument(doc.id);
    const filed = await reviewAndFile(ctx.service, doc.id);
    const {provenance} = await versionOne(ctx, filed);

    // as before
    expect(provenance).to.include({intakeDocumentId: doc.id, escalated: true});
    expect(provenance.extracted.deedNo).to.equal('T 2210/2008');
    // the filed reading: per field its page, evidence, legibility and check messages; its notes
    const deedNo = read.fields.find(f => f.k === 'deedNo');
    expect(provenance.reading.fields.deedNo).to.deep.equal({
      page: deedNo.evidence.page,
      evidence: deedNo.evidence.text,
      legible: true,
      checks: deedNo.checks.map(c => c.message),
    });
    expect(Object.keys(provenance.reading.fields)).to.have.members(
      read.fields.map(f => f.k),
    );
    expect(provenance.reading.notes).to.deep.equal(read.notes);
    // the other readings: the first one and the escalation's (the cross-check is never one)
    expect(provenance.earlier.map(e => e.role)).to.deep.equal([
      'primary',
      'escalation',
    ]);
    const first = provenance.earlier[0];
    expect(first).to.include({
      provider: 'mock',
      model: 'gemini-3.1-flash-lite',
    });
    expect(first).to.have.property('promptVersion');
    expect(first).to.have.property('createdAt');
    expect(first.fields.deedNo).to.include({
      value: 'T 2210/2008',
      legible: true,
    });
    expect(first.fields.deedNo.page).to.be.a('number');
    expect(first.fields.deedNo.evidence).to.contain('T 2210/2008');
  });

  it('right after filing, intake clears its copy: the EDRMS keeps everything', async () => {
    const ctx = await makeIntake({keyring: intakeKeys(), respond: withPages});
    const doc = await ctx.captureAndExtract(pdf('to clear'));
    const before = await ctx.repo.getDocument(doc.id);
    expect(before.encryption).to.not.equal(undefined);
    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(filed).to.include({status: 'filed', cleared: true});

    const after = await ctx.repo.getDocument(doc.id);
    expect(after).to.include({
      status: 'filed',
      transcription: null,
      encryption: null,
      fileKey: before.fileKey,
      sha256: before.sha256,
      edrmsNo: filed.edrmsNo,
    });
    expect(after.fields).to.deep.equal([]);
    expect(after.notes).to.deep.equal([]);
    // the model calls keep their cost, not their answers
    const calls = await ctx.repo.listExtractions(doc.id);
    expect(calls).to.have.length.above(0);
    for (const e of calls) {
      expect(e.answer).to.equal(null);
      expect(e).to.have.property('costUsd');
      expect(e).to.include({provider: 'mock'});
    }
    // the scan and the page text file are gone from intake's store
    expect(ctx.plainStore.blobs.has(before.fileKey)).to.equal(false);
    expect(ctx.plainStore.blobs.has(before.transcription.key)).to.equal(false);
    // the history stays
    const events = (await ctx.service.listEvents(doc.id)).map(e => e.action);
    expect(events).to.include.members(['captured', 'extracted', 'filed']);
    // the EDRMS has the scan, its page text and the reading
    const v1 = await versionOne(ctx, filed);
    expect(v1.sha256).to.equal(before.sha256);
    expect(
      await ctx.edrmsService.readText(filed.filedDocumentId),
    ).to.deep.equal(PAGES);
    expect(v1.provenance.reading.fields).to.have.property('deedNo');
    // the review screen still opens it, without the cleared parts
    const shown = await ctx.service.getDocument(doc.id);
    expect(shown).to.include({cleared: true});
    expect(shown.fields).to.deep.equal([]);
    expect(shown.transcription).to.deep.equal([]);
  });

  it("the Filed list keeps a cleared document's reference, property and counts, and finds it by them (API-815)", async () => {
    const ctx = await makeIntake({respond: withPages});
    const doc = await ctx.captureAndExtract(pdf('kept in the list'));
    const read = ctx.service.summary(await ctx.repo.getDocument(doc.id));
    expect(read.ref).to.be.a('string').and.not.equal('');
    expect(read.property).to.be.a('string').and.not.equal('');

    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(filed.cleared).to.equal(true);
    // the filing's answer, the list and the document keep what the list shows
    const kept = {
      ref: read.ref,
      property: read.property,
      total: read.total,
      reviewed: read.total,
    };
    expect(filed).to.include(kept);
    const {items} = await ctx.service.listDocuments({status: 'filed'});
    expect(items.find(d => d.id === doc.id)).to.include(kept);
    expect(await ctx.service.getDocument(doc.id)).to.include(kept);
    // only the small record stays of the fields
    const row = await ctx.repo.getDocument(doc.id);
    expect(row.fields).to.deep.equal([]);
    expect(Object.keys(row.filedRecord)).to.have.members([
      'ref',
      'property',
      'flags',
      'reviewed',
      'total',
    ]);
    // intake's search finds it by its reference and by its property
    for (const q of [read.ref, read.property]) {
      const found = await ctx.service.listDocuments({status: 'filed', q});
      expect(
        found.items.map(d => d.id),
        q,
      ).to.include(doc.id);
    }
  });

  it('nothing is cleared while the EDRMS lacks the page text; the back-fill clears it once it is there', async () => {
    const ctx = await makeIntake({respond: withPages});
    const doc = await ctx.captureAndExtract(pdf('filed without text'));
    // filed as before API-798: without the page text
    const fileDocument = ctx.service.edrms.fileDocument;
    ctx.service.edrms = {
      ...ctx.service.edrms,
      fileDocument: req => fileDocument({...req, transcription: []}),
    };
    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(filed.cleared).to.equal(false);
    const kept = await ctx.repo.getDocument(doc.id);
    expect(kept.fields).to.have.length.above(0);
    expect(kept.transcription).to.not.equal(null);
    expect(ctx.plainStore.blobs.has(kept.fileKey)).to.equal(true);
    expect(
      (await ctx.repo.listExtractions(doc.id)).some(e => e.answer),
    ).to.equal(true);

    expect(await ctx.service.clearFiledDocuments()).to.deep.equal({
      cleared: 0,
      incomplete: 1,
      alreadyCleared: 0,
      failed: [],
    });
    // the text back-fill of API-798 gives the EDRMS the text: then it is cleared, once
    await ctx.service.backfillFiledTranscriptions();
    expect(await ctx.service.clearFiledDocuments()).to.deep.equal({
      cleared: 1,
      incomplete: 0,
      alreadyCleared: 0,
      failed: [],
    });
    expect(await ctx.service.clearFiledDocuments()).to.deep.equal({
      cleared: 0,
      incomplete: 0,
      alreadyCleared: 1,
      failed: [],
    });
    expect(ctx.plainStore.blobs.has(kept.fileKey)).to.equal(false);
  });

  it('a file the store fails to delete leaves the document cleared, and is logged with its key', async () => {
    const ctx = await makeIntake({respond: withPages});
    const logger = makeLogger();
    ctx.service.logger = logger;
    const doc = await ctx.captureAndExtract(pdf('store refuses'));
    const before = await ctx.repo.getDocument(doc.id);
    const del = ctx.service.store.delete.bind(ctx.service.store);
    ctx.service.store.delete = async key => {
      if (key === before.fileKey) throw new Error('disk busy');
      return del(key);
    };
    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(filed.cleared).to.equal(true);
    expect(logger.lines).to.have.length(1);
    expect(logger.lines[0].obj).to.include({
      documentId: doc.id,
      key: before.fileKey,
    });
    // the page text file went; the document counts as cleared for the back-fill
    expect(ctx.plainStore.blobs.has(before.transcription.key)).to.equal(false);
    expect((await ctx.service.clearFiledDocuments()).alreadyCleared).to.equal(
      1,
    );
  });

  it('nothing is cleared when the EDRMS file differs from the scan', async () => {
    const ctx = await makeIntake({respond: withPages});
    const getVersion = ctx.service.edrms.getVersion;
    ctx.service.edrms = {
      ...ctx.service.edrms,
      getVersion: async (id, n) => ({
        ...(await getVersion(id, n)),
        sha256: '0'.repeat(64),
      }),
    };
    const doc = await ctx.captureAndExtract(pdf('another file'));
    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(filed.cleared).to.equal(false);
    const kept = await ctx.repo.getDocument(doc.id);
    expect(kept.fields).to.have.length.above(0);
    expect(ctx.plainStore.blobs.has(kept.fileKey)).to.equal(true);
    expect((await ctx.service.clearFiledDocuments()).incomplete).to.equal(1);
  });

  it('a failed clearing never fails the filing; it is logged by document id only, and the back-fill clears it', async () => {
    const ctx = await makeIntake({respond: withPages});
    const logger = makeLogger();
    ctx.service.logger = logger;
    const edrms = ctx.service.edrms;
    ctx.service.edrms = {
      ...edrms,
      getVersion: async () => {
        throw new Error('The EDRMS cannot be reached: T 2210/2008');
      },
    };
    const first = await ctx.captureAndExtract(pdf('first'));
    const filed = await reviewAndFile(ctx.service, first.id);
    expect(filed).to.include({status: 'filed', cleared: false});
    expect(logger.lines).to.have.length(1);
    expect(logger.lines[0].obj).to.deep.equal({
      documentId: first.id,
      error: 'Error',
    });
    expect(JSON.stringify(logger.lines)).to.not.contain('2210');

    // the back-fill, with the EDRMS reachable again; a document in review keeps everything
    const inReview = await ctx.captureAndExtract(pdf('in review'));
    ctx.service.edrms = edrms;
    expect(await ctx.service.clearFiledDocuments()).to.deep.equal({
      cleared: 1,
      incomplete: 0,
      alreadyCleared: 0,
      failed: [],
    });
    expect((await ctx.repo.getDocument(first.id)).fields).to.deep.equal([]);
    const review = await ctx.repo.getDocument(inReview.id);
    expect(review.fields).to.have.length.above(0);
    expect(ctx.plainStore.blobs.has(review.fileKey)).to.equal(true);
  });

  it("a cleared document's scan opens from the EDRMS; its reading says it is cleared", async () => {
    const ctx = await makeHttp({respond: withPages});
    const doc = await ctx.captureAndExtract(pdf('opened later'));
    // a link given before the document was filed
    const early = (
      await ctx.app.inject({
        url: `/documents/${doc.id}/file-link`,
        headers: ctx.as(users.rev),
      })
    ).json();
    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(filed.cleared).to.equal(true);

    const link = await ctx.app.inject({
      url: `/documents/${doc.id}/file-link`,
      headers: ctx.as(users.rev),
    });
    expect(link.statusCode).to.equal(200);
    const {url, expiresIn} = link.json();
    expect(url).to.match(
      new RegExp(`^/api/document-content/${filed.filedDocumentId}/1\\?exp=`),
    );
    expect(expiresIn).to.be.above(0);
    const res = await ctx.app.inject({
      url: early.url.replace('/api/intake', ''),
    });
    expect(res.statusCode).to.equal(302);
    expect(res.headers.location).to.match(
      new RegExp(`^/api/document-content/${filed.filedDocumentId}/1\\?exp=`),
    );

    const reading = await ctx.app.inject({
      url: `/documents/${doc.id}/reading`,
      headers: {
        authorization: `Bearer ${createServiceTokenSigner({secret: SECRET, service: 'search'})()}`,
      },
    });
    expect(reading.json()).to.deep.include({
      status: 'filed',
      cleared: true,
      fields: [],
      pages: [],
      filedDocumentId: filed.filedDocumentId,
    });
    expect(reading.json().roles).to.include({deedNo: 'reference'});
  });
});
