import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect} from 'chai';
import Fastify from 'fastify';
import {buildApp} from '../src/app.js';

/**
 * CB-101: the sign-in endpoints (POST /api/auth/login, /api/auth/mfa and /api/auth/refresh) are
 * rate-limited at the gateway per client address, each with its own allowance, 429 above: 60
 * requests a minute on the password and code steps (SIGN_IN_RATE_LIMIT_MAX per
 * SIGN_IN_RATE_LIMIT_WINDOW_MS) and 600 on refresh (REFRESH_RATE_LIMIT_MAX, same window), so an
 * office whose users share one address is not refused. The client
 * address is the one the gateway trusts (CB-105), so a forged X-Forwarded-For does not dodge it.
 *
 * Normal sign-in is one request on each endpoint, far below the limit. The e2e suites share one
 * client address (127.0.0.1) for every test and sign in and refresh often: their stack sets a high
 * limit, as it does for the public check (PUBLIC_RATE_LIMIT_MAX); the limit itself is tested here.
 * Addresses are from the documentation ranges (203.0.113.0/24, 198.51.100.0/24).
 */

const GATEWAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(GATEWAY_DIR, '..', '..', '..');

// CB-102 added the setup-code step, limited like the code step
const SIGN_IN_PATHS = [
  '/api/auth/login',
  '/api/auth/mfa',
  '/api/auth/setup-code',
  '/api/auth/refresh',
];
/** The default allowance per address and window of each sign-in endpoint. */
const DEFAULT_MAX = {
  '/api/auth/login': 60,
  '/api/auth/mfa': 60,
  '/api/auth/setup-code': 60,
  '/api/auth/refresh': 600,
};

const upstreamsAt = url => ({
  identity: url,
  edrms: url,
  bpm: url,
  intake: url,
  'land-records': url,
  audit: url,
  extracts: url,
});

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
  const cwd = mkdtempSync(join(tmpdir(), 'cb101-gateway-'));
  const childEnv = {...process.env};
  delete childEnv.TRUST_PROXY;
  delete childEnv.SIGN_IN_RATE_LIMIT_MAX;
  delete childEnv.SIGN_IN_RATE_LIMIT_WINDOW_MS;
  delete childEnv.REFRESH_RATE_LIMIT_MAX;
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
 * Starts the gateway with `settings` and reports whether it stopped on its own.
 * @param {!Object<string, string>} settings
 * @return {!Promise<{listened: boolean, output: string}>}
 */
async function runGatewayExpectingExit(settings) {
  try {
    const {stop} = await startGateway(settings);
    await stop();
    return {listened: true, output: ''};
  } catch (err) {
    return {listened: false, output: err.message};
  }
}

