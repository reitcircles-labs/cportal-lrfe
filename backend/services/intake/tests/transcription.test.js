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

// The AI's page text (API-798): an encrypted file beside the scan, not a database column; the
// search service reads it from intake; at filing it goes to the EDRMS, encrypted under its key.

const PAGES = [
  {page: 1, text: 'DEED OF TRANSFER No. T 2210/2008 · Erf 1234 Windhoek'},
  {page: 2, text: 'Signed before me, Registrar of Deeds'},
];
const intakeKeys = () => createFakeKeyring({keyName: 'intake-files'});
const edrmsKeys = () => createFakeKeyring({keyName: 'edrms-files'});
const withPages = () => answer({pages: structuredClone(PAGES)});
const serviceAuth = service => ({
  authorization: `Bearer ${createServiceTokenSigner({secret: SECRET, service})()}`,
});

/** Accept every field and file the document; returns the intake summary. */
async function reviewAndFile(service, id) {
  const d = await service.acceptClean(id, actor(users.rev));
  for (const f of d.fields.filter(x => x.status === 'pending')) {
    await service.updateField(id, f.k, {status: 'accepted'}, actor(users.rev));
  }
  return service.fileDocument(id, actor(users.rev));
}

/** Every stored blob of a memory store as text (ciphertext stays unreadable). */
const blobsAsText = store =>
  [...store.blobs.values()].map(b => b.data.toString('latin1')).join('\n');

