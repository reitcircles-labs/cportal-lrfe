import {expect} from 'chai';
import {AppError, createServiceTokenSigner} from '@lrfe/common';
import {buildApp} from '../src/app.js';
import {createEdrmsClient, createIntakeClient} from '../src/clients.js';
import {
  CONSUMERS,
  MAX_ATTEMPTS,
  SearchService,
  retryDelayMs,
} from '../src/search.service.js';
import {readState, rebuildIndex} from '../src/rebuild.js';
import {
  DEAD_LETTER_INDEX,
  INDEX_ALIAS,
  aliasIndex,
  buildSearchQuery,
  loadCountryPack,
} from '@lrfe/search-index';
import {engineAvailable, startTestEngine} from '@lrfe/search-index/testing';
// intake with its worker and a real in-process edrms (the search service's two sources)
import {
  SECRET,
  actor,
  answer,
  injectFetch,
  makeHttp,
  pdf,
  users,
} from '../../intake/tests/helpers.js';

const PAGES = [
  {page: 1, text: 'DEED OF TRANSFER, page one, a secret owner name'},
  {page: 2, text: 'Page two of the deed'},
];

/** A logger that keeps what it was given. */
function makeLogger() {
  const lines = [];
  const log = level => (obj, msg) => lines.push({level, obj, msg});
  return {lines, info: log('info'), warn: log('warn'), error: log('error')};
}

/**
 * The search service fed by intake's and edrms' own (in-memory) event buses, fetching from their
 * HTTP apps with a search service token.
 */
async function makeSearch({engine = null} = {}) {
  const ctx = await makeHttp({
    respond: () => answer({pages: PAGES}),
  });
  const buses = [ctx.service.events, ctx.edrmsService.events];
  const events = {
    consume: (type, handler) => buses.forEach(b => b.subscribe(type, handler)),
    consumerLag: async () => null,
  };
  const serviceToken = createServiceTokenSigner({
    secret: SECRET,
    service: 'search',
  });
  const service = new SearchService({
    events,
    intake: createIntakeClient({
      baseUrl: 'http://intake',
      serviceToken,
      fetchImpl: injectFetch(ctx.app),
    }),
    edrms: createEdrmsClient({
      baseUrl: 'http://edrms',
      serviceToken,
      fetchImpl: injectFetch(ctx.edrmsApp),
    }),
    engine,
    pack: loadCountryPack('NA'),
  });
  const logger = makeLogger();
  service.start({logger});
  const counts = type => service.counts.get(type);
  return {...ctx, search: service, logger, counts};
}

/** Accept every field and file the document; returns the intake summary. */
async function reviewAndFile(service, id) {
  const d = await service.acceptClean(id, actor(users.rev));
  for (const f of d.fields.filter(x => x.status === 'pending')) {
    await service.updateField(id, f.k, {status: 'accepted'}, actor(users.rev));
  }
  return service.fileDocument(id, actor(users.rev));
}

