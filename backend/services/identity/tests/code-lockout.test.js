import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect} from 'chai';
import {makeApp, codeFor, wrongCodeFor, PASSWORD} from './helpers.js';
import {totp} from '../src/totp.js';

/**
 * CB-101: guessing the 6-digit authenticator code is stopped twice over.
 *
 * - Per challenge: the challenge returned by POST /auth/login accepts at most 5 wrong codes; after
 *   that it is void and even the right code on it is refused.
 * - Per user: 10 wrong codes within 15 minutes, across challenges, lock the user's 2FA step for 15
 *   minutes; the right code is refused while locked. The count is per user, whatever code check
 *   failed (sign-in or enrolment; CB-102 will add setup codes to the same count), and whatever
 *   client address sent it.
 *
 * Wrong codes and lockouts go to the access log. The limits are settings (env) with these
 * defaults. The counters are kept in the identity process's memory, the same with either store
 * (memory or PostgreSQL): a restart of identity clears them, which these tests accept.
 *
 * Normal sign-in must not change: a typo or two, or four, then the right code still signs in. The
 * e2e suites share the demo users and sign in often with the right code; they enter wrong codes only
 * a few times per user per run, well under the defaults. An e2e test of the lockout itself must use
 * a user of its own (an invited one), never a shared demo user.
 */

const IDENTITY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = join(IDENTITY_DIR, '..', '..', '..');

const MINUTE = 60_000;
const NAKALE = 'm.nakale@oag.gov.na';
const GAWASEB = 'j.gawaseb@deeds.gov.na';

/** The settings (env) of CB-101 on identity, with their agreed defaults. */
const SETTINGS = {
  MFA_MAX_WRONG_CODES_PER_CHALLENGE: '5',
  MFA_LOCKOUT_WRONG_CODES: '10',
  MFA_LOCKOUT_WINDOW_MINUTES: '15',
  MFA_LOCKOUT_MINUTES: '15',
};

/**
 * The identity app with the MFA policy on, and steps of the two-step sign-in over HTTP.
 * @return {!Promise<!Object>}
 */
async function signInApp() {
  const ctx = await makeApp({mfa: true});
  const {app, clock} = ctx;

  /** Step 1: password. Returns the response body (next, challenge, and the secret when enrolling). */
  async function passwordStep(email) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {email, password: PASSWORD},
    });
    expect(res.statusCode, `password step of ${email}`).to.equal(200);
    return res.json();
  }

  /** Step 2: an authenticator code on a challenge, from `ip` (the client address). */
  function sendCode(challenge, code, ip = '203.0.113.10') {
    return app.inject({
      method: 'POST',
      url: '/auth/mfa',
      payload: {challenge, code},
      headers: {'x-forwarded-for': ip},
    });
  }

  /** Enrols `email`'s authenticator (first sign-in) and returns its secret. */
  async function enrol(email) {
    const step1 = await passwordStep(email);
    expect(step1.next).to.equal('mfa-enroll');
    const res = await sendCode(step1.challenge, codeFor(step1.secret, clock));
    expect(res.statusCode, `enrolment of ${email}`).to.equal(200);
    return step1.secret;
  }

  /** A fresh challenge for an enrolled user. */
  async function challengeFor(email) {
    const step1 = await passwordStep(email);
    expect(step1.next).to.equal('mfa');
    return step1.challenge;
  }

  /** Sends `count` wrong codes on one challenge, one after the other; returns the responses. */
  async function wrongCodes(challenge, secret, count, ip) {
    const responses = [];
    for (let i = 0; i < count; i++) {
      responses.push(
        await sendCode(challenge, wrongCodeFor(secret, clock), ip),
      );
    }
    return responses;
  }

  /** Sends `total` wrong codes for `email`, at most 5 per challenge (fresh challenges as needed). */
  async function wrongCodesAcrossChallenges(email, secret, total) {
    let left = total;
    while (left > 0) {
      const batch = Math.min(left, 5);
      await wrongCodes(await challengeFor(email), secret, batch);
      left -= batch;
    }
  }

  /** The right code on a fresh challenge for `email`. */
  async function rightCodeOnFreshChallenge(email, secret) {
    return sendCode(await challengeFor(email), codeFor(secret, clock));
  }

  return {
    ...ctx,
    passwordStep,
    sendCode,
    enrol,
    challengeFor,
    wrongCodes,
    wrongCodesAcrossChallenges,
    rightCodeOnFreshChallenge,
  };
}

