import {expect} from 'chai';
import {AppError, createServiceTokenSigner} from '@lrfe/common';
import {buildApp} from '../src/app.js';
import {createEdrmsClient, createIntakeClient} from '../src/clients.js';
import {CONSUMERS, SearchService} from '../src/search.service.js';
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
async function makeSearch() {
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
