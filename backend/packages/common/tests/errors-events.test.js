import { expect } from 'chai';
import { createBaseApp, createEventBus, ConflictError } from '../src/index.js';

describe('errorHandler', () => {
    it('passes AppError status and message through', async () => {
        const app = createBaseApp({ name: 'test' });
        app.get('/c', async () => { throw new ConflictError('Email already in use', { field: 'email' }); });
        const res = await app.inject({ url: '/c' });
        expect(res.statusCode).to.equal(409);
        expect(res.json()).to.include({ status: 'Conflict', message: 'Email already in use', path: '/c' });
        expect(res.json().details).to.deep.equal({ field: 'email' });
    });

    it('hides the message of unexpected errors', async () => {
        const app = createBaseApp({ name: 'test' });
        app.get('/boom', async () => { throw new Error('password=hunter2 in connection string'); });
        const res = await app.inject({ url: '/boom' });
        expect(res.statusCode).to.equal(500);
        expect(res.body).to.not.include('hunter2');
    });

    it('maps schema validation failures to 400', async () => {
        const app = createBaseApp({ name: 'test' });
        app.post('/v', { schema: { body: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } } }, async () => ({}));
        const res = await app.inject({ method: 'POST', url: '/v', payload: {} });
        expect(res.statusCode).to.equal(400);
    });

    it('serves /health', async () => {
        const res = await createBaseApp({ name: 'svc' }).inject({ url: '/health' });
        expect(res.json()).to.deep.equal({ status: 'ok', service: 'svc' });
    });
});

describe('createEventBus', () => {
    it('memory driver delivers to typed and wildcard subscribers with an envelope', async () => {
        const bus = createEventBus({ driver: 'memory', source: 'identity' });
        const typed = [], all = [];
        bus.subscribe('identity.user.invited', e => typed.push(e));
        bus.subscribe('*', e => all.push(e));
        await bus.publish('identity.user.invited', { userId: 'u1' }, { actor: { id: 'a1', name: 'Admin' } });
        await bus.publish('identity.role.updated', {});
        expect(typed).to.have.length(1);
        expect(all).to.have.length(2);
        expect(typed[0]).to.include({ type: 'identity.user.invited', source: 'identity' });
        expect(typed[0].actor).to.deep.equal({ id: 'a1', name: 'Admin' });
        expect(typed[0].id).to.be.a('string');
    });

    it('a failing subscriber does not break publish', async () => {
        const bus = createEventBus({ driver: 'memory', source: 's', logger: { error() {} } });
        bus.subscribe('x', () => { throw new Error('nope'); });
        await bus.publish('x');
    });

    it('unsubscribe stops delivery', async () => {
        const bus = createEventBus({ driver: 'memory', source: 's' });
        const got = [];
        const off = bus.subscribe('x', e => got.push(e));
        off();
        await bus.publish('x');
        expect(got).to.have.length(0);
    });
});
