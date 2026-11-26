import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect} from 'chai';
import Fastify from 'fastify';
import {buildApp, trustProxyFrom} from '../src/app.js';

/**
 * CB-105: the client address the gateway sees, and passes on to the services, is the one the
 * known proxy hops report, never one a client wrote into X-Forwarded-For itself. Addresses are
 * from the documentation ranges: 203.0.113.0/24 and 198.51.100.0/24 are clients, 198.51.100.66
 * is the address a client forges.
 */

const GATEWAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(GATEWAY_DIR, '..', '..', '..');

/** The address a client writes into X-Forwarded-For to pass for someone else. */
const FORGED = '198.51.100.66';

const upstreamsAt = url => ({
  identity: url,
  edrms: url,
  bpm: url,
  intake: url,
  'land-records': url,
  audit: url,
  extracts: url,
});

/**
 * A TRUST_PROXY value as Fastify's trustProxy option takes it: a hop count is a number, a list of
 * addresses or CIDR ranges is a list.
 * @param {string} value
 * @return {number | Array<string>}
 */
function asTrustProxyOption(value) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

/** A free TCP port on the loopback address. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts the gateway as the install does (`node src/index.js`), with its settings from the
 * environment, from an empty working directory so no local .env file adds to them. Resolves once
 * /health answers; rejects with the process output when it exits first.
 * @param {!Object<string, string>} settings
 * @return {!Promise<{url: string, stop: function(): !Promise<void>}>}
 */
async function startGateway(settings) {
  const port = await freePort();
  const cwd = mkdtempSync(join(tmpdir(), 'cb105-gateway-'));
  const childEnv = {...process.env};
  delete childEnv.TRUST_PROXY;
  const child = spawn(process.execPath, [join(GATEWAY_DIR, 'src/index.js')], {
    cwd,
    env: {
      ...childEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
      LRFE_DOMAIN: 'land',
      CORS_ORIGINS: 'http://localhost:4200',
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code));
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(cwd, {recursive: true, force: true});
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(
        `gateway exited (${child.exitCode}) before it was up: ${output}`,
      );
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return {url, stop};
      }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`gateway did not come up in 15 s: ${output}`);
}

/**
 * Starts the gateway with `settings` and waits for it to exit on its own.
 * @param {!Object<string, string>} settings
 * @return {!Promise<{code: ?number, output: string, listened: boolean}>}
 */
async function runGatewayExpectingExit(settings) {
  try {
    const {stop} = await startGateway(settings);
    await stop();
    return {code: null, output: '', listened: true};
  } catch (err) {
    const match = /gateway exited \((\d+|null)\)/.exec(err.message);
    return {
      code: match ? Number(match[1]) : null,
      output: err.message,
      listened: false,
    };
  }
}

