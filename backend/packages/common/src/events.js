import {randomUUID} from 'node:crypto';
import {currentTransaction} from './db.js';

/**
 * Minimal event bus. Every service publishes domain events through this interface so the
 * transport can change without touching business logic.
 *
 *   driver 'log'    – default; logs each event and delivers it to subscribers in this process only
 *   driver 'memory' – in-process delivery to subscribers, without logging; used by tests
 *   driver 'nats'   – NATS (NATS_URL, default nats://127.0.0.1:4222): every subscriber in every
 *                     service receives it. `npm run dev` starts a local server (scripts/nats.js).
 *
 * With 'nats' the connection is made in the background and re-made after an outage. Subjects are
 * `lrfe.<event type>`, e.g. lrfe.edrms.document.amended.
 *
 * **Durable events (API-613).** With 'nats' and an `outbox` (outbox.js), an event is written to the
 * service's outbox table, in the database transaction of the change when there is one
 * (`atomic(fn)`), and a relay publishes it to the JetStream stream `LRFE` (subjects `lrfe.>`, on
 * disk) with its id as message id, so a retried publish is not stored twice. It survives a NATS
 * outage and a restart of the service. `consume(type, handler, { durable })` reads the stream with a
 * durable consumer: an event is acknowledged after the handler succeeds and redelivered if it fails
 * or the service was down, so handlers must be idempotent. `consume('>', …)` reads every durable
 * event (the audit trail, API-654).
 *
 * **Broadcast-only events** (`publish(…, { durable: false })`, e.g. a revoked session) are never
 * stored: they go to `lrfe-live.<type>` (outside the stream) and reach whoever listens at that
 * moment. Without an outbox, events behave as before: published as they happen, and delivered in
 * this service only while NATS is unreachable.
 *
 * Envelope: { id, type, source, time, actor: {id, name}, data }
 */
export function createEventBus({
  driver = 'log',
  source,
  logger = console,
  url = process.env.NATS_URL || 'nats://127.0.0.1:4222',
  outbox = null,
  streamMaxAgeDays = Number(process.env.EVENT_STREAM_MAX_AGE_DAYS || 30),
  relayIntervalMs = 2000,
} = {}) {
  if (!source) throw new Error('createEventBus: `source` is required');
  if (!['log', 'memory', 'nats'].includes(driver)) {
    throw new Error(`Unknown event bus driver "${driver}"`);
  }
  const handlers = new Map();
  const consumers = [];
  const live = new WeakSet(); // broadcast-only events delivered in this process (memory, log)

  function envelope(type, data, actor) {
    return {
      id: randomUUID(),
      type,
      source,
      time: new Date().toISOString(),
      actor: actor || {id: null, name: 'System'},
      data,
    };
  }

  async function deliver(event) {
    const targets = [
      ...(handlers.get(event.type) || []),
      ...(handlers.get('*') || []),
    ];
    for (const handler of targets) {
      try {
        await handler(event);
      } catch (err) {
        logger.error({err, type: event.type}, 'event handler failed');
      }
    }
  }

  const durable = driver === 'nats' && !!outbox;
  const nats =
    driver === 'nats'
      ? connectNats({
          url,
          source,
          logger,
          deliver,
          stream: {maxAgeDays: streamMaxAgeDays},
        })
      : null;
  const relay = durable
    ? startRelay({outbox, nats, logger, intervalMs: relayIntervalMs})
    : null;

  return {
    driver,
    outbox,
    async publish(type, data = {}, {actor, durable: keep = true} = {}) {
      const event = envelope(type, data, actor);
      if (!keep) live.add(event);
      if (driver === 'memory') await deliver(event);
      else if (driver === 'log') {
        logger.info({event}, 'event published');
        await deliver(event);
      } else if (!keep) {
        if (!nats.publishLive(event)) await deliver(event); // broadcast only: never stored
      } else if (durable) {
        await outbox.add(event); // joins the current transaction
        const transaction = currentTransaction();
        if (transaction) transaction.afterCommit(() => relay.kick());
        else relay.kick();
      } else if (!nats.publish(event)) {
        logger.warn(
          {event},
          'event bus not connected: event delivered in this service only',
        );
        await deliver(event);
      }
      return event;
    },
    subscribe(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
      return () =>
        handlers.set(
          type,
          handlers.get(type).filter(h => h !== handler),
        );
    },
    /**
     * Handle every `type` event, also those published while this service was down (with 'nats',
     * through the durable consumer `durable`; other drivers: like subscribe). The handler must be
     * idempotent: an event whose handling fails is delivered again.
     */
    consume(type, handler, {durable: name} = {}) {
      if (driver !== 'nats') {
        // '>' is every durable event (the stream's lrfe.>): here every event but broadcast-only ones
        if (type === '>') {
          return this.subscribe('*', event =>
            live.has(event) ? undefined : handler(event),
          );
        }
        return this.subscribe(type, handler);
      }
      if (!name) {
        throw new Error('consume: a durable consumer name is required');
      }
      const consumer = {type, handler, name};
      consumers.push(consumer);
      nats.startConsumer(consumer);
      return () => {
        consumer.stopped = true;
        consumer.iterator?.stop?.();
      };
    },
    /**
     * Events the durable consumer `name` can no longer get: those after the last it acknowledged
     * that the stream has already dropped (older than EVENT_STREAM_MAX_AGE_DAYS while it was
     * down). { from, to } stream positions, or null: no gap, or not knowable (other drivers,
     * not connected, consumer not created yet).
     */
    consumerGap: name =>
      nats ? nats.consumerGap(name) : Promise.resolve(null),
    /** Run `fn` so its database changes and the events it publishes are committed together. */
    atomic: fn => (outbox ? outbox.atomic(fn) : fn()),
    /** Publish what is waiting in the outbox now (tests; the relay also runs on its own). */
    flush: () => relay?.run() ?? Promise.resolve(),
    /** Resolves once connected (nats) or at once (other drivers); never rejects. */
    ready: () => nats?.ready ?? Promise.resolve(),
    close: async () => {
      relay?.stop();
      for (const c of consumers) {
        c.stopped = true;
        c.iterator?.stop?.();
      }
      await nats?.close();
    },
  };
}

