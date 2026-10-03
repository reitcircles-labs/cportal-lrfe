import { randomUUID } from 'node:crypto';

/**
 * Minimal event bus. Every service publishes domain events through this interface so the
 * transport can change without touching business logic.
 *
 *   driver 'log'    – default; logs each event and delivers it to subscribers in this process only
 *   driver 'memory' – in-process delivery to subscribers, without logging; used by tests
 *   driver 'nats'   – NATS (NATS_URL, default nats://127.0.0.1:4222): every subscriber in every
 *                     service receives it. `npm run dev` starts a local server (scripts/nats.js).
 *
 * With 'nats' the connection is made in the background and re-made after an outage. While it is
 * down, events are logged and delivered in this process only, and the service keeps working.
 * Subjects are `lrfe.<event type>`, e.g. lrfe.identity.session.revoked.
 *
 * TODO: publishes are not transactional with the DB write that caused them. The audit trail
 * will need a transactional outbox (and a JetStream stream) before production.
 *
 * Envelope: { id, type, source, time, actor: {id, name}, data }
 */
export function createEventBus({ driver = 'log', source, logger = console, url = process.env.NATS_URL || 'nats://127.0.0.1:4222' } = {}) {
    if (!source) throw new Error('createEventBus: `source` is required');
    if (!['log', 'memory', 'nats'].includes(driver)) throw new Error(`Unknown event bus driver "${driver}"`);
    const handlers = new Map();

    function envelope(type, data, actor) {
        return { id: randomUUID(), type, source, time: new Date().toISOString(), actor: actor || { id: null, name: 'System' }, data };
    }

    async function deliver(event) {
        const targets = [...(handlers.get(event.type) || []), ...(handlers.get('*') || [])];
        for (const handler of targets) {
            try { await handler(event); } catch (err) { logger.error({ err, type: event.type }, 'event handler failed'); }
        }
    }

    const nats = driver === 'nats' ? connectNats({ url, source, logger, deliver }) : null;

    return {
        driver,
        async publish(type, data = {}, { actor } = {}) {
            const event = envelope(type, data, actor);
            if (driver === 'memory') await deliver(event);
            else if (driver === 'log') {
                logger.info({ event }, 'event published');
                await deliver(event);
            } else if (!nats.publish(event)) {
                logger.warn({ event }, 'event bus not connected: event delivered in this service only');
                await deliver(event);
            }
            return event;
        },
        subscribe(type, handler) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(handler);
            return () => handlers.set(type, handlers.get(type).filter(h => h !== handler));
        },
        /** Resolves once connected (nats) or at once (other drivers); never rejects. */
        ready: () => nats?.ready ?? Promise.resolve(),
        close: async () => { await nats?.close(); }
    };
}

/**
 * One connection per service. Everything published under lrfe.> is received (our own events too,
 * so a service's subscribers see what it publishes exactly once) and handed to deliver().
 */
function connectNats({ url, source, logger, deliver }) {
    let nc = null;
    let closed = false;
    let resolveReady;
    const ready = new Promise(r => { resolveReady = r; });

    (async () => {
        let warned = false;
        const { connect } = await import('@nats-io/transport-node');
        while (!closed && !nc) {
            try {
                nc = await connect({ servers: url, name: source, maxReconnectAttempts: -1, reconnectTimeWait: 2000 });
            } catch (err) {
                if (!warned) logger.warn({ err: err.message, url }, 'event bus: cannot reach NATS yet, retrying (events stay in this service meanwhile)');
                warned = true;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        if (closed) { await nc?.close(); return; }
        logger.info({ url }, 'event bus: connected to NATS');
        nc.subscribe('lrfe.>', {
            callback: (err, msg) => {
                if (err) return logger.error({ err }, 'event bus: subscription error');
                let event;
                try { event = msg.json(); } catch { return logger.warn({ subject: msg.subject }, 'event bus: message is not JSON, ignored'); }
                deliver(event);
            }
        });
        await nc.flush();   // the subscription is registered with the server before we report ready
        resolveReady();
        for await (const s of nc.status()) {
            if (s.type === 'disconnect') logger.warn({ url }, 'event bus: disconnected from NATS, reconnecting');
            else if (s.type === 'reconnect') logger.info({ url }, 'event bus: reconnected to NATS');
        }
    })().catch(err => logger.error({ err }, 'event bus: NATS client failed'));

    return {
        ready,
        /** False when not connected: the caller falls back to local delivery. */
        publish(event) {
            if (!nc || nc.isClosed()) return false;
            nc.publish(`lrfe.${event.type}`, JSON.stringify(event));
            return true;
        },
        async close() {
            closed = true;
            if (nc && !nc.isClosed()) await nc.drain();
        }
    };
}