describe('search: the four events, each document fetched (API-802)', () => {
  it('follows the four events, each with its own durable consumer', () => {
    expect(CONSUMERS.map(c => c.type)).to.deep.equal([
      'intake.document.extracted',
      'intake.document.rejected',
      'edrms.document.filed',
      'edrms.document.amended',
    ]);
    expect(new Set(CONSUMERS.map(c => c.durable)).size).to.equal(4);
  });

  it('an AI reading is fetched from intake, a filed and a corrected document from edrms', async () => {
    const {captureAndExtract, service, edrmsService, counts, logger} =
      await makeSearch();
    const doc = await captureAndExtract(pdf('for search'));
    expect(counts('intake.document.extracted')).to.include({
      received: 1,
      fetched: 1,
      failed: 0,
    });
    const reading = logger.lines.find(
      l => l.obj.event === 'intake.document.extracted',
    );
    expect(reading.obj).to.include({
      documentId: doc.id,
      status: 'ready',
      pages: 2,
    });
    expect(reading.obj.fields).to.be.above(0);

    const filed = await reviewAndFile(service, doc.id);
    expect(counts('edrms.document.filed')).to.include({
      received: 1,
      fetched: 1,
    });
    const filedLine = logger.lines.find(
      l => l.obj.event === 'edrms.document.filed',
    );
    expect(filedLine.obj).to.include({
      documentId: filed.filedDocumentId,
      edrmsNo: filed.edrmsNo,
      access: 'restricted',
    });

    await edrmsService.amendDocument({
      id: filed.filedDocumentId,
      expectedVersion: 1,
      reason: 'Typo in division',
      changes: [{k: 'regDiv', v: 'K '}],
    });
    expect(counts('edrms.document.amended')).to.include({
      received: 1,
      fetched: 1,
    });

    // what is logged are counts and numbers, never the document's content
    const logged = JSON.stringify(logger.lines);
    expect(logged).not.to.contain('secret owner name');
    expect(logged).not.to.contain('T 2210/2008');
  });

  it('a rejected upload is fetched from intake, now rejected', async () => {
    const {captureAndExtract, service, counts, logger} = await makeSearch();
    const doc = await captureAndExtract(pdf('to reject'));
    await service.rejectDocument(doc.id, 'Duplicate scan', actor(users.rev));
    expect(counts('intake.document.rejected')).to.include({
      received: 1,
      fetched: 1,
    });
    const line = logger.lines.find(
      l => l.obj.event === 'intake.document.rejected',
    );
    expect(line.obj).to.include({documentId: doc.id, status: 'rejected'});
    expect(JSON.stringify(logger.lines)).not.to.contain('Duplicate scan');
  });
});

describe('search: when a source cannot answer', () => {
  const consumer = CONSUMERS[0];
  const event = {id: 'e1', data: {documentId: 'd1'}};
  const makeService = intake =>
    new SearchService({
      events: {consumerLag: async () => null},
      intake,
      edrms: {},
    });

  it('a document that is no longer there is counted, and the event acknowledged', async () => {
    const service = makeService({getReading: async () => null});
    service.logger = makeLogger();
    await service.handle(consumer, event);
    expect(service.counts.get(consumer.type)).to.include({
      received: 1,
      fetched: 0,
      missing: 1,
    });
  });

  it('intake unreachable: the error is thrown, so the event is delivered again', async () => {
    const service = makeService({
      getReading: async () => {
        throw new AppError(503, 'Intake cannot be reached');
      },
    });
    let err;
    try {
      await service.handle(consumer, event);
    } catch (e) {
      err = e;
    }
    expect(err?.status ?? err?.statusCode).to.equal(503);
    expect(service.counts.get(consumer.type)).to.include({failed: 1});
  });
});

const NA = loadCountryPack('NA');

