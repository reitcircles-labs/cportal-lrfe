import { randomUUID } from 'node:crypto';

/**
 * Minimal event bus. Every service publishes domain events through this interface so the
 * transport can change without touching business logic.
 *
 *   driver 'log'    – default; logs each event (no consumers yet)
 *   driver 'memory' – in-process delivery to subscribers; used by tests and single-process dev
 *
 * A broker driver (e.g. Google Pub/Sub) plugs in here once the audit service exists.
 * TODO: publishes are not transactional with the DB write that caused them. The audit trail
 * will need a transactional outbox before production.
 *
 * Envelope: { id, type, source, time, actor: {id, name}, data }
 */
export function createEventBus({ driver = 'log', source, logger = console } = {}) {
    if (!source) throw new Error('createEventBus: `source` is required');
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

    return {
        async publish(type, data = {}, { actor } = {}) {
            const event = envelope(type, data, actor);
            if (driver === 'memory') await deliver(event);
            else if (driver === 'log') logger.info({ event }, 'event published');
            else throw new Error(`Unknown event bus driver "${driver}"`);
            return event;
        },
        subscribe(type, handler) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(handler);
            return () => handlers.set(type, handlers.get(type).filter(h => h !== handler));
        }
    };
}