describe('client address behind the proxy (CB-105)', () => {
  let upstream;
  let upstreamUrl;

  before(async () => {
    // a service as the backend runs them (trustProxy: true): req.ip is what it would store on a
    // session or in the access log
    upstream = Fastify({trustProxy: true});
    upstream.all('/*', async req => ({
      path: req.url,
      ip: req.ip,
      forwardedFor: req.headers['x-forwarded-for'] ?? null,
    }));
    await upstream.listen({port: 0, host: '127.0.0.1'});
    upstreamUrl = `http://127.0.0.1:${upstream.server.address().port}`;
  });

  after(async () => {
    await upstream.close();
  });

  const opened = [];

  /** A gateway on the upstream echo, with `options` for buildApp; closed after the test. */
  async function gatewayWith(options = {}) {
    const app = await buildApp({
      upstreams: upstreamsAt(upstreamUrl),
      ...options,
    });
    await app.ready();
    opened.push(app);
    return app;
  }

  afterEach(async () => {
    while (opened.length) {
      await opened.pop().close();
    }
  });

  /** A test route on the gateway itself that answers the address it sees. */
  async function gatewaySeeing(options = {}) {
    const app = await buildApp({
      upstreams: upstreamsAt(upstreamUrl),
      ...options,
    });
    app.get('/test/client-address', async req => ({ip: req.ip}));
    await app.ready();
    opened.push(app);
    return app;
  }

  describe('Done when: a forged X-Forwarded-For from a client does not change the address the gateway sees', () => {
    it('by default, a client calling the gateway directly is seen at its own address, whatever X-Forwarded-For it sends', async () => {
      const app = await gatewaySeeing();
      const res = await app.inject({
        url: '/test/client-address',
        remoteAddress: '203.0.113.9',
        headers: {'x-forwarded-for': FORGED},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('by default, a forged chain of several addresses is ignored too', async () => {
      const app = await gatewaySeeing();
      const res = await app.inject({
        url: '/test/client-address',
        remoteAddress: '203.0.113.9',
        headers: {'x-forwarded-for': `${FORGED}, 10.0.0.1, 127.0.0.1`},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('by default, the address passed on to the services is the client own address, not the forged one', async () => {
      const app = await gatewayWith();
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '203.0.113.9',
        headers: {'x-forwarded-for': FORGED},
      });
      expect(res.statusCode).to.equal(200);
      expect(res.json().ip).to.equal('203.0.113.9');
      expect(JSON.stringify(res.json())).to.not.include(FORGED);
    });

    it('with a trusted proxy set, a client that is not that proxy cannot forge its address, at the gateway or downstream', async () => {
      const app = await gatewayWith({trustProxy: ['127.0.0.1']});
      const res = await app.inject({
        url: '/api/access-log',
        remoteAddress: '203.0.113.9',
        headers: {'x-forwarded-for': FORGED},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
      expect(JSON.stringify(res.json())).to.not.include(FORGED);
    });

    it('behind the trusted proxy, an address the client put in front of the proxy own entry is ignored downstream', async () => {
      // nginx appends the address it saw: "<what the client sent>, <the real client>"
      const app = await gatewayWith({trustProxy: ['127.0.0.1']});
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '127.0.0.1',
        headers: {'x-forwarded-for': `${FORGED}, 203.0.113.9`},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
      expect(JSON.stringify(res.json())).to.not.include(FORGED);
    });

    it('nonsense in X-Forwarded-For (toString, __proto__, an empty or invalid entry) neither breaks a request nor changes the address', async () => {
      const app = await gatewayWith();
      for (const value of [
        'toString',
        '__proto__',
        'constructor, hasOwnProperty',
        ',',
        ' ',
        'not-an-ip, 999.1.1.1',
        '::ffff:198.51.100.66',
        `${FORGED}`.repeat(200),
      ]) {
        const res = await app.inject({
          url: '/api/records?q=1',
          remoteAddress: '203.0.113.9',
          headers: {'x-forwarded-for': value},
        });
        expect(res.statusCode, value).to.equal(200);
        expect(res.json().ip, value).to.equal('203.0.113.9');
      }
    });

    it('the public rate limit cannot be dodged by changing X-Forwarded-For on each request', async () => {
      const app = await gatewayWith({
        publicRateLimit: {max: 3, timeWindow: 60_000},
      });
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          url: '/api/public/extracts/tok',
          remoteAddress: '203.0.113.9',
          headers: {'x-forwarded-for': `198.51.100.${10 + i}`},
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).to.deep.equal([200, 200, 200, 429]);
    });

    it('the gateway request log shows the client own address, never the forged one', async () => {
      const lines = [];
      const app = await gatewayWith({
        logger: {
          level: 'info',
          stream: {write: line => lines.push(JSON.parse(line))},
        },
      });
      await app.inject({
        url: '/api/records?q=1',
        remoteAddress: '203.0.113.9',
        headers: {'x-forwarded-for': FORGED},
      });
      const requests = lines.filter(line => line.req);
      expect(requests.map(line => line.req.remoteAddress)).to.deep.equal([
        '203.0.113.9',
      ]);
      expect(JSON.stringify(lines)).to.not.include(FORGED);
    });
  });

  describe('Done when: behind the documented nginx setup the real client address is still seen', () => {
    it('nginx on the same machine (trusted by its address): the gateway sees the client nginx reports', async () => {
      const app = await gatewaySeeing({trustProxy: ['127.0.0.1']});
      const res = await app.inject({
        url: '/test/client-address',
        remoteAddress: '127.0.0.1',
        headers: {'x-forwarded-for': '203.0.113.9'},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('nginx on the same machine: the services see the client nginx reports', async () => {
      const app = await gatewayWith({trustProxy: ['127.0.0.1']});
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '127.0.0.1',
        headers: {'x-forwarded-for': '203.0.113.9'},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('a trusted range (CIDR): two proxy hops on a private network, the client before them is seen downstream', async () => {
      // the site's nginx, then the web container's nginx, each appending the address it saw
      const app = await gatewayWith({trustProxy: ['172.16.0.0/12']});
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '172.18.0.5',
        headers: {'x-forwarded-for': `${FORGED}, 203.0.113.9, 172.18.0.1`},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('a hop count: two proxy hops, the client before them is seen downstream', async () => {
      const app = await gatewayWith({trustProxy: 2});
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '172.18.0.5',
        headers: {'x-forwarded-for': `${FORGED}, 203.0.113.9, 172.18.0.1`},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('behind the trusted proxy, two clients keep their own public rate-limit allowance', async () => {
      const app = await gatewayWith({
        trustProxy: ['127.0.0.1'],
        publicRateLimit: {max: 3, timeWindow: 60_000},
      });
      const from = client =>
        app.inject({
          url: '/api/public/extracts/tok',
          remoteAddress: '127.0.0.1',
          headers: {'x-forwarded-for': `${FORGED}, ${client}`},
        });
      for (let i = 0; i < 3; i++) {
        expect((await from('203.0.113.7')).statusCode).to.equal(200);
      }
      expect((await from('203.0.113.7')).statusCode).to.equal(429);
      expect((await from('203.0.113.8')).statusCode).to.equal(200);
    });
  });

  describe('the setting TRUST_PROXY (env), on the gateway as started by the install', function () {
    this.timeout(60_000);
    let gateway;

    afterEach(async () => {
      if (gateway) {
        await gateway.stop();
        gateway = null;
      }
    });

    /** The gateway's settings that point every service at the upstream echo. */
    const services = () => ({
      IDENTITY_URL: upstreamUrl,
      EDRMS_URL: upstreamUrl,
      BPM_URL: upstreamUrl,
      INTAKE_URL: upstreamUrl,
      RECORDS_URL: upstreamUrl,
      SHIPPING_RECORDS_URL: upstreamUrl,
      AUDIT_URL: upstreamUrl,
      EXTRACTS_URL: upstreamUrl,
    });

    /** What the service behind the gateway sees for a request with `forwardedFor`. */
    async function seenDownstream(forwardedFor) {
      const res = await fetch(`${gateway.url}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': forwardedFor,
        },
        body: '{}',
      });
      expect(res.status).to.equal(200);
      return res.json();
    }

    it('TRUST_PROXY=127.0.0.1 (nginx on this machine): the services see the client nginx appended, not the forged one', async () => {
      gateway = await startGateway({...services(), TRUST_PROXY: '127.0.0.1'});
      const seen = await seenDownstream(`${FORGED}, 203.0.113.9`);
      expect(seen.ip).to.equal('203.0.113.9');
    });

    it('TRUST_PROXY=1 (a hop count): the services see the client the one proxy appended', async () => {
      gateway = await startGateway({...services(), TRUST_PROXY: '1'});
      const seen = await seenDownstream(`${FORGED}, 203.0.113.9`);
      expect(seen.ip).to.equal('203.0.113.9');
    });

    it('TRUST_PROXY as a list of addresses and ranges, with spaces: each is trusted', async () => {
      gateway = await startGateway({
        ...services(),
        TRUST_PROXY: '10.0.0.0/8, 127.0.0.1/8 ,172.16.0.0/12',
      });
      // 127.0.0.1 (the caller) and 10.1.2.3 are trusted hops; 203.0.113.9 is the client
      const seen = await seenDownstream(`${FORGED}, 203.0.113.9, 10.1.2.3`);
      expect(seen.ip).to.equal('203.0.113.9');
    });

    it('TRUST_PROXY naming another proxy: a caller that is not it is seen at its own address', async () => {
      gateway = await startGateway({...services(), TRUST_PROXY: '192.0.2.1'});
      const seen = await seenDownstream(FORGED);
      expect(seen.ip).to.equal('127.0.0.1');
    });

    it('TRUST_PROXY unset: only loopback is trusted, a caller that is not loopback cannot forge its address, a local nginx is believed', async () => {
      // a caller that is not loopback: the gateway with the option the unset setting gives
      const app = await gatewayWith({trustProxy: trustProxyFrom(undefined)});
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '203.0.113.9',
        headers: {'x-forwarded-for': FORGED},
      });
      const direct = res.json();
      expect(direct.ip).to.not.equal(FORGED);
      expect(direct.ip).to.equal('203.0.113.9');
      expect(JSON.stringify(direct)).to.not.include(FORGED);

      // a loopback caller (nginx on this machine), on the gateway as the install starts it
      gateway = await startGateway(services());
      const seen = await seenDownstream(`${FORGED}, 203.0.113.9`);
      expect(seen.ip).to.equal('203.0.113.9');
      expect(JSON.stringify(seen)).to.not.include(FORGED);
    });

    it('a TRUST_PROXY that is neither a hop count nor addresses stops the gateway at start', async () => {
      for (const value of [
        'true',
        'not-an-address',
        '300.1.1.1',
        '10.0.0.0/99',
      ]) {
        const run = await runGatewayExpectingExit({
          ...services(),
          TRUST_PROXY: value,
        });
        expect(run.listened, value).to.equal(false);
        expect(run.code, `${value}: ${run.output}`).to.not.equal(0);
      }
    });
  });

  describe('the compose install and the documentation', () => {
    /** The gateway service's block in deploy/docker-compose.yml. */
    function composeGatewayBlock() {
      const compose = readFileSync(
        join(REPO_DIR, 'deploy', 'docker-compose.yml'),
        'utf8',
      );
      const match = /^ {2}gateway:\n((?: {4}.*\n|\s*\n)+)/m.exec(compose);
      expect(
        match,
        'gateway service in deploy/docker-compose.yml',
      ).to.not.equal(null);
      return match[1];
    }

    /** The TRUST_PROXY value the compose install gives the gateway when .env sets none. */
    function composeDefault() {
      const line = /^\s+TRUST_PROXY:\s*(.+)$/m.exec(composeGatewayBlock());
      expect(line, 'TRUST_PROXY in the gateway environment').to.not.equal(null);
      const raw = line[1].trim().replace(/^["']|["']$/g, '');
      const interpolated = /^\$\{TRUST_PROXY:?-(.*)\}$/.exec(raw);
      return interpolated ? interpolated[1] : raw;
    }

    it('the compose install sets TRUST_PROXY for the gateway, with a default', () => {
      const value = composeDefault();
      expect(value).to.be.a('string').and.not.equal('');
      expect(value.toLowerCase()).to.not.equal('true');
    });

    it('with the compose default, the chain site nginx -> web container -> gateway gives the services the real client', async () => {
      // the web container (172.18.0.5) appends the address it saw: the site's nginx, which
      // reaches it through Docker's published port (172.18.0.1)
      const app = await gatewayWith({
        trustProxy: asTrustProxyOption(composeDefault()),
      });
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '172.18.0.5',
        headers: {'x-forwarded-for': `${FORGED}, 203.0.113.9, 172.18.0.1`},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('with TRUST_PROXY=1 as documented, a client reaching the web container without the site nginx (LRFE_BIND=0.0.0.0) cannot forge its address', async () => {
      // Docker keeps the client's address on a published port: the web container appends it.
      // deploy/README.md: without the site's nginx there is one proxy hop, TRUST_PROXY=1.
      const app = await gatewayWith({
        trustProxy: asTrustProxyOption('1'),
      });
      const res = await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: {},
        remoteAddress: '172.18.0.5',
        headers: {'x-forwarded-for': `${FORGED}, 203.0.113.9`},
      });
      expect(res.json().ip).to.equal('203.0.113.9');
    });

    it('deploy/README.md documents TRUST_PROXY next to the nginx example', () => {
      const readme = readFileSync(
        join(REPO_DIR, 'deploy', 'README.md'),
        'utf8',
      );
      const https = readme.indexOf('## C. HTTPS');
      const next = readme.indexOf('\n## ', https + 1);
      expect(https, 'the HTTPS part').to.be.greaterThan(-1);
      expect(readme.slice(https, next)).to.include('TRUST_PROXY');
    });
  });
});
