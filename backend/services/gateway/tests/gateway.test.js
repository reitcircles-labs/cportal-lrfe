import {request} from 'node:http';
import {expect} from 'chai';
import Fastify from 'fastify';
import {buildApp} from '../src/app.js';

describe('gateway', () => {
  let upstream;
  let gateway;

  before(async () => {
    upstream = Fastify();
    upstream.addContentTypeParser(
      'application/octet-stream',
      {parseAs: 'buffer'},
      (_req, body, done) => done(null, body),
    );
    upstream.all('/*', async req => ({
      path: req.url,
      auth: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      method: req.method,
      expect: req.headers.expect ?? null,
    }));
    await upstream.listen({port: 0, host: '127.0.0.1'});
    const url = `http://127.0.0.1:${upstream.server.address().port}`;
    gateway = await buildApp({
      upstreams: {
        identity: url,
        edrms: url,
        bpm: url,
        intake: url,
        'land-records': url,
        audit: url,
        extracts: url,
      },
      corsOrigins: ['http://localhost:4200'],
    });
    await gateway.ready();
  });

  after(async () => {
    await gateway.close();
    await upstream.close();
  });

  it('proxies /api/auth/* to identity /auth/* with headers intact', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {authorization: 'Bearer abc'},
      payload: {},
    });
    expect(res.json()).to.deep.equal({
      path: '/auth/login',
      auth: 'Bearer abc',
      cookie: null,
      method: 'POST',
      expect: null,
    });
  });

  it('proxies /api/audit/* to audit /audit/*', async () => {
    expect(
      (await gateway.inject({url: '/api/audit/trail?subject=record:r1'})).json()
        .path,
    ).to.equal('/audit/trail?subject=record:r1');
  });

  it('proxies /api/extracts/* to extracts /extracts/*', async () => {
    expect(
      (await gateway.inject({url: '/api/extracts?recordId=r1'})).json().path,
    ).to.equal('/extracts?recordId=r1');
  });

  it('proxies /api/records/* to land-records /records/*', async () => {
    expect(
      (await gateway.inject({url: '/api/records?q=1873'})).json().path,
    ).to.equal('/records?q=1873');
    expect(
      (await gateway.inject({url: '/api/records/catalogue'})).json().path,
    ).to.equal('/records/catalogue');
  });

  it('keeps sub-paths and query strings', async () => {
    const res = await gateway.inject({
      url: '/api/access-log?kind=denied&limit=5',
    });
    expect(res.json().path).to.equal('/access-log?kind=denied&limit=5');
    const users = await gateway.inject({
      method: 'PUT',
      url: '/api/users/123/roles',
      payload: {roles: []},
    });
    expect(users.json().path).to.equal('/users/123/roles');
  });

  it('does not forward Expect: 100-continue (large uploads)', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/documents',
      headers: {
        expect: '100-continue',
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(10),
    });
    expect(res.statusCode, res.body).to.equal(200);
    expect(res.json().expect).to.equal(null);
  });

  it('routes document paths to edrms', async () => {
    const doc = await gateway.inject({
      url: '/api/documents/abc/content?version=2',
    });
    expect(doc.json().path).to.equal('/documents/abc/content?version=2');
    const content = await gateway.inject({
      url: '/api/document-content/abc/1?exp=1&sig=x',
    });
    expect(content.json().path).to.equal('/content/abc/1?exp=1&sig=x');
  });

  it('routes workflow paths to bpm', async () => {
    expect((await gateway.inject({url: '/api/tasks'})).json().path).to.equal(
      '/tasks',
    );
    expect(
      (
        await gateway.inject({
          method: 'POST',
          url: '/api/process-instances/abc/cancel',
          payload: {},
        })
      ).json().path,
    ).to.equal('/instances/abc/cancel');
    expect(
      (
        await gateway.inject({
          method: 'POST',
          url: '/api/processes/document-amendment/instances',
          payload: {},
        })
      ).json().path,
    ).to.equal('/processes/document-amendment/instances');
  });

  it('routes /api/intake/* to intake without the prefix', async () => {
    expect(
      (await gateway.inject({url: '/api/intake/documents?status=ready'})).json()
        .path,
    ).to.equal('/documents?status=ready');
    expect(
      (await gateway.inject({url: '/api/intake/files/abc?exp=1&sig=x'})).json()
        .path,
    ).to.equal('/files/abc?exp=1&sig=x');
  });

  it('answers CORS preflight for the configured origin, with credentials', async () => {
    const res = await gateway.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        origin: 'http://localhost:4200',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-allow-origin']).to.equal(
      'http://localhost:4200',
    );
    expect(res.headers['access-control-allow-credentials']).to.equal('true');
  });

  it('404s for unknown API paths and serves its own /health', async () => {
    expect((await gateway.inject({url: '/api/unknown'})).statusCode).to.equal(
      404,
    );
    expect((await gateway.inject({url: '/health'})).json()).to.deep.equal({
      status: 'ok',
      service: 'gateway',
    });
  });

  it('refuses to start without an upstream', async () => {
    try {
      await buildApp({upstreams: {}});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message).to.include(
        'no upstream URL configured for service "identity"',
      );
    }
  });

  describe('public routes (API-693)', () => {
    let limited;
    const from = (remoteAddress, url = '/api/public/extracts/tok') =>
      limited.inject({url, remoteAddress});

    before(async () => {
      const url = `http://127.0.0.1:${upstream.server.address().port}`;
      limited = await buildApp({
        upstreams: Object.fromEntries(
          [
            'identity',
            'edrms',
            'bpm',
            'intake',
            'land-records',
            'audit',
            'extracts',
          ].map(name => [name, url]),
        ),
        publicRateLimit: {max: 3, timeWindow: 60_000},
      });
      await limited.ready();
    });

    after(async () => {
      await limited.close();
    });

    it('proxies GET /api/public/extracts/* to extracts /public/extracts/*, without the caller credentials', async () => {
      const res = await gateway.inject({
        url: '/api/public/extracts/abc_-123',
        headers: {authorization: 'Bearer abc', cookie: 'lrfe_rt=secret'},
      });
      expect(res.statusCode).to.equal(200);
      expect(res.json()).to.include({
        path: '/public/extracts/abc_-123',
        auth: null,
        cookie: null,
        method: 'GET',
      });
    });

    it('exposes nothing else: other methods, other services and other paths under /api/public are 404', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await gateway.inject({
          method,
          url: '/api/public/extracts/abc',
          payload: {},
        });
        expect(res.statusCode, method).to.equal(404);
      }
      for (const url of [
        '/api/public',
        '/api/public/',
        '/api/public/records/abc',
        '/api/public/audit/trail',
        '/api/public/extractsx',
      ]) {
        const res = await gateway.inject({url});
        expect(res.statusCode, url).to.equal(404);
      }
    });

    it('a raw path that climbs out of /api/public/extracts is refused or stays under /public/extracts upstream', async () => {
      await gateway.listen({port: 0, host: '127.0.0.1'});
      const {port} = gateway.server.address();
      // node:http sends the path as written (fetch and inject resolve dot segments first)
      const rawGet = path =>
        new Promise((resolve, reject) => {
          request({host: '127.0.0.1', port, path}, res => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => resolve({status: res.statusCode, body}));
          })
            .on('error', reject)
            .end();
        });
      for (const path of [
        '/api/public/extracts/../../extracts?recordId=r1',
        '/api/public/extracts/..%2F..%2Fextracts',
        '/api/public/extracts/%2e%2e/%2e%2e/extracts',
        '/api/public/../extracts?recordId=r1',
      ]) {
        const res = await rawGet(path);
        if (res.status === 200) {
          expect(JSON.parse(res.body).path, path).to.match(
            /^\/public\/extracts\//,
          );
        } else {
          expect([400, 404], `${path}: ${res.status}`).to.include(res.status);
        }
      }
    });

    it('logs the public path without the token', async () => {
      const lines = [];
      const url = `http://127.0.0.1:${upstream.server.address().port}`;
      const logged = await buildApp({
        upstreams: Object.fromEntries(
          [
            'identity',
            'edrms',
            'bpm',
            'intake',
            'land-records',
            'audit',
            'extracts',
          ].map(name => [name, url]),
        ),
        logger: {
          level: 'info',
          stream: {write: line => lines.push(JSON.parse(line))},
        },
      });
      await logged.ready();
      const token = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
      const res = await logged.inject({url: `/api/public/extracts/${token}`});
      expect(res.statusCode).to.equal(200);
      await logged.inject({url: '/api/records?q=1873'});
      await logged.close();
      expect(lines.filter(l => l.req).map(l => l.req.url)).to.deep.equal([
        '/api/public/extracts/<token>',
        '/api/records?q=1873',
      ]);
      expect(JSON.stringify(lines)).to.not.include(token);
    });

    it('rate-limits each client address: a low burst, then 429 with a neutral message', async () => {
      for (let i = 0; i < 3; i++) {
        expect((await from('203.0.113.7')).statusCode).to.equal(200);
      }
      const refused = await from('203.0.113.7');
      expect(refused.statusCode).to.equal(429);
      expect(refused.json()).to.include({
        status: 'Too Many Requests',
        message: 'Too many requests: try again in 1 minute.',
      });
      expect(refused.body).to.not.match(/rate.?limit|fastify/i);
      // another address has its own allowance
      expect((await from('203.0.113.8')).statusCode).to.equal(200);
      // the signed-in routes are not rate-limited
      for (let i = 0; i < 5; i++) {
        const res = await limited.inject({
          url: '/api/records',
          remoteAddress: '203.0.113.7',
        });
        expect(res.statusCode).to.equal(200);
      }
    });
  });
});
