import { createEventBus } from '@lrfe/common';
import { BpmEngine } from '../src/engine/engine.js';
import { createMemoryRepo } from '../src/repo/memory.js';

export const users = {
    aina: { id: 'u3', name: 'Aina Mwandingi', perms: ['verify.view', 'verify.edit', 'verify.file'], roles: ['rev'] },
    tangeni: { id: 'u8', name: 'Tangeni Iita', perms: ['verify.view', 'verify.edit', 'verify.file'], roles: ['rev'] },
    kristofina: { id: 'u2', name: 'Kristofina Iipinge', perms: ['capture.view', 'capture.scan'], roles: ['scan'] },
    elina: { id: 'u1', name: 'Elina Shivute', perms: ['record.finalize', 'verify.view'], roles: ['sup'] }
};

export function makeClock(start = Date.parse('2026-09-28T09:00:00Z')) {
    let now = start;
    const clock = () => new Date(now);
    clock.advance = (ms) => { now += ms; };
    return clock;
}

/** Engine over the memory repo; `connectors` are plain async functions. */
export function makeEngine(connectors = {}) {
    const repo = createMemoryRepo();
    const events = createEventBus({ driver: 'memory', source: 'bpm' });
    const published = [];
    events.subscribe('*', e => published.push(e));
    const clock = makeClock();
    const engine = new BpmEngine({ repo, connectors, events, clock });
    return { engine, repo, published, clock };
}

/** Minimal valid definition; override pieces per test. */
export function def(nodes, extra = {}) {
    return { key: 'test-process', name: 'Test process', start: { perm: 'verify.edit', services: ['intake'] }, managePerm: 'verify.file', startAt: 'start', nodes, ...extra };
}

export async function rejects(promise, statusCode, messagePart) {
    try {
        await promise;
    } catch (err) {
        if (err.statusCode !== statusCode) throw err;
        if (messagePart && !err.message.includes(messagePart)) throw new Error(`expected "${messagePart}" in "${err.message}"`);
        return err;
    }
    throw new Error(`expected a ${statusCode} error`);
}