/**
 * Publishes the outbox's unsent events to JetStream, oldest first, and marks them sent. Runs after
 * each commit that wrote events and every `intervalMs`, so events written while NATS was down, or
 * before a restart, go out once it is back. A publish that times out is retried with the same
 * message id, which the stream de-duplicates.
 */
function startRelay({outbox, nats, logger, intervalMs}) {
  let running = null;
  let again = false;
  let stopped = false;
  let warned = false;
  async function run() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          if (!(await nats.ready.then(() => nats.connected()))) return;
          for (;;) {
            const batch = await outbox.unsent(100);
            if (!batch.length) break;
            for (const event of batch) {
              try {
                await nats.publishDurable(event);
              } catch (err) {
                err.eventId = event.id;
                err.eventType = event.type;
                throw err;
              }
              // marked one by one: a failure later in the batch does not send these again
              await outbox.markSent([event.id]);
            }
          }
          warned = false;
        } catch (err) {
          if (!warned) {
            logger.warn(
              {err: err.message, eventId: err.eventId, type: err.eventType},
              'event bus: outbox relay could not publish yet; it retries',
            );
          }
          warned = true;
          return;
        }
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }
  const timer = setInterval(() => {
    if (!stopped) run();
  }, intervalMs);
  timer.unref?.();
  return {
    run,
    kick() {
      if (!stopped) run();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export const EVENT_STREAM = 'LRFE';

/**
 * One connection per service. Everything published under lrfe.> and lrfe-live.> is received (our
 * own events too, so a service's subscribers see what it publishes exactly once) and handed to
 * deliver(). On connecting, the stream LRFE is created if it does not exist yet, and the durable
 * consumers start.
 */
function connectNats({url, source, logger, deliver, stream}) {
  let nc = null;
  let js = null;
  let jsm = null;
  let closed = false;
  let resolveReady;
  const ready = new Promise(r => {
    resolveReady = r;
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function ensureStream() {
    const {jetstreamManager, StorageType, RetentionPolicy} =
      await import('@nats-io/jetstream');
    jsm = await jetstreamManager(nc);
    try {
      await jsm.streams.info(EVENT_STREAM);
    } catch {
      try {
        await jsm.streams.add({
          name: EVENT_STREAM,
          subjects: ['lrfe.>'],
          storage: StorageType.File,
          retention: RetentionPolicy.Limits,
          // the de-duplication window cannot be longer than the stream keeps events
          max_age: Math.round(stream.maxAgeDays * 86_400 * 1e9),
          duplicate_window: Math.min(
            120 * 1e9,
            Math.round(stream.maxAgeDays * 86_400 * 1e9),
          ),
        });
        logger.info(
          {stream: EVENT_STREAM},
          'event bus: created the event stream',
        );
      } catch (err) {
        // another service created it meanwhile (its settings win: they apply when it is created)
        await jsm.streams.info(EVENT_STREAM).catch(() => {
          throw err;
        });
      }
    }
  }

  async function runConsumer(consumer) {
    const {AckPolicy, DeliverPolicy} = await import('@nats-io/jetstream');
    await ready;
    while (!consumer.stopped && !closed) {
      try {
        if (!jsm) await ensureStream(); // JetStream was not available when we connected
        try {
          await jsm.consumers.info(EVENT_STREAM, consumer.name);
        } catch {
          // a new durable consumer starts with the events published from now on; once it
          // exists it resumes where it left off, also after this service was down
          await jsm.consumers.add(EVENT_STREAM, {
            durable_name: consumer.name,
            ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.New,
            filter_subject: `lrfe.${consumer.type}`,
            ack_wait: 30 * 1e9,
          });
        }
        const c = await js.consumers.get(EVENT_STREAM, consumer.name);
        const messages = await c.consume({max_messages: 50});
        consumer.iterator = messages;
        for await (const m of messages) {
          let event;
          try {
            event = m.json();
          } catch {
            m.term();
            continue;
          }
          try {
            await consumer.handler(event);
            m.ack();
          } catch (err) {
            logger.error(
              {err, type: event.type, consumer: consumer.name},
              'event consumer failed; the event is delivered again',
            );
            m.nak(5000);
          }
          if (consumer.stopped) break;
        }
      } catch (err) {
        if (!consumer.stopped && !closed) {
          logger.warn(
            {err: err.message, consumer: consumer.name},
            'event bus: consumer interrupted, restarting',
          );
        }
      }
      if (!consumer.stopped && !closed) await sleep(2000);
    }
  }

  /** Connects (retrying until NATS answers), subscribes, then logs connection changes. */
  async function connectAndSubscribe() {
    let warned = false;
    const {connect} = await import('@nats-io/transport-node');
    while (!closed && !nc) {
      try {
        nc = await connect({
          servers: url,
          name: source,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 2000,
        });
      } catch (err) {
        if (!warned) {
          logger.warn(
            {err: err.message, url},
            'event bus: cannot reach NATS yet, retrying (events stay in this service meanwhile)',
          );
        }
        warned = true;
        await sleep(2000);
      }
    }
    if (closed) {
      await nc?.close();
      return;
    }
    logger.info({url}, 'event bus: connected to NATS');
    const callback = (err, msg) => {
      if (err) return logger.error({err}, 'event bus: subscription error');
      let event;
      try {
        event = msg.json();
      } catch {
        return logger.warn(
          {subject: msg.subject},
          'event bus: message is not JSON, ignored',
        );
      }
      deliver(event);
    };
    nc.subscribe('lrfe.>', {callback});
    nc.subscribe('lrfe-live.>', {callback});
    await nc.flush(); // the subscriptions are registered with the server before we report ready
    try {
      const {jetstream} = await import('@nats-io/jetstream');
      js = jetstream(nc);
      await ensureStream();
    } catch (err) {
      logger.warn(
        {err: err.message},
        'event bus: JetStream is not available on this server; durable events wait until it is',
      );
    }
    resolveReady();
    for await (const s of nc.status()) {
      if (s.type === 'disconnect') {
        logger.warn({url}, 'event bus: disconnected from NATS, reconnecting');
      } else if (s.type === 'reconnect') {
        logger.info({url}, 'event bus: reconnected to NATS');
      }
    }
  }

  connectAndSubscribe().catch(err =>
    logger.error({err}, 'event bus: NATS client failed'),
  );

  const connected = () => !!nc && !nc.isClosed() && !!js;
  return {
    ready,
    connected,
    /** False when not connected: the caller falls back to local delivery. */
    publish(event) {
      if (!nc || nc.isClosed()) return false;
      nc.publish(`lrfe.${event.type}`, JSON.stringify(event));
      return true;
    },
    /** Broadcast only, never stored. False when not connected. */
    publishLive(event) {
      if (!nc || nc.isClosed()) return false;
      nc.publish(`lrfe-live.${event.type}`, JSON.stringify(event));
      return true;
    },
    /** Store in the stream; resolves once the stream has it (a repeat of the same id is a duplicate). */
    async publishDurable(event) {
      if (!connected()) throw new Error('not connected to NATS');
      if (!jsm) await ensureStream();
      await js.publish(`lrfe.${event.type}`, JSON.stringify(event), {
        msgID: event.id,
        timeout: 5000,
      });
    },
    startConsumer(consumer) {
      runConsumer(consumer).catch(err =>
        logger.error({err}, 'event consumer stopped'),
      );
    },
    async consumerGap(name) {
      if (!connected()) return null;
      try {
        if (!jsm) await ensureStream();
        const [stream, consumer] = await Promise.all([
          jsm.streams.info(EVENT_STREAM),
          jsm.consumers.info(EVENT_STREAM, name),
        ]);
        const acked = consumer.ack_floor.stream_seq;
        const first = stream.state.first_seq;
        return first > acked + 1 ? {from: acked + 1, to: first - 1} : null;
      } catch {
        return null;
      }
    },
    async close() {
      closed = true;
      if (nc && !nc.isClosed()) await nc.drain();
    },
  };
}