(engineAvailable ? describe : describe.skip)(
  'search: documents written into the index (API-808)',
  function () {
    this.timeout(180_000);
    let engine;
    before(async () => {
      engine = await startTestEngine();
    });
    after(async () => {
      if (!engine) return;
      await engine.empty();
      engine.stop();
    });
    /** A search service on an empty index. */
    const indexed = async () => {
      await engine.empty();
      const ctx = await makeSearch({engine: engine.request});
      await ctx.search.prepareIndex();
      return ctx;
    };
    const entry = async id =>
      (await engine.request('GET', `/${INDEX_ALIAS}/_doc/${id}`)).body;
    /** The ids found for what was typed (after the index is refreshed). */
    const found = async q => {
      await engine.request('POST', `/${INDEX_ALIAS}/_refresh`);
      const res = await engine.request(
        'POST',
        `/${INDEX_ALIAS}/_search`,
        buildSearchQuery(q, NA),
      );
      return res.body.hits.hits.map(h => h._id);
    };

    it('an upload is searchable once the AI has read it, marked as in intake', async () => {
      const {captureAndExtract} = await indexed();
      const doc = await captureAndExtract(pdf('searchable'));
      const got = await entry(doc.id);
      expect(got.found).to.equal(true);
      expect(got._source).to.deep.include({
        status: 'intake',
        intakeStatus: 'ready',
        access: {audience: 'intake'},
      });
      expect(got._source.text).to.contain('a secret owner name');
      // what a row in intake shows (API-803): its reference, party and property
      expect(got._source.shown.party).to.contain('Nghishidi');
      expect(await found('Nghishidi')).to.deep.equal([doc.id]);
      expect(await found('T 2210/2008')).to.deep.equal([doc.id]);
      // the erf number from the property's description
      expect(await found('Erf 1873')).to.deep.equal([doc.id]);
    });

    it("filing adds the corrected values to the same entry; the AI's stay searchable", async () => {
      const {captureAndExtract, service} = await indexed();
      const doc = await captureAndExtract(pdf('to file'));
      await service.updateField(
        doc.id,
        'tee1Id',
        {value: '72110800999', status: 'edited'},
        actor(users.rev),
      );
      const filed = await reviewAndFile(service, doc.id);
      const got = await entry(doc.id);
      expect(got._source).to.deep.include({
        status: 'filed',
        edrmsId: filed.filedDocumentId,
        edrmsNo: filed.edrmsNo,
      });
      expect(got._source.access).to.deep.include({
        audience: 'edrms',
        restriction: 'restricted',
      });
      // one entry, found by the corrected value and by the AI's
      expect(await found('72110800999')).to.deep.equal([doc.id]);
      expect(await found('72110800345')).to.deep.equal([doc.id]);
      expect(await found(filed.edrmsNo)).to.deep.equal([doc.id]);
      expect(await found('a secret owner name')).to.deep.equal([doc.id]);
      const shown = got._source.shown.fields.find(f => f.k === 'tee1Id');
      expect(shown.v).to.equal('72110800999');
    });

    it('an approved correction replaces the shown value', async () => {
      const {captureAndExtract, service, edrmsService} = await indexed();
      const doc = await captureAndExtract(pdf('to correct'));
      const filed = await reviewAndFile(service, doc.id);
      await edrmsService.amendDocument({
        id: filed.filedDocumentId,
        expectedVersion: 1,
        reason: 'The name was misspelt',
        changes: [{k: 'tee2', v: 'Maria Shilongo'}],
      });
      expect(await found('Shilongo')).to.deep.equal([doc.id]);
      const shown = (await entry(doc.id))._source.shown.fields;
      expect(shown.find(f => f.k === 'tee2').v).to.equal('Maria Shilongo');
    });

    it('a rejected upload disappears', async () => {
      const {captureAndExtract, service, counts} = await indexed();
      const doc = await captureAndExtract(pdf('to reject'));
      expect((await entry(doc.id)).found).to.equal(true);
      await service.rejectDocument(doc.id, 'Duplicate scan', actor(users.rev));
      expect(counts('intake.document.rejected')).to.include({removed: 1});
      expect((await entry(doc.id)).found).to.equal(false);
      expect(await found('Nghishidi')).to.deep.equal([]);
    });

    it('the same event twice gives one entry; an older state never replaces a newer one', async () => {
      const {captureAndExtract, search, counts} = await indexed();
      const doc = await captureAndExtract(pdf('twice'));
      const consumer = CONSUMERS[0];
      await search.handle(consumer, {id: 'again', data: {documentId: doc.id}});
      expect(counts(consumer.type)).to.include({indexed: 2, stale: 0});
      expect(await found('Nghishidi')).to.deep.equal([doc.id]);

      // a slow handler with what intake said a minute earlier
      const reading = await search.intake.getReading(doc.id);
      const older = new SearchService({
        events: {consumerLag: async () => null},
        intake: {
          getReading: async () => ({
            ...reading,
            fields: [],
            updatedAt: new Date(Date.parse(reading.updatedAt) - 60_000),
          }),
        },
        edrms: {},
        engine: engine.request,
        pack: NA,
      });
      older.logger = makeLogger();
      await older.handle(consumer, {id: 'old', data: {documentId: doc.id}});
      expect(older.counts.get(consumer.type)).to.include({stale: 1});
      expect(await found('Nghishidi')).to.deep.equal([doc.id]);
    });

    it('a document that keeps failing lands in the dead-letter list; indexed later, it leaves it', async () => {
      const {captureAndExtract, search} = await indexed();
      const doc = await captureAndExtract(pdf('failing'));
      const consumer = CONSUMERS[0];
      await search.deadLetter(
        consumer,
        {id: 'e9', attempt: MAX_ATTEMPTS, data: {documentId: doc.id}},
        new Error('Intake cannot be reached'),
      );
      await engine.request('POST', `/${DEAD_LETTER_INDEX}/_refresh`);
      const {deadLetters} = await search.status();
      expect(deadLetters.total).to.equal(1);
      expect(deadLetters.items[0]).to.include({
        documentId: doc.id,
        event: consumer.type,
        attempts: MAX_ATTEMPTS,
        error: 'Intake cannot be reached',
      });

      await search.handle(consumer, {id: 'e10', data: {documentId: doc.id}});
      await engine.request('POST', `/${DEAD_LETTER_INDEX}/_refresh`);
      expect((await search.status()).deadLetters.total).to.equal(0);
    });

    it('"re-index since" fills a gap: documents changed since then are written again', async () => {
      const {captureAndExtract, service, search, clock} = await indexed();
      const before = await captureAndExtract(pdf('before'));
      clock.advance(60_000);
      const since = clock();
      const after = await captureAndExtract(pdf('after'));
      await reviewAndFile(service, after.id);
      // the index is lost (restored from a backup without these documents)
      await engine.empty();
      await search.prepareIndex();

      const results = await search.reindex({since});
      expect(results).to.include({missing: 0});
      expect((await entry(after.id))._source.status).to.equal('filed');
      expect((await entry(before.id)).found).to.equal(false);
      // without a date: everything
      await search.reindex();
      expect((await entry(before.id)).found).to.equal(true);
    });

    /** The ids in an index, whatever the alias says. */
    const idsIn = async index => {
      await engine.request('POST', `/${index}/_refresh`);
      const res = await engine.request('POST', `/${index}/_search`, {
        size: 100,
      });
      return res.body.hits.hits.map(h => h._id).sort();
    };

    it('a rebuild fills a new index while search uses the old one, then switches over (API-804)', async () => {
      const {captureAndExtract, service, search, clock} = await indexed();
      const filed = await captureAndExtract(pdf('filed before'));
      await reviewAndFile(service, filed.id);
      const waiting = await captureAndExtract(pdf('waiting before'));
      let during = null;
      const steps = [];
      const result = await rebuildIndex(search, {
        clock,
        progress: async state => {
          steps.push(state.step);
          if (state.step !== 'fill' || during) return;
          // during the fill search still answers, from the old index
          expect(await aliasIndex(engine.request)).to.equal(
            `${INDEX_ALIAS}-v1`,
          );
          expect((await found('Nghishidi')).sort()).to.deep.equal(
            [filed.id, waiting.id].sort(),
          );
          // an upload read meanwhile goes to the old index, and is caught up in the new one
          during = await captureAndExtract(pdf('read during the rebuild'));
        },
      });
      expect(result).to.include({
        index: `${INDEX_ALIAS}-v2`,
        previous: `${INDEX_ALIAS}-v1`,
        stopped: false,
      });
      expect(steps).to.include.members(['catch-up', 'switch', 'after', 'done']);
      expect(await aliasIndex(engine.request)).to.equal(`${INDEX_ALIAS}-v2`);
      expect(await idsIn(`${INDEX_ALIAS}-v2`)).to.deep.equal(
        [filed.id, waiting.id, during.id].sort(),
      );
      expect((await entry(filed.id))._source.status).to.equal('filed');
      // the old index and the progress are gone
      const old = await engine.request('HEAD', `/${INDEX_ALIAS}-v1`);
      expect(old.status).to.equal(404);
      expect(await readState(engine.request)).to.equal(null);
    });

    it('a stopped rebuild resumes where it was; search keeps the old index meanwhile', async () => {
      const {captureAndExtract, search, clock} = await indexed();
      const docs = [];
      for (const name of ['one', 'two', 'three']) {
        docs.push(await captureAndExtract(pdf(name)));
      }
      let pages = 0;
      const stopped = await rebuildIndex(search, {
        clock,
        pageSize: 1,
        stop: () => pages >= 1,
        progress: () => {
          pages += 1;
        },
      });
      expect(stopped.stopped).to.equal(true);
      const state = await readState(engine.request);
      expect(state).to.include({step: 'fill', done: 1, total: 3});
      expect(await aliasIndex(engine.request)).to.equal(`${INDEX_ALIAS}-v1`);
      expect(await found('Nghishidi')).to.have.length(3);

      const resumed = await rebuildIndex(search, {clock, pageSize: 1});
      expect(resumed).to.include({index: `${INDEX_ALIAS}-v2`, stopped: false});
      // the first page was not filled again
      expect(resumed).to.include({done: 3, total: 3});
      expect(await idsIn(INDEX_ALIAS)).to.deep.equal(
        docs.map(d => d.id).sort(),
      );
    });
  },
);