describe('page text (API-798)', () => {
  it('is stored as an encrypted file beside the scan, never in the database', async () => {
    const {repo, plainStore, captureAndExtract} = await makeIntake({
      keyring: intakeKeys(),
      respond: withPages,
    });
    const doc = await captureAndExtract(pdf('page text encrypted'));
    expect(doc.transcription).to.deep.equal(PAGES);

    const stored = await repo.getDocument(doc.id);
    expect(stored.transcription).to.include({pages: 2});
    expect(stored.transcription.key).to.match(
      new RegExp(`^intake/${doc.id}/v1/transcription-`),
    );
    expect(stored.transcription.encryption.keyName).to.equal('intake-files');
    const file = plainStore.blobs.get(stored.transcription.key).data;
    expect(file.subarray(0, 4).toString()).to.equal('LRFE');
    expect(blobsAsText(plainStore)).not.to.include('Registrar of Deeds');
    for (const e of await repo.listExtractions(doc.id)) {
      expect(e.answer ?? {}).not.to.have.property('pages');
    }
  });

  it('a new reading replaces the file; a reading without page text has none', async () => {
    let n = 0;
    const ctx = await makeIntake({
      keyring: intakeKeys(),
      respond: () => (++n === 1 ? withPages() : answer({pages: []})),
    });
    const doc = await ctx.captureAndExtract(pdf('read twice'));
    const first = (await ctx.repo.getDocument(doc.id)).transcription.key;
    await ctx.service.requestExtraction(doc.id, {}, actor(users.rev));
    await ctx.worker.drain();
    const again = await ctx.service.getDocument(doc.id);
    expect(again.transcription).to.deep.equal([]);
    expect((await ctx.repo.getDocument(doc.id)).transcription).to.equal(null);
    expect(ctx.plainStore.blobs.has(first)).to.equal(false);
  });

  it('page text read before API-798 moves out of the database into the file', async () => {
    const ctx = await makeIntake({keyring: intakeKeys()});
    const doc = await ctx.captureAndExtract(pdf('older reading'));
    // as stored before: the page text inside the model answer, no file
    await ctx.repo.updateDocument(doc.id, {transcription: null});
    const latest = (await ctx.repo.getDocument(doc.id)).latestExtractionId;
    const old = await ctx.repo.getExtraction(latest);
    await ctx.repo.addExtraction({
      ...old,
      id: 'older-primary',
      answer: {...old.answer, pages: PAGES},
      createdAt: new Date(old.createdAt.getTime() - 1000),
    });
    expect(await ctx.repo.listDocumentIdsWithPageText()).to.deep.equal([
      doc.id,
    ]);

    expect(await ctx.service.migrateTranscriptions()).to.equal(1);
    expect(await ctx.repo.listDocumentIdsWithPageText()).to.deep.equal([]);
    expect((await ctx.service.getDocument(doc.id)).transcription).to.deep.equal(
      PAGES,
    );
    expect(blobsAsText(ctx.plainStore)).not.to.include('Registrar of Deeds');
    expect(await ctx.service.migrateTranscriptions()).to.equal(0); // idempotent
  });

  it('the search service reads the AI output; browsers and other services cannot', async () => {
    const {app, as, captureAndExtract} = await makeHttp({
      keyring: intakeKeys(),
      respond: withPages,
    });
    const doc = await captureAndExtract(pdf('for search'));
    const res = await app.inject({
      url: `/documents/${doc.id}/reading`,
      headers: serviceAuth('search'),
    });
    expect(res.statusCode).to.equal(200);
    const reading = res.json();
    expect(reading).to.include({documentId: doc.id, status: 'ready'});
    expect(reading.pages).to.deep.equal(PAGES);
    expect(reading.fields.find(f => f.k === 'deedNo')).to.include({
      v: 'T 2210/2008',
      search: 'reference',
    });
    // what the index needs (API-808): each field's role, the document's own reference
    expect(reading).to.include({
      reference: 'T 2210/2008',
      filedDocumentId: null,
    });
    expect(reading.fields.find(f => f.k === 'tee1').search).to.equal('name');
    expect(reading.fields.find(f => f.k === 'tee1Id').search).to.equal(
      'number',
    );
    expect(reading.fields.find(f => f.k === 'property').search).to.equal(
      'place',
    );
    expect(reading.fields.find(f => f.k === 'regDate')).not.to.have.property(
      'search',
    );
    expect(JSON.stringify(reading)).not.to.match(/wrappedKey|encryption/);

    // a browser's token is no service token (401); another service is not permitted (403)
    for (const [headers, status] of [
      [as(users.aud), 401],
      [serviceAuth('land-records'), 403],
    ]) {
      const denied = await app.inject({
        url: `/documents/${doc.id}/reading`,
        headers,
      });
      expect(denied.statusCode).to.equal(status);
    }
    const unknown = await app.inject({
      url: '/documents/00000000-0000-4000-8000-000000000000/reading',
      headers: serviceAuth('search'),
    });
    expect(unknown.statusCode).to.equal(404);
  });

  it("the reading keeps the AI's value of a field the officer changed", async () => {
    const {service, captureAndExtract} = await makeIntake({respond: withPages});
    const doc = await captureAndExtract(pdf('edited'));
    await service.updateField(
      doc.id,
      'tee1Id',
      {value: '72110800999', status: 'edited'},
      actor(users.rev),
    );
    const field = (await service.getReading(doc.id)).fields.find(
      f => f.k === 'tee1Id',
    );
    expect(field).to.include({
      v: '72110800999',
      ai: '72110800345',
      edited: true,
    });
  });

  it('the search service lists the documents changed since a moment (re-index, API-808)', async () => {
    const {app, as, clock, captureAndExtract} = await makeHttp({
      respond: withPages,
    });
    const first = await captureAndExtract(pdf('first'));
    clock.advance(60_000);
    const since = clock().toISOString();
    const second = await captureAndExtract(pdf('second'));
    const list = async query =>
      app.inject({
        url: `/documents/changed?${query}`,
        headers: serviceAuth('search'),
      });
    const res = await list(`since=${since}`);
    expect(res.statusCode, res.body).to.equal(200);
    expect(res.json().items.map(d => d.documentId)).to.deep.equal([second.id]);
    const all = (await list('limit=10')).json();
    expect(all.items.map(d => d.documentId)).to.deep.equal([
      first.id,
      second.id,
    ]);
    expect(all.total).to.equal(2);
    expect(all.next).to.equal(null);
    // a page at a time, after the cursor of the one before (API-804)
    const page1 = (await list('limit=1')).json();
    expect(page1.items.map(d => d.documentId)).to.deep.equal([first.id]);
    const page2 = (await list(`limit=1&after=${page1.next}`)).json();
    expect(page2.items.map(d => d.documentId)).to.deep.equal([second.id]);
    expect(page2).to.not.have.property('total');
    const denied = await app.inject({
      url: '/documents/changed',
      headers: as(users.aud),
    });
    expect(denied.statusCode).to.equal(401);
  });

  it('filing carries the page text into the EDRMS, encrypted under its own key', async () => {
    const {service, captureAndExtract, edrmsService, edrmsPlainStore} =
      await makeIntake({
        keyring: intakeKeys(),
        edrmsKeyring: edrmsKeys(),
        respond: withPages,
      });
    const doc = await captureAndExtract(pdf('filed with text'));
    const filed = await reviewAndFile(service, doc.id);
    const text = await edrmsService.repo.getText(filed.filedDocumentId);
    expect(text).to.include({versionNumber: 1, pages: 2});
    expect(text.encryption.keyName).to.equal('edrms-files');
    expect(text).not.to.have.property('text');
    expect(
      edrmsPlainStore.blobs.get(text.storageKey).data.subarray(0, 4).toString(),
    ).to.equal('LRFE');
    expect(blobsAsText(edrmsPlainStore)).not.to.include('Registrar of Deeds');
    expect(await edrmsService.readText(filed.filedDocumentId)).to.deep.equal(
      PAGES,
    );
  });

  it('the back-fill gives documents filed earlier their text, once', async () => {
    const ctx = await makeIntake({
      keyring: intakeKeys(),
      edrmsKeyring: edrmsKeys(),
      respond: withPages,
    });
    const doc = await ctx.captureAndExtract(pdf('filed before'));
    // filed as before API-798: without the page text
    const fileDocument = ctx.service.edrms.fileDocument;
    ctx.service.edrms = {
      ...ctx.service.edrms,
      fileDocument: req => fileDocument({...req, transcription: []}),
    };
    const filed = await reviewAndFile(ctx.service, doc.id);
    expect(await ctx.edrmsService.repo.getText(filed.filedDocumentId)).to.equal(
      null,
    );
    const noText = await ctx.captureAndExtract(pdf('no text'));
    await ctx.repo.updateDocument(noText.id, {
      status: 'filed',
      transcription: null,
    });

    expect(await ctx.service.backfillFiledTranscriptions()).to.deep.equal({
      added: 1,
      present: 0,
      withoutText: 1,
      failed: [],
    });
    expect(
      await ctx.edrmsService.readText(filed.filedDocumentId),
    ).to.deep.equal(PAGES);
    expect(await ctx.service.backfillFiledTranscriptions()).to.deep.equal({
      added: 0,
      present: 1,
      withoutText: 1,
      failed: [],
    });
  });
});