describe('sign-in rate limit per client address (CB-101)', () => {
  let upstream;
  let upstreamUrl;
  /** The paths the upstream (identity, for /api/auth) received, in order. */
  const received = [];

  before(async () => {
    upstream = Fastify({trustProxy: true});
    upstream.all('/*', async req => {
      received.push(req.url);
      return {path: req.url, ip: req.ip};
    });
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

  beforeEach(() => {
    received.length = 0;
  });

  afterEach(async () => {
    while (opened.length) {
      await opened.pop().close();
    }
  });

  /** A POST on `url` from `remoteAddress`, with optional headers. */
  function post(app, url, remoteAddress = '203.0.113.7', headers = {}) {
    return app.inject({
      method: 'POST',
      url,
      payload: {},
      remoteAddress,
      headers,
    });
  }

  /** The status codes of `count` POSTs on `url` from one address. */
  async function statuses(app, url, count, remoteAddress = '203.0.113.7') {
    const codes = [];
    for (let i = 0; i < count; i++) {
      codes.push((await post(app, url, remoteAddress)).statusCode);
    }
    return codes;
  }

  const allowed = n => Array.from({length: n}, () => 200);

  describe('Done when: the sign-in endpoints return 429 above the limit', () => {
    for (const path of SIGN_IN_PATHS) {
      const max = DEFAULT_MAX[path];
      it(`by default, POST ${path} allows ${max} requests a minute from one address; the next gets 429`, async () => {
        const app = await gatewayWith();
        expect(await statuses(app, path, max + 1)).to.deep.equal([
          ...allowed(max),
          429,
        ]);
      });
    }

    it('the 429 is neutral, in the shared error shape, and names no tool', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 1, timeWindow: 60_000},
      });
      await post(app, '/api/auth/login');
      const refused = await post(app, '/api/auth/login');
      expect(refused.statusCode).to.equal(429);
      expect(refused.json()).to.include({
        status: 'Too Many Requests',
        message: 'Too many requests: try again in 1 minute.',
      });
      expect(refused.body).to.not.match(/rate.?limit|fastify/i);
    });

    it('a refused request never reaches the identity service', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 2, timeWindow: 60_000},
      });
      await statuses(app, '/api/auth/login', 5);
      expect(
        received.filter(path => path.startsWith('/auth/login')),
      ).to.have.length(2);
    });

    it('each endpoint has its own allowance: with login used up, the code step and refresh still pass', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 3, timeWindow: 60_000},
      });
      expect(await statuses(app, '/api/auth/login', 4)).to.deep.equal([
        200, 200, 200, 429,
      ]);
      expect((await post(app, '/api/auth/mfa')).statusCode).to.equal(200);
      expect((await post(app, '/api/auth/refresh')).statusCode).to.equal(200);
    });

    it('each client address has its own allowance', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 3, timeWindow: 60_000},
      });
      expect(
        await statuses(app, '/api/auth/login', 4, '203.0.113.7'),
      ).to.deep.equal([200, 200, 200, 429]);
      expect(
        (await post(app, '/api/auth/login', '203.0.113.8')).statusCode,
      ).to.equal(200);
    });

    it('the allowance comes back once the window has passed', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 2, timeWindow: 300},
      });
      expect(await statuses(app, '/api/auth/mfa', 3)).to.deep.equal([
        200, 200, 429,
      ]);
      await new Promise(resolve => setTimeout(resolve, 450));
      expect((await post(app, '/api/auth/mfa')).statusCode).to.equal(200);
    });

    it('follows the refresh limit it is given: with 3, the 4th refresh is refused', async () => {
      const app = await gatewayWith({
        refreshRateLimit: {max: 3, timeWindow: 60_000},
      });
      expect(await statuses(app, '/api/auth/refresh', 4)).to.deep.equal([
        200, 200, 200, 429,
      ]);
    });

    it('the sign-in limit leaves refresh its own: with sign-in at 1, refresh still passes 3 times', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 1, timeWindow: 60_000},
      });
      expect(await statuses(app, '/api/auth/refresh', 3)).to.deep.equal([
        200, 200, 200,
      ]);
    });

    it('a query string does not give a fresh allowance', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 2, timeWindow: 60_000},
      });
      await statuses(app, '/api/auth/login', 2);
      expect((await post(app, '/api/auth/login?again=1')).statusCode).to.equal(
        429,
      );
      expect(
        (await post(app, '/api/auth/login?toString=1')).statusCode,
      ).to.equal(429);
    });

    it('a percent-encoded path (/api/auth/%6Cogin) does not dodge the limit', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 2, timeWindow: 60_000},
      });
      await statuses(app, '/api/auth/login', 2);
      const res = await post(app, '/api/auth/%6Cogin');
      const reachedLogin = received.length > 2;
      expect(
        res.statusCode === 429 || !reachedLogin,
        `encoded path answered ${res.statusCode} and reached identity`,
      ).to.equal(true);
    });

    it('changing X-Forwarded-For on each request does not dodge the limit (CB-105)', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 3, timeWindow: 60_000},
      });
      const codes = [];
      for (let i = 0; i < 4; i++) {
        const res = await post(app, '/api/auth/login', '203.0.113.9', {
          'x-forwarded-for': `198.51.100.${10 + i}`,
        });
        codes.push(res.statusCode);
      }
      expect(codes).to.deep.equal([200, 200, 200, 429]);
    });

    it('behind a trusted proxy, two clients keep their own allowance', async () => {
      const app = await gatewayWith({
        trustProxy: 1,
        signInRateLimit: {max: 2, timeWindow: 60_000},
      });
      const from = client =>
        post(app, '/api/auth/login', '172.18.0.5', {'x-forwarded-for': client});
      expect((await from('203.0.113.20')).statusCode).to.equal(200);
      expect((await from('203.0.113.20')).statusCode).to.equal(200);
      expect((await from('203.0.113.20')).statusCode).to.equal(429);
      expect((await from('203.0.113.21')).statusCode).to.equal(200);
    });

    it('sixty-five requests at the same time from one address: exactly sixty pass', async () => {
      const app = await gatewayWith();
      const responses = await Promise.all(
        Array.from({length: 65}, () => post(app, '/api/auth/login')),
      );
      const codes = responses.map(res => res.statusCode);
      expect(codes.filter(code => code === 200)).to.have.length(60);
      expect(codes.filter(code => code === 429)).to.have.length(5);
    });
  });

  describe('Done when: normal sign-in is unaffected', () => {
    it('a normal sign-in (password, code, then a refresh) passes', async () => {
      const app = await gatewayWith();
      for (const path of SIGN_IN_PATHS) {
        expect((await post(app, path)).statusCode).to.equal(200);
      }
    });

    it('other identity routes and other services are not limited by the sign-in limit', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 1, timeWindow: 60_000},
      });
      for (let i = 0; i < 5; i++) {
        expect((await post(app, '/api/auth/logout')).statusCode).to.equal(200);
        const me = await app.inject({
          url: '/api/auth/me',
          remoteAddress: '203.0.113.7',
        });
        expect(me.statusCode).to.equal(200);
        const users = await app.inject({
          url: '/api/users',
          remoteAddress: '203.0.113.7',
        });
        expect(users.statusCode).to.equal(200);
      }
    });

    it('the public check keeps its own allowance, apart from the sign-in one', async () => {
      const app = await gatewayWith({
        signInRateLimit: {max: 2, timeWindow: 60_000},
        publicRateLimit: {max: 2, timeWindow: 60_000},
      });
      await statuses(app, '/api/auth/login', 3);
      expect((await post(app, '/api/auth/login')).statusCode).to.equal(429);
      const publicCheck = await app.inject({
        url: '/api/public/extracts/tok',
        remoteAddress: '203.0.113.7',
      });
      expect(publicCheck.statusCode).to.equal(200);
    });
  });

  describe('the settings SIGN_IN_RATE_LIMIT_MAX, SIGN_IN_RATE_LIMIT_WINDOW_MS and REFRESH_RATE_LIMIT_MAX (env), on the gateway as started by the install', function () {
    this.timeout(90_000);
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

    /** The status codes of `count` requests on `path` (sign-in by default) to the started gateway. */
    async function loginStatuses(count, path = '/api/auth/login') {
      const codes = [];
      for (let i = 0; i < count; i++) {
        const res = await fetch(`${gateway.url}${path}`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: '{}',
        });
        codes.push(res.status);
      }
      return codes;
    }

    it('unset: 60 sign-in requests a minute pass, the 61st gets 429', async () => {
      gateway = await startGateway(services());
      expect(await loginStatuses(61)).to.deep.equal([...allowed(60), 429]);
    });

    it('REFRESH_RATE_LIMIT_MAX=2: the third refresh gets 429', async () => {
      gateway = await startGateway({
        ...services(),
        REFRESH_RATE_LIMIT_MAX: '2',
      });
      expect(await loginStatuses(3, '/api/auth/refresh')).to.deep.equal([
        200, 200, 429,
      ]);
    });

    it('SIGN_IN_RATE_LIMIT_MAX=2: the third request gets 429', async () => {
      gateway = await startGateway({
        ...services(),
        SIGN_IN_RATE_LIMIT_MAX: '2',
      });
      expect(await loginStatuses(3)).to.deep.equal([200, 200, 429]);
    });

    it('SIGN_IN_RATE_LIMIT_WINDOW_MS=500: the allowance comes back after half a second', async () => {
      gateway = await startGateway({
        ...services(),
        SIGN_IN_RATE_LIMIT_MAX: '1',
        SIGN_IN_RATE_LIMIT_WINDOW_MS: '500',
      });
      expect(await loginStatuses(2)).to.deep.equal([200, 429]);
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(await loginStatuses(1)).to.deep.equal([200]);
    });

    for (const name of [
      'SIGN_IN_RATE_LIMIT_MAX',
      'SIGN_IN_RATE_LIMIT_WINDOW_MS',
      'REFRESH_RATE_LIMIT_MAX',
    ]) {
      it(`a ${name} of 0, -1 or "abc" stops the gateway at start, naming the setting`, async () => {
        for (const value of ['0', '-1', 'abc']) {
          const run = await runGatewayExpectingExit({
            ...services(),
            [name]: value,
          });
          expect(run.listened, `${name}=${value}`).to.equal(false);
          expect(run.output).to.include(name);
        }
      });
    }
  });

  describe('the settings are documented, passed on by the compose install, and kept out of the way of the e2e runs', () => {
    const read = (...parts) => readFileSync(join(REPO_DIR, ...parts), 'utf8');

    for (const [name, value] of [
      ['SIGN_IN_RATE_LIMIT_MAX', '60'],
      ['SIGN_IN_RATE_LIMIT_WINDOW_MS', '60'],
      ['REFRESH_RATE_LIMIT_MAX', '600'],
    ]) {
      it(`${name} is documented with its default`, () => {
        const docs = `${read('backend', 'README.md')}\n${read('deploy', 'README.md')}`;
        const lines = docs.split('\n').filter(line => line.includes(name));
        expect(lines, `a line documenting ${name}`).to.not.be.empty;
        expect(lines.join('\n')).to.include(value);
      });
    }

    it('the compose install passes the three settings on to the gateway, so a site can set them in deploy/.env', () => {
      const match = /^ {2}gateway:\n((?: {4}.*\n|\s*\n)+)/m.exec(
        read('deploy', 'docker-compose.yml'),
      );
      expect(
        match,
        'gateway service in deploy/docker-compose.yml',
      ).to.not.equal(null);
      expect(match[1]).to.match(/^\s+SIGN_IN_RATE_LIMIT_MAX:/m);
      expect(match[1]).to.match(/^\s+SIGN_IN_RATE_LIMIT_WINDOW_MS:/m);
      expect(match[1]).to.match(/^\s+REFRESH_RATE_LIMIT_MAX:/m);
    });

    it('the e2e stack, where every test shares one client address, sets sign-in and refresh limits high enough for a full run', () => {
      const stack = read('e2e', 'stack', 'start-backend.mjs');
      for (const name of ['SIGN_IN_RATE_LIMIT_MAX', 'REFRESH_RATE_LIMIT_MAX']) {
        const line = new RegExp(`${name}:\\s*'(\\d+)'`).exec(stack);
        expect(line, `${name} in e2e/stack/start-backend.mjs`).to.not.equal(
          null,
        );
        expect(Number(line[1])).to.be.at.least(1000);
      }
    });
  });
});