describe('search: retries', () => {
  it('wait longer each time, at most 5 minutes apart', () => {
    expect([1, 2, 3, 4].map(n => retryDelayMs(n))).to.deep.equal([
      5000, 10000, 20000, 40000,
    ]);
    expect(retryDelayMs(20)).to.equal(300_000);
  });
});

describe('search: the clients', () => {
  const token = createServiceTokenSigner({secret: SECRET, service: 'search'});
  const answering = (status, body) => async (url, init) => {
    answering.last = {url, init};
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
    });
  };

  it('send the search service token; a 404 is null, an error status a 502, no answer a 503', async () => {
    const ok = answering(200, {documentId: 'd1'});
    const intake = createIntakeClient({
      baseUrl: 'http://intake',
      serviceToken: token,
      fetchImpl: ok,
    });
    expect(await intake.getReading('d1')).to.deep.equal({documentId: 'd1'});
    expect(answering.last.url).to.equal('http://intake/documents/d1/reading');
    expect(answering.last.init.headers.authorization).to.equal(
      `Bearer ${token()}`,
    );

    const edrms = status =>
      createEdrmsClient({
        baseUrl: 'http://edrms',
        serviceToken: token,
        fetchImpl: answering(status, {message: 'no'}),
      });
    expect(await edrms(404).getDocument('x')).to.equal(null);
    const failed = await edrms(500)
      .getDocument('x')
      .catch(e => e);
    expect(failed.status ?? failed.statusCode).to.equal(502);
    const down = await createEdrmsClient({
      baseUrl: 'http://edrms',
      serviceToken: token,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    })
      .getDocument('x')
      .catch(e => e);
    expect(down.status ?? down.statusCode).to.equal(503);
  });
});