/** A sign-in that went through: an access token and the refresh cookie. */
function expectSignedIn(res) {
  expect(res.statusCode, res.body).to.equal(200);
  expect(res.json().accessToken).to.be.a('string');
  expect(res.cookies.find(c => c.name === 'lrfe_rt')).to.not.equal(undefined);
}

/**
 * A refused code step: `status` (401 for a void challenge or a wrong code, 429 for a locked user),
 * no access token, no refresh cookie.
 */
function expectRefused(res, status = 401) {
  expect(res.statusCode, res.body).to.equal(status);
  expect(res.json()).to.not.have.property('accessToken');
  expect(res.cookies.find(c => c.name === 'lrfe_rt')).to.equal(undefined);
}

/** A code step refused because the user's 2FA step is locked: 429, saying when to try again. */
function expectLocked(res) {
  expectRefused(res, 429);
  expect(res.json().message).to.match(
    /^Too many wrong codes, try again in \d+ minutes?$/,
  );
}

/** A challenge with its payload changed (the signature no longer matches). */
function tamperedChallenge(challenge, changes) {
  const [header, payload, signature] = challenge.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const changed = Buffer.from(JSON.stringify({...claims, ...changes})).toString(
    'base64url',
  );
  return `${header}.${changed}.${signature}`;
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

const ADMIN_EMAIL = 'admin@example.org';
const ADMIN_PASSWORD = 'a long bootstrap password for the test';

/**
 * Starts identity as the install does (`node src/index.js`), in memory, with a bootstrap
 * administrator and `settings` added to the environment, from an empty working directory so no
 * local .env file adds to them. Resolves once /health answers; rejects with the process output when
 * it exits first.
 * @param {!Object<string, string>} settings
 * @return {!Promise<{url: string, stop: function(): !Promise<void>}>}
 */
async function startIdentity(settings) {
  const port = await freePort();
  const cwd = mkdtempSync(join(tmpdir(), 'cb101-identity-'));
  const childEnv = {...process.env};
  for (const name of Object.keys(SETTINGS)) {
    delete childEnv[name];
  }
  const child = spawn(process.execPath, [join(IDENTITY_DIR, 'src/index.js')], {
    cwd,
    env: {
      ...childEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
      LRFE_DOMAIN: 'land',
      IDENTITY_STORE: 'memory',
      EVENT_BUS_DRIVER: 'log',
      MAIL_TRANSPORT: 'none',
      JWT_SECRET: 'cb101-identity-secret-cb101-identity-secret',
      COOKIE_SECURE: 'false',
      BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
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
        `identity exited (${child.exitCode}) before it was up: ${output}`,
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
  throw new Error(`identity did not come up in 15 s: ${output}`);
}

/**
 * Starts identity with `settings` and reports whether it stopped on its own.
 * @param {!Object<string, string>} settings
 * @return {!Promise<{listened: boolean, output: string}>}
 */
async function runIdentityExpectingExit(settings) {
  try {
    const {stop} = await startIdentity(settings);
    await stop();
    return {listened: true, output: ''};
  } catch (err) {
    return {listened: false, output: err.message};
  }
}

describe('2FA code guessing: per-challenge limit and per-user lockout (CB-101)', () => {
  describe('Done when: a challenge accepts at most 5 wrong codes, then is refused', () => {
    it('a typo or two, then the right code, signs in as before', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      await t.wrongCodes(challenge, secret, 2);
      expectSignedIn(await t.sendCode(challenge, codeFor(secret, t.clock)));
    });

    it('four wrong codes, then the right code on the same challenge, still signs in', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      await t.wrongCodes(challenge, secret, 4);
      expectSignedIn(await t.sendCode(challenge, codeFor(secret, t.clock)));
    });

    it('each of the first five wrong codes is answered "Invalid authenticator code" (401)', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const responses = await t.wrongCodes(
        await t.challengeFor(NAKALE),
        secret,
        5,
      );
      for (const res of responses) {
        expect(res.statusCode).to.equal(401);
        expect(res.json().message).to.equal('Invalid authenticator code');
      }
    });

    it('after five wrong codes the challenge is void: the right code on it is refused with 401', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      await t.wrongCodes(challenge, secret, 5);
      expectRefused(await t.sendCode(challenge, codeFor(secret, t.clock)));
    });

    it('a void challenge stays refused for every later attempt, right code or wrong', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      await t.wrongCodes(challenge, secret, 5);
      for (let i = 0; i < 3; i++) {
        expectRefused(await t.sendCode(challenge, codeFor(secret, t.clock)));
        t.clock.advance(30_000);
      }
      expectRefused(await t.sendCode(challenge, wrongCodeFor(secret, t.clock)));
    });

    it('a void challenge is refused whatever client address sends the next code', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      await t.wrongCodes(challenge, secret, 5, '203.0.113.10');
      expectRefused(
        await t.sendCode(challenge, codeFor(secret, t.clock), '198.51.100.20'),
      );
    });

    it('after a void challenge, a fresh sign-in gets a new challenge that accepts the right code', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodes(await t.challengeFor(NAKALE), secret, 5);
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it("voiding one challenge leaves the same user's other open challenge usable", async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const first = await t.challengeFor(NAKALE);
      const second = await t.challengeFor(NAKALE);
      await t.wrongCodes(first, secret, 5);
      expectSignedIn(await t.sendCode(second, codeFor(secret, t.clock)));
    });

    it('seven wrong codes sent at the same time on one challenge void it: the right code is refused afterwards', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      const wrong = wrongCodeFor(secret, t.clock);
      const responses = await Promise.all(
        Array.from({length: 7}, () => t.sendCode(challenge, wrong)),
      );
      for (const res of responses) {
        expectRefused(res);
      }
      expectRefused(await t.sendCode(challenge, codeFor(secret, t.clock)));
      // seven wrong codes are fewer than the user's lockout: a fresh sign-in still works
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('a void challenge cannot be revived by altering it (any change breaks its signature)', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenge = await t.challengeFor(NAKALE);
      await t.wrongCodes(challenge, secret, 5);
      const altered = tamperedChallenge(challenge, {
        jti: 'another-challenge',
        iat: Math.floor(Date.now() / 1000) + 1,
      });
      expectRefused(await t.sendCode(altered, codeFor(secret, t.clock)));
    });
  });

  describe("Done when: repeated failures lock the user's 2FA step for 15 minutes; the right code is refused while locked", () => {
    it('nine wrong codes across challenges do not lock: the right code still signs in', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 9);
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('ten wrong codes across challenges within 15 minutes lock the user: the right code on a fresh challenge is refused', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 10);
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('ten wrong codes spread over 14 minutes lock the user too', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      for (let i = 0; i < 10; i++) {
        const challenge = await t.challengeFor(NAKALE);
        await t.wrongCodes(challenge, secret, 1);
        if (i < 9) {
          t.clock.advance(Math.floor((14 * MINUTE) / 9));
        }
      }
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('only wrong codes of the last 15 minutes count: nine, then five more 16 minutes later, do not lock', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 9);
      t.clock.advance(16 * MINUTE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 5);
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('the lock holds for 15 minutes: the right code is refused at 5 minutes and at 14 min 59 s, and accepted at 15 min 01 s', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 10);
      t.clock.advance(5 * MINUTE);
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
      t.clock.advance(10 * MINUTE - 1_000);
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
      t.clock.advance(2_000);
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it("wrong codes sent from different client addresses count towards the same user's lock", async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      for (let i = 0; i < 2; i++) {
        const challenge = await t.challengeFor(NAKALE);
        for (let j = 0; j < 5; j++) {
          await t.sendCode(
            challenge,
            wrongCodeFor(secret, t.clock),
            `198.51.100.${10 + i * 5 + j}`,
          );
        }
      }
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('wrong codes while enrolling the authenticator count towards the same lock (the count is per user, not per kind of code)', async () => {
      const t = await signInApp();
      // two enrolment attempts with five wrong codes each: the user never finishes enrolling
      let secret;
      for (let i = 0; i < 2; i++) {
        const step1 = await t.passwordStep(NAKALE);
        expect(step1.next).to.equal('mfa-enroll');
        secret = step1.secret;
        await t.wrongCodes(step1.challenge, secret, 5);
      }
      const step1 = await t.passwordStep(NAKALE);
      expect(step1.next).to.equal('mfa-enroll');
      expectLocked(
        await t.sendCode(step1.challenge, codeFor(step1.secret, t.clock)),
      );
    });

    it('wrong codes while signing in and while enrolling again add up for the same user', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 5);
      // an administrator resets the authenticator: the user enrols again at the next sign-in
      await t.service.resetMfa((await t.user(NAKALE)).id, {
        id: null,
        name: 'System',
      });
      const enrolling = await t.passwordStep(NAKALE);
      expect(enrolling.next).to.equal('mfa-enroll');
      await t.wrongCodes(enrolling.challenge, enrolling.secret, 5);
      const again = await t.passwordStep(NAKALE);
      expectLocked(
        await t.sendCode(again.challenge, codeFor(again.secret, t.clock)),
      );
    });

    it('the lock is per user: while one user is locked, another signs in normally', async () => {
      const t = await signInApp();
      const nakale = await t.enrol(NAKALE);
      const gawaseb = await t.enrol(GAWASEB);
      await t.wrongCodesAcrossChallenges(NAKALE, nakale, 10);
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, nakale));
      expectSignedIn(await t.rightCodeOnFreshChallenge(GAWASEB, gawaseb));
    });

    it("a challenge altered to name another user is refused and never counts towards that user's lock", async () => {
      const t = await signInApp();
      await t.enrol(NAKALE);
      const gawaseb = await t.enrol(GAWASEB);
      const gawasebId = (await t.user(GAWASEB)).id;
      const challenge = await t.challengeFor(NAKALE);
      for (let i = 0; i < 12; i++) {
        const res = await t.sendCode(
          tamperedChallenge(challenge, {sub: gawasebId}),
          wrongCodeFor(gawaseb, t.clock),
        );
        expect(res.statusCode).to.equal(401);
      }
      expectSignedIn(await t.rightCodeOnFreshChallenge(GAWASEB, gawaseb));
    });

    it('twelve wrong codes sent at the same time over three challenges lock the user', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const challenges = [];
      for (let i = 0; i < 3; i++) {
        challenges.push(await t.challengeFor(NAKALE));
      }
      const wrong = wrongCodeFor(secret, t.clock);
      await Promise.all(
        challenges.flatMap(challenge =>
          Array.from({length: 4}, () => t.sendCode(challenge, wrong)),
        ),
      );
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });

    it('the right code refused while locked starts no session', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 10);
      const createSession = t.repo.createSession.bind(t.repo);
      let started = 0;
      t.repo.createSession = async session => {
        started++;
        return createSession(session);
      };
      expectLocked(await t.rightCodeOnFreshChallenge(NAKALE, secret));
      expect(started).to.equal(0);
    });

    it('the locked step says when to try again: 15 minutes at once, 10 minutes five minutes later', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 10);
      const now = await t.rightCodeOnFreshChallenge(NAKALE, secret);
      expectLocked(now);
      expect(now.json().message).to.equal(
        'Too many wrong codes, try again in 15 minutes',
      );
      t.clock.advance(5 * MINUTE);
      const later = await t.rightCodeOnFreshChallenge(NAKALE, secret);
      expect(later.json().message).to.equal(
        'Too many wrong codes, try again in 10 minutes',
      );
    });

    it('a successful sign-in clears the count: nine wrong, a sign-in, nine wrong again do not lock', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 9);
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 9);
      expectSignedIn(await t.rightCodeOnFreshChallenge(NAKALE, secret));
    });
  });

  describe('failures and lockouts go to the access log', () => {
    /** The denied entries of the access log, newest first. */
    async function deniedEntries(service) {
      return (await service.listAccessLog({kind: 'denied', limit: 200})).items;
    }

    it('each wrong code is written to the access log as a denial naming the user', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const name = (await t.user(NAKALE)).name;
      await t.wrongCodes(await t.challengeFor(NAKALE), secret, 3);
      const failed = (await deniedEntries(t.service)).filter(
        e => e.action === 'MFA failed' && e.target === name,
      );
      expect(failed).to.have.length(3);
    });

    it('the lockout is written to the access log once, naming the user and the 15 minutes', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const name = (await t.user(NAKALE)).name;
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 10);
      await t.rightCodeOnFreshChallenge(NAKALE, secret);
      const locks = (await deniedEntries(t.service)).filter(
        e => e.target === name && /lock/i.test(`${e.action} ${e.detail}`),
      );
      expect(locks).to.have.length(1);
      expect(`${locks[0].action} ${locks[0].detail}`).to.match(/15 min/);
    });

    it('nine wrong codes write no lockout to the access log', async () => {
      const t = await signInApp();
      const secret = await t.enrol(NAKALE);
      const name = (await t.user(NAKALE)).name;
      await t.wrongCodesAcrossChallenges(NAKALE, secret, 9);
      const locks = (await deniedEntries(t.service)).filter(
        e => e.target === name && /lock/i.test(`${e.action} ${e.detail}`),
      );
      expect(locks).to.have.length(0);
    });
  });

  describe('the limits are settings (env) with defaults, on identity as started by the install', function () {
    this.timeout(90_000);
    let identity;

    afterEach(async () => {
      if (identity) {
        await identity.stop();
        identity = null;
      }
    });

    /** Password step of the bootstrap administrator (who enrols the authenticator on first sign-in). */
    async function adminPasswordStep() {
      const res = await fetch(`${identity.url}/auth/login`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({email: ADMIN_EMAIL, password: ADMIN_PASSWORD}),
      });
      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body.next).to.equal('mfa-enroll');
      return body;
    }

    /** A code on a challenge; returns the HTTP status. */
    async function sendCode(challenge, code) {
      const res = await fetch(`${identity.url}/auth/mfa`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({challenge, code}),
      });
      return res.status;
    }

    const now = () => new Date();
    const rightCode = secret => totp(secret, Date.now());

    it('MFA_MAX_WRONG_CODES_PER_CHALLENGE=2: after two wrong codes the right code on that challenge is refused', async () => {
      identity = await startIdentity({MFA_MAX_WRONG_CODES_PER_CHALLENGE: '2'});
      const step1 = await adminPasswordStep();
      for (let i = 0; i < 2; i++) {
        expect(
          await sendCode(step1.challenge, wrongCodeFor(step1.secret, now)),
        ).to.equal(401);
      }
      expect(await sendCode(step1.challenge, rightCode(step1.secret))).to.equal(
        401,
      );
    });

    it('MFA_LOCKOUT_WRONG_CODES=3: three wrong codes across challenges lock the user', async () => {
      identity = await startIdentity({MFA_LOCKOUT_WRONG_CODES: '3'});
      const first = await adminPasswordStep();
      for (let i = 0; i < 2; i++) {
        await sendCode(first.challenge, wrongCodeFor(first.secret, now));
      }
      const second = await adminPasswordStep();
      await sendCode(second.challenge, wrongCodeFor(second.secret, now));
      const third = await adminPasswordStep();
      expect(await sendCode(third.challenge, rightCode(third.secret))).to.equal(
        429,
      );
    });

    it('with no setting, the defaults apply: four wrong codes, then the right code, sign in', async () => {
      identity = await startIdentity({});
      const step1 = await adminPasswordStep();
      for (let i = 0; i < 4; i++) {
        await sendCode(step1.challenge, wrongCodeFor(step1.secret, now));
      }
      expect(await sendCode(step1.challenge, rightCode(step1.secret))).to.equal(
        200,
      );
    });

    for (const name of Object.keys(SETTINGS)) {
      it(`a ${name} of 0, -1 or "abc" stops identity at start, naming the setting`, async () => {
        for (const value of ['0', '-1', 'abc']) {
          const run = await runIdentityExpectingExit({[name]: value});
          expect(run.listened, `${name}=${value}`).to.equal(false);
          expect(run.output).to.include(name);
        }
      });
    }
  });

  describe('the settings are documented and passed on by the compose install', () => {
    const backendReadme = () =>
      readFileSync(join(REPO_DIR, 'backend', 'README.md'), 'utf8');
    const deployReadme = () =>
      readFileSync(join(REPO_DIR, 'deploy', 'README.md'), 'utf8');

    for (const [name, value] of Object.entries(SETTINGS)) {
      it(`${name} is documented with its default (${value})`, () => {
        const docs = `${backendReadme()}\n${deployReadme()}`;
        const lines = docs.split('\n').filter(line => line.includes(name));
        expect(lines, `a line documenting ${name}`).to.not.be.empty;
        expect(lines.join('\n')).to.include(value);
      });
    }

    it('the compose install passes each setting on to identity, so a site can set it in deploy/.env', () => {
      const compose = readFileSync(
        join(REPO_DIR, 'deploy', 'docker-compose.yml'),
        'utf8',
      );
      const match = /^ {2}identity:\n((?: {4}.*\n|\s*\n)+)/m.exec(compose);
      expect(
        match,
        'identity service in deploy/docker-compose.yml',
      ).to.not.equal(null);
      for (const name of Object.keys(SETTINGS)) {
        expect(match[1], name).to.match(new RegExp(`^\\s+${name}:`, 'm'));
      }
    });
  });
});
