import {expect} from 'chai';
import {loadDomainPack} from '@lrfe/common';
import {
  buildPrompt,
  buildResponseSchema,
  promptVersionOf,
} from '../src/extraction/prompt.js';
import {mockAnswer} from '../src/extraction/providers.js';
import {normalize} from '../src/extraction/normalize.js';
import {makeHttp, users} from './helpers.js';

describe('intake with another domain pack (CB-3)', () => {
  it('starts with the empty shipping pack: no document types, every upload unrecognised', async () => {
    const pack = await loadDomainPack('shipping');
    const ctx = await makeHttp({pack, respond: f => mockAnswer(f, pack)});
    const res = await ctx.app.inject({
      url: '/catalogue',
      headers: ctx.as(users.scan),
    });
    expect(res.statusCode).to.equal(200);
    expect(res.json()).to.deep.equal({docTypes: []});
    const doc = await ctx.captureAndExtract();
    expect(doc.docType).to.equal('unknown');
    expect(doc.fields).to.deep.equal([]);
    expect(ctx.service.blockers(await ctx.repo.getDocument(doc.id))).to.include(
      'The document type is not recognised',
    );
  });

  it('reads with the generic prompt and checks when the pack has none', async () => {
    const pack = await loadDomainPack('shipping');
    expect(buildPrompt({}, pack)).to.include(
      'Use "unknown" only if it is not one of the document types below',
    );
    expect(buildResponseSchema(pack).properties.docType.enum).to.deep.equal([
      'unknown',
    ]);
    expect(promptVersionOf(pack)).to.equal(null);
    expect(normalize('deed_ref', ' T 1 / 2008 ', pack)).to.deep.equal({
      value: 'T 1 / 2008',
      normalized: 't 1 / 2008',
      checks: [],
    });
  });
});
