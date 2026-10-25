import {expect} from 'chai';
import FormData from 'form-data';
import {makeApp, deedMeta, PDF} from './helpers.js';

// The AI's page text from intake (API-798): stored beside the filed scan, with a record of where it
// is; the text itself is never in the database nor in what clients get.

const PAGES = [
  {page: 1, text: 'DEED OF TRANSFER No. T 2210/2008'},
  {page: 2, text: 'Signed before me, Registrar of Deeds'},
];

function upload(meta, transcription) {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  if (transcription !== undefined) form.append('transcription', transcription);
  form.append('file', PDF, {
    filename: 'T2210-2008.pdf',
    contentType: 'application/pdf',
  });
  return {payload: form.getBuffer(), headers: form.getHeaders()};
}

describe('edrms page text (API-798)', () => {
  async function file(ctx, transcription) {
    const {payload, headers} = upload(deedMeta(), transcription);
    return ctx.app.inject({
      method: 'POST',
      url: '/documents',
      payload,
      headers: {...headers, ...ctx.bearer(ctx.serviceToken('intake'))},
    });
  }

  it('filing with the page text stores it as a file beside the scan, not in the record', async () => {
    const ctx = await makeApp();
    const res = await file(ctx, JSON.stringify(PAGES));
    expect(res.statusCode, res.body).to.equal(201);
    const {document} = res.json();
    const text = await ctx.repo.getText(document.id);
    expect(text).to.include({versionNumber: 1, pages: 2});
    expect(text.storageKey).to.match(
      new RegExp(`^edrms/${document.id}/v1/transcription-`),
    );
    expect(await ctx.service.readText(document.id)).to.deep.equal(PAGES);
    expect(JSON.stringify(text)).not.to.include('Registrar');
    const read = await ctx.app.inject({
      url: `/documents/${document.id}`,
      headers: ctx.bearer(ctx.serviceToken('search')),
    });
    expect(read.body).not.to.match(/Registrar|transcription/);
  });

  it('filing with bad page text is refused; without page text, the record has none', async () => {
    const ctx = await makeApp();
    for (const bad of ['not json', '[{"page":0,"text":"x"}]', '{"page":1}']) {
      const res = await file(ctx, bad);
      expect(res.statusCode, bad).to.equal(400);
    }
    const plain = await file(ctx);
    expect(plain.statusCode).to.equal(201);
    expect(await ctx.repo.getText(plain.json().document.id)).to.equal(null);
  });

  it('intake adds the text of a document filed without it, once; nobody else can', async () => {
    const ctx = await makeApp();
    const {document} = (await file(ctx)).json();
    const put = (token, pages = PAGES, id = document.id) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/documents/${id}/transcription`,
        payload: {pages},
        headers: ctx.bearer(token),
      });
    expect((await put(ctx.userToken(['verify.file']))).statusCode).to.equal(
      401,
    );
    expect((await put(ctx.serviceToken('search'))).statusCode).to.equal(403);
    const intake = ctx.serviceToken('intake');
    expect(
      (await put(intake, PAGES, '00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).to.equal(404);
    expect((await put(intake, [])).statusCode).to.equal(400);

    const added = await put(intake);
    expect(added.statusCode).to.equal(201);
    expect(added.json()).to.deep.equal({created: true});
    const again = await put(intake, [{page: 1, text: 'other'}]);
    expect(again.statusCode).to.equal(200);
    expect(again.json()).to.deep.equal({created: false});
    expect(await ctx.service.readText(document.id)).to.deep.equal(PAGES);
  });
});
