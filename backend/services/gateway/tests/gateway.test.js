import { expect } from 'chai';
import Fastify from 'fastify';
import { buildApp } from '../src/app.js';

describe('gateway', () => {
    let upstream, gateway;

    before(async () => {
        upstream = Fastify();
        upstream.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
        upstream.all('/*', async (req) => ({ path: req.url, auth: req.headers.authorization ?? null, method: req.method, expect: req.headers.expect ?? null }));
        await upstream.listen({ port: 0, host: '127.0.0.1' });
        const url = `http://127.0.0.1:${upstream.server.address().port}`;
        gateway = await buildApp({ upstreams: { identity: url, edrms: url, bpm: url, intake: url, 'land-records': url }, corsOrigins: ['http://localhost:4200'] });
        await gateway.ready();
    });

    after(async () => {
        await gateway.close();
        await upstream.close();
    });

    it('proxies /api/auth/* to identity /auth/* with headers intact', async () => {
        const res = await gateway.inject({ method: 'POST', url: '/api/auth/login', headers: { authorization: 'Bearer abc' }, payload: {} });
        expect(res.json()).to.deep.equal({ path: '/auth/login', auth: 'Bearer abc', method: 'POST', expect: null });
    });

    it('proxies /api/records/* to land-records /records/*', async () => {
        expect((await gateway.inject({ url: '/api/records?q=1873' })).json().path).to.equal('/records?q=1873');
        expect((await gateway.inject({ url: '/api/records/catalogue' })).json().path).to.equal('/records/catalogue');
    });

    it('keeps sub-paths and query strings', async () => {
        const res = await gateway.inject({ url: '/api/access-log?kind=denied&limit=5' });
        expect(res.json().path).to.equal('/access-log?kind=denied&limit=5');
        const users = await gateway.inject({ method: 'PUT', url: '/api/users/123/roles', payload: { roles: [] } });
        expect(users.json().path).to.equal('/users/123/roles');
    });

    it('does not forward Expect: 100-continue (large uploads)', async () => {
        const res = await gateway.inject({ method: 'POST', url: '/api/documents', headers: { expect: '100-continue', 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) });
        expect(res.statusCode, res.body).to.equal(200);
        expect(res.json().expect).to.equal(null);
    });

    it('routes document paths to edrms', async () => {
        const doc = await gateway.inject({ url: '/api/documents/abc/content?version=2' });
        expect(doc.json().path).to.equal('/documents/abc/content?version=2');
        const content = await gateway.inject({ url: '/api/document-content/abc/1?exp=1&sig=x' });
        expect(content.json().path).to.equal('/content/abc/1?exp=1&sig=x');
    });

    it('routes workflow paths to bpm', async () => {
        expect((await gateway.inject({ url: '/api/tasks' })).json().path).to.equal('/tasks');
        expect((await gateway.inject({ method: 'POST', url: '/api/process-instances/abc/cancel', payload: {} })).json().path).to.equal('/instances/abc/cancel');
        expect((await gateway.inject({ method: 'POST', url: '/api/processes/document-amendment/instances', payload: {} })).json().path).to.equal('/processes/document-amendment/instances');
    });

    it('routes /api/intake/* to intake without the prefix', async () => {
        expect((await gateway.inject({ url: '/api/intake/documents?status=ready' })).json().path).to.equal('/documents?status=ready');
        expect((await gateway.inject({ url: '/api/intake/files/abc?exp=1&sig=x' })).json().path).to.equal('/files/abc?exp=1&sig=x');
    });

    it('answers CORS preflight for the configured origin, with credentials', async () => {
        const res = await gateway.inject({
            method: 'OPTIONS', url: '/api/auth/login',
            headers: { origin: 'http://localhost:4200', 'access-control-request-method': 'POST' }
        });
        expect(res.headers['access-control-allow-origin']).to.equal('http://localhost:4200');
        expect(res.headers['access-control-allow-credentials']).to.equal('true');
    });

    it('404s for unknown API paths and serves its own /health', async () => {
        expect((await gateway.inject({ url: '/api/unknown' })).statusCode).to.equal(404);
        expect((await gateway.inject({ url: '/health' })).json()).to.deep.equal({ status: 'ok', service: 'gateway' });
    });

    it('refuses to start without an upstream', async () => {
        try {
            await buildApp({ upstreams: {} });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.message).to.include('no upstream URL configured for service "identity"');
        }
    });
});