describe('search: GET /health/events', () => {
  it('reports the counts and the lag of each consumer, and their total', async () => {
    const lags = {
      'search-intake-extracted': {pending: 3, unacked: 1},
      'search-intake-rejected': {pending: 0, unacked: 0},
      'search-edrms-filed': {pending: 2, unacked: 0},
      'search-edrms-amended': {pending: 0, unacked: 0},
    };
    const service = new SearchService({
      events: {consumerLag: async name => lags[name]},
      intake: {},
      edrms: {},
    });
    const app = await buildApp({service});
    const res = await app.inject({url: '/health/events'});
    expect(res.statusCode).to.equal(200);
    const body = res.json();
    expect(body.lag).to.equal(6);
    expect(body.consumers[0]).to.include({
      event: 'intake.document.extracted',
      durable: 'search-intake-extracted',
      received: 0,
      pending: 3,
      unacked: 1,
    });
  });

  it('the lag is null when the event bus cannot say', async () => {
    const service = new SearchService({
      events: {consumerLag: async () => null},
      intake: {},
      edrms: {},
    });
    const app = await buildApp({service});
    const body = (await app.inject({url: '/health/events'})).json();
    expect(body.lag).to.equal(null);
    expect(body.consumers.every(c => c.pending === null)).to.equal(true);
  });
});
