/**
 * Durable events (API-613) against a real NATS server with JetStream: the outbox relay, the stream's
 * de-duplication, and durable consumers. Needs `npm run nats` once to download the server.
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect} from 'chai';
import {createEventBus, createMemoryOutbox} from '../src/index.js';

const TOOLS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.tools',
);
const natsBinary =
  existsSync(TOOLS) &&
  readdirSync(TOOLS)
    .filter(d => d.startsWith('nats-server-'))
    .map(d => join(TOOLS, d, 'nats-server'))
    .find(existsSync);
const quiet = {info() {}, warn() {}, error() {}};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () =>
  new Promise(resolve => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
async function until(check, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (await check()) return true;
    await sleep(50);
  }
  return false;
}

(natsBinary ? describe : describe.skip)(
  'durable events: outbox, stream and consumers (API-613)',
  function () {
    this.timeout(30_000);
    let port;
    let url;
    let dir;
    let server;
    const buses = [];
    const bus = opts => {
      const b = createEventBus({
        driver: 'nats',
        url,
        logger: quiet,
        relayIntervalMs: 200,
        ...opts,
      });
      buses.push(b);
      return b;
    };

    async function startServer() {
      server = spawn(
        natsBinary,
        ['-a', '127.0.0.1', '-p', String(port), '-js', '-sd', dir],
        {stdio: 'ignore'},
      );
      await sleep(400);
    }
    async function stopServer() {
      const s = server;
      server = null;
      if (!s) return;
      await new Promise(r => {
        s.once('exit', r);
        s.kill();
      });
    }
    /** Events the stream holds on `subject` (read with a throwaway connection). */
    async function storedCount(subject) {
      const {connect} = await import('@nats-io/transport-node');
      const {jetstreamManager} = await import('@nats-io/jetstream');
      const nc = await connect({servers: url});
      const jsm = await jetstreamManager(nc);
      const info = await jsm.streams.info('LRFE', {subjects_filter: subject});
      await nc.close();
      return Object.values(info.state.subjects || {}).reduce(
        (a, b) => a + b,
        0,
      );
    }

    beforeEach(async () => {
      port = await freePort();
      url = `nats://127.0.0.1:${port}`;
      dir = mkdtempSync(join(tmpdir(), 'lrfe-js-'));
      await startServer();
    });
    afterEach(async () => {
      await Promise.all(buses.splice(0).map(b => b.close().catch(() => {})));
      await stopServer();
      rmSync(dir, {recursive: true, force: true});
    });

    it('an event written while NATS is down is published once it is back, and a consumer gets it once', async () => {
      const consumerSide = bus({source: 'land-records'});
      const got = [];
      consumerSide.consume(
        'edrms.document.amended',
        e => {
          got.push(e);
        },
        {durable: 'test-amended'},
      );
      await consumerSide.ready();
      await sleep(300); // the durable consumer exists

      const outbox = createMemoryOutbox();
      const edrms = bus({source: 'edrms', outbox});
      await edrms.ready();
      await stopServer(); // NATS outage
      const event = await edrms.publish('edrms.document.amended', {
        documentId: 'd1',
        version: 2,
      });
      expect(outbox.rows).to.have.length(1);
      expect(outbox.rows[0].sentAt).to.equal(null); // kept, not lost
      await sleep(500);
      expect(got).to.have.length(0);

      await startServer(); // back, with the same stored stream
      expect(
        await until(() => got.length === 1),
        'delivered after the outage',
      ).to.equal(true);
      expect(got[0].id).to.equal(event.id);
      expect(got[0].data).to.deep.equal({documentId: 'd1', version: 2});
      expect(await until(() => outbox.rows[0].sentAt)).to.equal(true);
      await sleep(500);
      expect(got).to.have.length(1); // exactly once
    });

    it('an event in the outbox survives a restart of the service', async () => {
      const consumerSide = bus({source: 'audit'});
      const got = [];
      consumerSide.consume(
        'intake.document.filed',
        e => {
          got.push(e);
        },
        {durable: 'test-filed'},
      );
      await consumerSide.ready();
      await sleep(300);

      const outbox = createMemoryOutbox(); // the service's table: outlives the process
      await stopServer();
      const before = createEventBus({
        driver: 'nats',
        source: 'intake',
        url,
        logger: quiet,
        outbox,
        relayIntervalMs: 200,
      });
      await before.publish('intake.document.filed', {documentId: 'd7'});
      await before.close(); // the service stops before it could publish

      await startServer();
      const after = bus({source: 'intake', outbox}); // started again, same table
      await after.ready();
      expect(
        await until(() => got.length === 1),
        'published by the restarted service',
      ).to.equal(true);
      expect(got[0].data).to.deep.equal({documentId: 'd7'});
    });

    it('a relay retry does not store or deliver the event twice', async () => {
      const consumerSide = bus({source: 'land-records'});
      const got = [];
      consumerSide.consume(
        'edrms.document.filed',
        e => {
          got.push(e);
        },
        {durable: 'test-dup'},
      );
      await consumerSide.ready();
      await sleep(300);

      const outbox = createMemoryOutbox();
      const markSent = outbox.markSent;
      let failures = 1;
      outbox.markSent = async ids => {
        if (failures-- > 0) throw new Error('database unavailable');
        return markSent(ids);
      };
      const edrms = bus({source: 'edrms', outbox});
      await edrms.ready();
      await edrms.publish('edrms.document.filed', {documentId: 'd9'});
      // the first round published but could not mark it sent; the next round publishes it again
      expect(await until(() => outbox.rows[0].sentAt)).to.equal(true);
      expect(await until(() => got.length >= 1)).to.equal(true);
      await sleep(600);
      expect(got).to.have.length(1);
      expect(await storedCount('lrfe.edrms.document.filed')).to.equal(1);
    });

    it('a durable consumer catches up on what it missed while down, and gets a failed event again', async () => {
      const edrms = bus({source: 'edrms', outbox: createMemoryOutbox()});
      const first = bus({source: 'land-records'});
      const got = [];
      first.consume(
        'edrms.document.amended',
        e => {
          got.push(e.data.n);
        },
        {durable: 'test-catchup'},
      );
      await Promise.all([edrms.ready(), first.ready()]);
      await sleep(300);
      await edrms.publish('edrms.document.amended', {n: 1});
      expect(await until(() => got.length === 1)).to.equal(true);

      await first.close(); // land-records is down
      await edrms.publish('edrms.document.amended', {n: 2});
      await edrms.publish('edrms.document.amended', {n: 3});
      await edrms.flush();
      // the two it missed show as its lag (API-802)
      expect(
        await until(
          async () => (await edrms.consumerLag('test-catchup'))?.pending === 2,
        ),
      ).to.equal(true);

      let fail = true;
      const again = bus({source: 'land-records'}); // back up, same durable consumer
      again.consume(
        'edrms.document.amended',
        e => {
          if (e.data.n === 2 && fail) {
            fail = false;
            throw new Error('database busy');
          }
          got.push(e.data.n);
        },
        {durable: 'test-catchup'},
      );
      await again.ready();
      expect(
        await until(() => got.includes(2) && got.includes(3), 15_000),
        'missed events delivered, the failed one again',
      ).to.equal(true);
      expect(got.filter(n => n === 1)).to.have.length(1);
      expect(
        await until(async () => {
          const lag = await edrms.consumerLag('test-catchup');
          return lag?.pending === 0 && lag?.unacked === 0;
        }),
        'no lag once caught up',
      ).to.equal(true);
      expect(await edrms.consumerLag('no-such-consumer')).to.equal(null);
    });

    it('a failed event is delivered again after its delay, and given up after maxAttempts (API-808)', async () => {
      const edrms = bus({source: 'edrms', outbox: createMemoryOutbox()});
      const search = bus({source: 'search'});
      const attempts = [];
      const givenUp = [];
      search.consume(
        'edrms.document.filed',
        e => {
          attempts.push(e.attempt);
          throw new Error('engine down');
        },
        {
          durable: 'test-give-up',
          retryDelayMs: n => n * 100,
          maxAttempts: 3,
          onGiveUp: (e, err) =>
            givenUp.push({n: e.data.n, attempt: e.attempt, err: err.message}),
        },
      );
      await Promise.all([edrms.ready(), search.ready()]);
      await sleep(300);
      await edrms.publish('edrms.document.filed', {n: 1});
      expect(await until(() => givenUp.length === 1, 10_000)).to.equal(true);
      expect(attempts).to.deep.equal([1, 2, 3]);
      expect(givenUp).to.deep.equal([{n: 1, attempt: 3, err: 'engine down'}]);
      // acknowledged: not delivered again
      await sleep(800);
      expect(attempts).to.have.length(3);
      expect(
        await until(async () => {
          const lag = await edrms.consumerLag('test-give-up');
          return lag?.pending === 0 && lag?.unacked === 0;
        }),
      ).to.equal(true);
    });

    it('an event whose dead-letter record fails is delivered again, never lost (API-808)', async () => {
      const edrms = bus({source: 'edrms', outbox: createMemoryOutbox()});
      const search = bus({source: 'search'});
      const attempts = [];
      let recordWorks = false;
      const recorded = [];
      search.consume(
        'edrms.document.filed',
        e => {
          attempts.push(e.attempt);
          throw new Error('engine down');
        },
        {
          durable: 'test-give-up-kept',
          retryDelayMs: () => 100,
          maxAttempts: 2,
          onGiveUp: e => {
            if (!recordWorks) throw new Error('the list is on the engine too');
            recorded.push(e.attempt);
          },
        },
      );
      await Promise.all([edrms.ready(), search.ready()]);
      await sleep(300);
      await edrms.publish('edrms.document.filed', {n: 1});
      expect(await until(() => attempts.length >= 4, 10_000)).to.equal(true);
      expect(recorded).to.deep.equal([]);
      recordWorks = true;
      expect(await until(() => recorded.length === 1, 10_000)).to.equal(true);
      expect(recorded[0]).to.be.at.least(4);
    });

    it('consume(">") gets every durable event of every service, also those published while it was down (API-654)', async () => {
      const got = [];
      const audit = bus({source: 'audit'});
      audit.consume(
        '>',
        e => {
          got.push(e.type);
        },
        {durable: 'test-all'},
      );
      const edrms = bus({source: 'edrms', outbox: createMemoryOutbox()});
      const identity = bus({source: 'identity', outbox: createMemoryOutbox()});
      await Promise.all([audit.ready(), edrms.ready(), identity.ready()]);
      await sleep(300);
      await edrms.publish('edrms.document.filed', {documentId: 'd1'});
      await identity.publish(
        'identity.session.revoked',
        {userId: 'u1'},
        {durable: false},
      );
      expect(await until(() => got.length === 1)).to.equal(true);

      await audit.close(); // the audit service is down
      await identity.publish('identity.user.invited', {userId: 'u2'});
      await identity.flush();
      const again = bus({source: 'audit'});
      again.consume(
        '>',
        e => {
          got.push(e.type);
        },
        {durable: 'test-all'},
      );
      await again.ready();
      expect(
        await until(() => got.length === 2),
        'missed event delivered',
      ).to.equal(true);
      await sleep(300);
      expect(got).to.deep.equal([
        'edrms.document.filed',
        'identity.user.invited',
      ]);
    });

    it('consumerGap: events dropped from the stream before a consumer read them are named; none otherwise (API-657)', async () => {
      const short = {streamMaxAgeDays: 2 / 86_400}; // a stream that keeps events for 2 seconds
      const edrms = bus({
        source: 'edrms',
        outbox: createMemoryOutbox(),
        ...short,
      });
      await edrms.ready();
      await edrms.publish('edrms.document.filed', {n: 0}); // before the consumer exists
      await edrms.flush();
      const got = [];
      const audit = bus({source: 'audit', ...short});
      audit.consume(
        '>',
        e => {
          got.push(e.data.n);
        },
        {durable: 'test-gap'},
      );
      await audit.ready();
      await sleep(300);
      expect(await audit.consumerGap('test-gap')).to.equal(null); // a new consumer starts after what exists
      await edrms.publish('edrms.document.filed', {n: 1});
      expect(await until(() => got.length === 1)).to.equal(true);
      await sleep(200);
      expect(await audit.consumerGap('test-gap')).to.equal(null); // up to date

      await audit.close(); // down …
      for (const n of [2, 3, 4]) {
        await edrms.publish('edrms.document.filed', {n});
      }
      await edrms.flush();
      await sleep(3000); // … longer than the stream keeps events
      await edrms.publish('edrms.document.filed', {n: 5});
      await edrms.flush();

      const back = bus({source: 'audit', ...short});
      await back.ready();
      expect(await back.consumerGap('test-gap')).to.deep.equal({
        from: 3,
        to: 5,
      }); // stream positions of n = 2, 3, 4
      expect(await back.consumerGap('no-such-consumer')).to.equal(null);
      expect(
        await createEventBus({driver: 'memory', source: 'x'}).consumerGap(
          'test-gap',
        ),
      ).to.equal(null);
    });

    it('broadcast-only events reach listeners but are never stored', async () => {
      const identity = bus({source: 'identity', outbox: createMemoryOutbox()});
      const edrms = bus({source: 'edrms'});
      const got = [];
      edrms.subscribe('identity.session.revoked', e => got.push(e));
      await Promise.all([identity.ready(), edrms.ready()]);
      await identity.publish(
        'identity.session.revoked',
        {userId: 'u1'},
        {durable: false},
      );
      expect(await until(() => got.length === 1)).to.equal(true);
      expect(identity.outbox.rows).to.have.length(0);
      expect(await storedCount('lrfe.identity.session.revoked')).to.equal(0);
    });

    it('subscribers keep receiving durable events as they are published', async () => {
      const edrms = bus({source: 'edrms', outbox: createMemoryOutbox()});
      const other = bus({source: 'bpm'});
      const got = [];
      other.subscribe('edrms.document.filed', e => got.push(e));
      await Promise.all([edrms.ready(), other.ready()]);
      await edrms.publish('edrms.document.filed', {documentId: 'd2'});
      expect(await until(() => got.length === 1)).to.equal(true);
    });
  },
);
