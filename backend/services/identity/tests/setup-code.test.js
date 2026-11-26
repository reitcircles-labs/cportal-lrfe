import {readFileSync} from 'node:fs';
import {expect} from 'chai';
import {Sequelize} from 'sequelize';
import {ensureSchema} from '@lrfe/common';
import {makeApp, codeFor, wrongCodeFor, PASSWORD} from './helpers.js';
import {generateSecret} from '../src/totp.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {SCHEMA} from '../src/repo/models.js';
import {createSequelizeRepo} from '../src/repo/sequelize.js';
import {demoMfaSecret, seedIdentity} from '../src/seed.js';
import {issueSetupCode, setupCodeLine} from '../src/setup-code.js';

/**
 * CB-102: an authenticator is set up only with a second proof, never with the password alone.
 *
 * - New users set it up while accepting their invitation (the link is the proof), before the link
 *   is used up.
 * - Anyone else without an authenticator needs a one-time setup code from an administrator: "Reset
 *   2FA" (POST /users/:id/mfa-reset, which also ends the user's sessions) or "Give setup code"
 *   (POST /users/:id/setup-code). Both answer with the code, shown once: { setupCode }.
 * - Sign-in of such a user: password (POST /auth/login answers next 'setup-code', no secret), then
 *   the setup code (POST /auth/setup-code { challenge, setupCode } answers next 'mfa-enroll' with
 *   the secret, the QR link and the challenge), then the existing enrolment (POST /auth/mfa).
 * - The setup code: XXXX-XXXX without look-alikes, one use, valid 72 hours (service setting
 *   setupCodeTtlHours, default 72), stored only as a hash, a new code voids the previous one, wrong
 *   codes count towards the CB-101 per-user lockout, never written to any log.
 * - A best-effort email "A new authenticator was added to your account" after each enrolment.
 *
 * The route paths, the 'setup-code' step name, the body field setupCode and the setting name
 * setupCodeTtlHours are this test's reading of the agreed design, which does not name them.
 */

const ADMIN = 'p.hamutenya@deeds.gov.na';
const OFFICER = 'j.gawaseb@deeds.gov.na';
const SCAN = 'k.iipinge@deeds.gov.na';
const REVIEWER = 'a.mwandingi@deeds.gov.na';
const OTHER_SCAN = 's.nangolo@deeds.gov.na';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NEW_PASSWORD = 'a new password for the invitee';

/** A setup code as the administrator sees it: two groups of 4, capital letters and digits. */
const SETUP_CODE_SHAPE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
/** Characters a setup code never uses, because they look alike (0/O, 1/I/L). */
const LOOK_ALIKES = /[0O1IL]/;
/** The notice emailed after an authenticator is added. */
const NOTICE = /a new authenticator was added to your account/i;

/** A mailer that records what it was asked to send. */
function recordingMailer() {
  const sent = [];
  return {
    sent,
    enabled: true,
    async send(message) {
      sent.push(message);
      return {sent: true, id: `<test-${sent.length}@example.test>`};
    },
  };
}

/** The forms a setup code could be written in: as shown, without the dash, in lower case. */
function formsOf(setupCode) {
  const bare = setupCode.replace('-', '');
  return [setupCode, bare, setupCode.toLowerCase(), bare.toLowerCase()];
}

/** Asserts that `text` holds none of the forms of `setupCode`. */
function expectNoCode(text, setupCode, where) {
  for (const form of formsOf(setupCode)) {
    expect(text, `${where} holds the setup code`).to.not.include(form);
  }
}

/**
 * The identity app with an administrator signed in, then two-factor sign-in required (unless
 * `mfa` is false), and the steps of the sign-in and setup over HTTP.
 * @param {{mfa: (boolean|undefined), mailer: (!Object|undefined), config: (!Object|undefined),
 *     clock: (function(): !Date|undefined), repo: (!Object|undefined),
 *     logger: (!Object|undefined)}=} options
 * @return {!Promise<!Object>}
 */
async function setupApp({mfa = true, ...options} = {}) {
  // the administrator and an officer sign in while the policy is off, so they need no authenticator
  const ctx = await makeApp({...options, mfa: false});
  const {app, repo, clock} = ctx;
  const admin = await ctx.login(ADMIN);
  const officer = await ctx.login(OFFICER);
  if (mfa) {
    await repo.savePolicies({...(await repo.getPolicies()), mfa: true});
  }
  const adminUser = await repo.getUserByEmail(ADMIN);

  /** The id of the user with `email`. */
  async function idOf(email) {
    return (await repo.getUserByEmail(email)).id;
  }

  /** POST as the administrator (or as `token`'s user). */
  function adminPost(url, token = admin.token) {
    return app.inject({method: 'POST', url, headers: ctx.auth(token)});
  }

  /** "Give setup code": the code the administrator is shown. */
  async function giveCode(email) {
    const res = await adminPost(`/users/${await idOf(email)}/setup-code`);
    expect(res.statusCode, res.body).to.equal(200);
    expect(res.json().setupCode, 'the setup code in the answer').to.be.a(
      'string',
    );
    return res.json().setupCode;
  }

  /** "Reset 2FA": the code the administrator is shown. */
  async function resetTwoFactor(email) {
    const res = await adminPost(`/users/${await idOf(email)}/mfa-reset`);
    expect(res.statusCode, res.body).to.equal(200);
    expect(res.json().setupCode, 'the setup code in the answer').to.be.a(
      'string',
    );
    return res.json().setupCode;
  }

  /** Sign-in step 1: the password. Returns the response body. */
  async function passwordStep(email) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {email, password: PASSWORD},
    });
    expect(res.statusCode, `password step of ${email}: ${res.body}`).to.equal(
      200,
    );
    return res.json();
  }

  /** The password step of a user without an authenticator: the challenge of the setup-code step. */
  async function setupChallenge(email) {
    const step1 = await passwordStep(email);
    expect(step1.next, 'the step after the password').to.equal('setup-code');
    return step1.challenge;
  }

  /** Sign-in step 2 of a user without an authenticator: the setup code. */
  function sendSetupCode(challenge, setupCode, ip = '203.0.113.10') {
    return app.inject({
      method: 'POST',
      url: '/auth/setup-code',
      payload: {challenge, setupCode},
      headers: {'x-forwarded-for': ip},
    });
  }

  /** An authenticator code on a challenge. */
  function sendCode(challenge, code) {
    return app.inject({
      method: 'POST',
      url: '/auth/mfa',
      payload: {challenge, code},
    });
  }

  /** The setup-code step accepted: the QR step's challenge and secret. */
  async function qrStep(email, setupCode) {
    const res = await sendSetupCode(await setupChallenge(email), setupCode);
    expect(res.statusCode, `setup code of ${email}: ${res.body}`).to.equal(200);
    expect(res.json().next).to.equal('mfa-enroll');
    return res.json();
  }

  /** The whole setup: password, setup code, authenticator code. Returns the secret. */
  async function setUp(email, setupCode) {
    const step = await qrStep(email, setupCode);
    const res = await sendCode(step.challenge, codeFor(step.secret, clock));
    expect(res.statusCode, `enrolment of ${email}: ${res.body}`).to.equal(200);
    return step.secret;
  }

  /** Gives `email` an authenticator directly in the store, as an earlier enrolment left it. */
  async function enrolDirectly(email) {
    const secret = generateSecret();
    await repo.updateUser(await idOf(email), {
      mfaEnrolled: true,
      mfaSecret: secret,
      pendingMfaSecret: null,
    });
    return secret;
  }

  /** Password and authenticator code, as today: the refresh cookie's value. */
  async function signInWithCode(email, secret) {
    const step1 = await passwordStep(email);
    expect(step1.next).to.equal('mfa');
    const res = await sendCode(step1.challenge, codeFor(secret, clock));
    expect(res.statusCode, res.body).to.equal(200);
    return {
      token: res.json().accessToken,
      cookie: res.cookies.find(c => c.name === 'lrfe_rt').value,
    };
  }

  /** A refresh with the refresh cookie's value. */
  function refresh(cookie) {
    return app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: {lrfe_rt: cookie},
    });
  }

  return {
    ...ctx,
    admin,
    officer,
    adminUser,
    idOf,
    adminPost,
    giveCode,
    resetTwoFactor,
    passwordStep,
    setupChallenge,
    sendSetupCode,
    sendCode,
    qrStep,
    setUp,
    enrolDirectly,
    signInWithCode,
    refresh,
  };
}

/** A setup-code step that was refused: 401, no secret, no QR link, no session. */
function expectSetupRefused(res, status = 401) {
  expect(res.statusCode, res.body).to.equal(status);
  const body = res.json();
  expect(body).to.not.have.property('secret');
  expect(body).to.not.have.property('otpauthUrl');
  expect(body).to.not.have.property('accessToken');
  expect(res.cookies.find(c => c.name === 'lrfe_rt')).to.equal(undefined);
}

/** A step refused because the user's code step is locked (CB-101): 429, saying when to retry. */
function expectLocked(res) {
  expectSetupRefused(res, 429);
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

/** A setup code of the right shape that no administrator gave. */
function unknownCode(...given) {
  for (const candidate of ['ABCD-EFGH', 'WXYZ-2345', 'MNPQ-6789']) {
    if (!given.includes(candidate)) {
      return candidate;
    }
  }
  throw new Error('no unknown code left');
}

/**
 * A store that records every call that may write (every method not named get… or list…), with
 * its arguments, so a test can tell what was handed to the store.
 * @param {!Object} repo
 * @return {{repo: !Object, writes: !Array<string>}}
 */
function recordingRepo(repo) {
  const writes = [];
  const proxy = new Proxy(repo, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function' || /^(get|list)/.test(String(name))) {
        return value;
      }
      return (...args) => {
        writes.push(`${String(name)} ${JSON.stringify(args)}`);
        return value.apply(target, args);
      };
    },
  });
  return {repo: proxy, writes};
}

describe('authenticator setup with a one-time setup code (CB-102)', () => {
  describe('the setup code an administrator gets', () => {
    it('"Reset 2FA" answers with a one-time setup code shaped XXXX-XXXX', async () => {
      const {resetTwoFactor, enrolDirectly} = await setupApp();
      await enrolDirectly(SCAN);
      expect(await resetTwoFactor(SCAN)).to.match(SETUP_CODE_SHAPE);
    });

    it('"Give setup code" answers with a one-time setup code shaped XXXX-XXXX for a user without an authenticator', async () => {
      const {giveCode} = await setupApp();
      expect(await giveCode(SCAN)).to.match(SETUP_CODE_SHAPE);
    });

    it('setup codes never use look-alike characters (0, O, 1, I, L) and do not repeat', async () => {
      const {giveCode} = await setupApp();
      const codes = [];
      for (let i = 0; i < 150; i++) {
        codes.push(await giveCode(i % 2 ? SCAN : REVIEWER));
      }
      for (const code of codes) {
        expect(code).to.match(SETUP_CODE_SHAPE);
        expect(code, code).to.not.match(LOOK_ALIKES);
      }
      expect(new Set(codes).size).to.equal(codes.length);
    });

    it('the code is shown once only: the user list and the access log never contain it', async () => {
      const {app, admin, auth, giveCode} = await setupApp();
      const setupCode = await giveCode(SCAN);
      const users = await app.inject({
        method: 'GET',
        url: '/users',
        headers: auth(admin.token),
      });
      expect(users.statusCode).to.equal(200);
      expectNoCode(users.body, setupCode, 'the user list');
      const log = await app.inject({
        method: 'GET',
        url: '/access-log?limit=200',
        headers: auth(admin.token),
      });
      expect(log.statusCode).to.equal(200);
      expectNoCode(log.body, setupCode, 'the access log');
    });

    for (const route of ['setup-code', 'mfa-reset']) {
      it(`only an administrator may use POST /users/:id/${route}: 403 for an officer, 401 without sign-in`, async () => {
        const {app, repo, officer, idOf, adminPost, enrolDirectly} =
          await setupApp();
        await enrolDirectly(SCAN);
        const url = `/users/${await idOf(SCAN)}/${route}`;
        const asOfficer = await adminPost(url, officer.token);
        expect(asOfficer.statusCode, asOfficer.body).to.equal(403);
        expect(asOfficer.json()).to.not.have.property('setupCode');
        const anonymous = await app.inject({method: 'POST', url});
        expect(anonymous.statusCode).to.equal(401);
        expect(anonymous.json()).to.not.have.property('setupCode');
        // nothing changed: the user keeps the authenticator
        expect((await repo.getUserByEmail(SCAN)).mfaEnrolled).to.equal(true);
      });

      it(`POST /users/:id/${route} of an unknown user is 404, of a malformed id 400`, async () => {
        const {adminPost} = await setupApp();
        const unknown = await adminPost(
          `/users/00000000-0000-4000-8000-000000000000/${route}`,
        );
        expect(unknown.statusCode, unknown.body).to.equal(404);
        expect(unknown.json()).to.not.have.property('setupCode');
        const malformed = await adminPost(`/users/toString/${route}`);
        expect(malformed.statusCode, malformed.body).to.equal(400);
      });
    }
  });

  describe('signing in without an authenticator', () => {
    it('the password alone leads to "Enter your setup code", with no authenticator secret or QR link', async () => {
      const {passwordStep} = await setupApp();
      const body = await passwordStep(SCAN);
      expect(body.next).to.equal('setup-code');
      expect(body.challenge).to.be.a('string');
      expect(body).to.not.have.property('secret');
      expect(body).to.not.have.property('otpauthUrl');
      expect(body).to.not.have.property('accessToken');
      expect(JSON.stringify(body)).to.not.match(/otpauth/i);
    });

    it('the password alone never enrols: an authenticator code on the password step is refused, even for a secret handed out before', async () => {
      const {repo, clock, idOf, setupChallenge, sendCode} = await setupApp();
      // a secret shown at a password-only sign-in before CB-102, still pending on the user
      const oldSecret = generateSecret();
      await repo.updateUser(await idOf(SCAN), {pendingMfaSecret: oldSecret});
      const challenge = await setupChallenge(SCAN);
      const res = await sendCode(challenge, codeFor(oldSecret, clock));
      expect(res.statusCode, res.body).to.equal(401);
      expect(res.json()).to.not.have.property('accessToken');
      expect((await repo.getUserByEmail(SCAN)).mfaEnrolled).to.not.equal(true);
    });

    it('the right setup code leads to the authenticator step: a secret, its QR link and a challenge', async () => {
      const {giveCode, setupChallenge, sendSetupCode} = await setupApp();
      const setupCode = await giveCode(SCAN);
      const res = await sendSetupCode(await setupChallenge(SCAN), setupCode);
      expect(res.statusCode, res.body).to.equal(200);
      const body = res.json();
      expect(body.next).to.equal('mfa-enroll');
      expect(body.secret).to.match(/^[A-Z2-7]{16,}$/);
      expect(body.otpauthUrl).to.match(/^otpauth:\/\/totp\//);
      expect(body.otpauthUrl).to.include(`secret=${body.secret}`);
      expect(body.challenge).to.be.a('string');
      expect(body).to.not.have.property('accessToken');
    });

    it('the authenticator code then sets up the authenticator and signs in', async () => {
      const {repo, clock, giveCode, qrStep, sendCode} = await setupApp();
      const step = await qrStep(SCAN, await giveCode(SCAN));
      const res = await sendCode(step.challenge, codeFor(step.secret, clock));
      expect(res.statusCode, res.body).to.equal(200);
      expect(res.json().accessToken).to.be.a('string');
      expect(res.cookies.find(c => c.name === 'lrfe_rt')).to.not.equal(
        undefined,
      );
      expect((await repo.getUserByEmail(SCAN)).mfaEnrolled).to.equal(true);
      const {items} = await repo.listAccessEvents({kind: 'user'});
      expect(items.some(e => e.action === 'MFA enrolled')).to.equal(true);
    });

    it('a wrong authenticator code at that step is refused and sets nothing up', async () => {
      const {repo, clock, giveCode, qrStep, sendCode} = await setupApp();
      const step = await qrStep(SCAN, await giveCode(SCAN));
      const res = await sendCode(
        step.challenge,
        wrongCodeFor(step.secret, clock),
      );
      expect(res.statusCode, res.body).to.equal(401);
      expect((await repo.getUserByEmail(SCAN)).mfaEnrolled).to.not.equal(true);
    });

    it('once set up, the next sign-in asks for the authenticator code, never for a setup code', async () => {
      const {giveCode, setUp, signInWithCode} = await setupApp();
      const secret = await setUp(SCAN, await giveCode(SCAN));
      const {token} = await signInWithCode(SCAN, secret);
      expect(token).to.be.a('string');
    });

    it('a user with an authenticator signs in with password and code as before', async () => {
      const {enrolDirectly, signInWithCode} = await setupApp();
      const secret = await enrolDirectly(SCAN);
      const {token, cookie} = await signInWithCode(SCAN, secret);
      expect(token).to.be.a('string');
      expect(cookie).to.be.a('string');
    });

    it('when two-factor sign-in is not required, a user without an authenticator signs in with the password as today', async () => {
      const {passwordStep} = await setupApp({mfa: false});
      const body = await passwordStep(SCAN);
      expect(body.accessToken).to.be.a('string');
      expect(body).to.not.have.property('secret');
    });
  });

  describe('refused setup codes', () => {
    it('a wrong setup code is refused with 401 and gives no secret', async () => {
      const {giveCode, setupChallenge, sendSetupCode} = await setupApp();
      const given = await giveCode(SCAN);
      expectSetupRefused(
        await sendSetupCode(await setupChallenge(SCAN), unknownCode(given)),
      );
    });

    for (const bad of [
      '',
      'toString',
      '__proto__',
      'constructor',
      '0000-0000',
      'X'.repeat(500),
      12345678,
      null,
    ]) {
      const shown = typeof bad === 'string' ? `"${bad.slice(0, 12)}"` : bad;
      it(`a setup code of ${shown} is refused (400 or 401) and gives no secret`, async () => {
        const {giveCode, setupChallenge, sendSetupCode} = await setupApp();
        await giveCode(SCAN);
        const res = await sendSetupCode(await setupChallenge(SCAN), bad);
        expect(res.statusCode, res.body).to.be.oneOf([400, 401]);
        expectSetupRefused(res, res.statusCode);
      });
    }

    it("another user's setup code is refused", async () => {
      const {giveCode, setupChallenge, sendSetupCode} = await setupApp();
      await giveCode(SCAN);
      const reviewersCode = await giveCode(REVIEWER);
      expectSetupRefused(
        await sendSetupCode(await setupChallenge(SCAN), reviewersCode),
      );
    });

    it("a challenge changed to name another user is refused, even with that user's code", async () => {
      const {idOf, giveCode, setupChallenge, sendSetupCode} = await setupApp();
      const reviewersCode = await giveCode(REVIEWER);
      const forged = tamperedChallenge(await setupChallenge(SCAN), {
        sub: await idOf(REVIEWER),
      });
      const res = await sendSetupCode(forged, reviewersCode);
      expectSetupRefused(res);
      expect(res.json().message).to.equal('Sign-in expired, start again');
    });

    it('a challenge that is not one is refused', async () => {
      const {giveCode, sendSetupCode} = await setupApp();
      const setupCode = await giveCode(SCAN);
      expectSetupRefused(await sendSetupCode('not-a-challenge', setupCode));
    });

    it('a user who already has an authenticator cannot use the setup-code step', async () => {
      const {giveCode, enrolDirectly, passwordStep, sendSetupCode} =
        await setupApp();
      const setupCode = await giveCode(SCAN);
      await enrolDirectly(SCAN);
      const step1 = await passwordStep(SCAN);
      expect(step1.next).to.equal('mfa');
      expectSetupRefused(await sendSetupCode(step1.challenge, setupCode));
    });
  });

  describe('one use', () => {
    it('after the authenticator is set up, the same setup code is refused, even on the same sign-in', async () => {
      const {clock, giveCode, setupChallenge, sendSetupCode, sendCode} =
        await setupApp();
      const setupCode = await giveCode(SCAN);
      const challenge = await setupChallenge(SCAN);
      const step = (await sendSetupCode(challenge, setupCode)).json();
      expect(step.next).to.equal('mfa-enroll');
      const enrolled = await sendCode(
        step.challenge,
        codeFor(step.secret, clock),
      );
      expect(enrolled.statusCode, enrolled.body).to.equal(200);
      expectSetupRefused(await sendSetupCode(challenge, setupCode));
    });

    it('two sign-ins racing with the same setup code set up one authenticator at most', async () => {
      const {repo, clock, giveCode, setupChallenge, sendSetupCode, sendCode} =
        await setupApp();
      const setupCode = await giveCode(SCAN);
      const challenges = [
        await setupChallenge(SCAN),
        await setupChallenge(SCAN),
      ];
      const steps = await Promise.all(
        challenges.map(c => sendSetupCode(c, setupCode)),
      );
      const accepted = steps
        .filter(r => r.statusCode === 200)
        .map(r => r.json());
      expect(accepted.length).to.be.at.least(1);
      const enrolments = await Promise.all(
        accepted.map(s => sendCode(s.challenge, codeFor(s.secret, clock))),
      );
      const winners = accepted.filter(
        (s, i) => enrolments[i].statusCode === 200,
      );
      expect(winners.length).to.equal(1);
      const user = await repo.getUserByEmail(SCAN);
      expect(user.mfaEnrolled).to.equal(true);
      expect(user.mfaSecret).to.equal(winners[0].secret);
      // and the code is used up
      expectSetupRefused(await sendSetupCode(challenges[0], setupCode));
    });
  });

  describe('valid for 72 hours, a site setting', () => {
    it('is accepted 71 h 59 min after it was given', async () => {
      const {clock, giveCode, setupChallenge, sendSetupCode} = await setupApp();
      const setupCode = await giveCode(SCAN);
      clock.advance(72 * HOUR - MINUTE);
      const res = await sendSetupCode(await setupChallenge(SCAN), setupCode);
      expect(res.statusCode, res.body).to.equal(200);
    });

    it('is refused 72 h 01 min after it was given', async () => {
      const {clock, giveCode, setupChallenge, sendSetupCode} = await setupApp();
      const setupCode = await giveCode(SCAN);
      clock.advance(72 * HOUR + MINUTE);
      expectSetupRefused(
        await sendSetupCode(await setupChallenge(SCAN), setupCode),
      );
    });

    it('follows the setting: with 24 hours, accepted at 23 h 59 and refused at 24 h 01', async () => {
      const {clock, giveCode, setupChallenge, sendSetupCode} = await setupApp({
        config: {setupCodeTtlHours: 24},
      });
      const early = await giveCode(SCAN);
      clock.advance(24 * HOUR - MINUTE);
      const ok = await sendSetupCode(await setupChallenge(SCAN), early);
      expect(ok.statusCode, ok.body).to.equal(200);

      const late = await giveCode(REVIEWER);
      clock.advance(24 * HOUR + MINUTE);
      expectSetupRefused(
        await sendSetupCode(await setupChallenge(REVIEWER), late),
      );
    });
  });

  describe('a new code voids the previous one', () => {
    it('a second "Give setup code" voids the first code', async () => {
      const {giveCode, setupChallenge, sendSetupCode, setUp} = await setupApp();
      const first = await giveCode(SCAN);
      const second = await giveCode(SCAN);
      expect(second).to.not.equal(first);
      expectSetupRefused(
        await sendSetupCode(await setupChallenge(SCAN), first),
      );
      await setUp(SCAN, second);
    });

    it('a "Reset 2FA" voids a code given before', async () => {
      const {giveCode, resetTwoFactor, setupChallenge, sendSetupCode, setUp} =
        await setupApp();
      const given = await giveCode(SCAN);
      const fromReset = await resetTwoFactor(SCAN);
      expectSetupRefused(
        await sendSetupCode(await setupChallenge(SCAN), given),
      );
      await setUp(SCAN, fromReset);
    });

    it("a new code for one user leaves another user's code working", async () => {
      const {giveCode, setUp} = await setupApp();
      const reviewersCode = await giveCode(REVIEWER);
      await giveCode(SCAN);
      await giveCode(SCAN);
      await setUp(REVIEWER, reviewersCode);
    });
  });

  describe('stored only as a hash', () => {
    it('no write to the store carries the plain setup code, in any form', async () => {
      const recorded = recordingRepo(createMemoryRepo());
      const {giveCode, resetTwoFactor, enrolDirectly, setUp} = await setupApp({
        repo: recorded.repo,
      });
      const given = await giveCode(REVIEWER);
      await enrolDirectly(SCAN);
      const fromReset = await resetTwoFactor(SCAN);
      await setUp(SCAN, fromReset);
      const writes = recorded.writes.join('\n');
      expect(writes.length).to.be.greaterThan(0);
      expectNoCode(writes, given, 'the store');
      expectNoCode(writes, fromReset, 'the store');
    });
  });

  describe("the administrator's reset", () => {
    it("ends all of the user's sessions", async () => {
      const {enrolDirectly, signInWithCode, resetTwoFactor, refresh} =
        await setupApp();
      const secret = await enrolDirectly(SCAN);
      const first = await signInWithCode(SCAN, secret);
      const second = await signInWithCode(SCAN, secret);
      await resetTwoFactor(SCAN);
      for (const session of [first, second]) {
        const res = await refresh(session.cookie);
        expect(res.statusCode, res.body).to.equal(401);
        expect(res.json()).to.not.have.property('accessToken');
      }
    });

    it("refuses the user's access tokens at once, not only when they expire", async () => {
      const {app, auth, enrolDirectly, signInWithCode, resetTwoFactor} =
        await setupApp({clock: () => new Date()});
      const secret = await enrolDirectly(SCAN);
      const {token} = await signInWithCode(SCAN, secret);
      const before = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: auth(token),
      });
      expect(before.statusCode).to.equal(200);
      await resetTwoFactor(SCAN);
      const after = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: auth(token),
      });
      expect(after.statusCode).to.equal(401);
    });

    it("leaves other users' sessions running", async () => {
      const {enrolDirectly, signInWithCode, refresh, adminPost, idOf} =
        await setupApp();
      const secret = await enrolDirectly(SCAN);
      const otherSecret = await enrolDirectly(OTHER_SCAN);
      await signInWithCode(SCAN, secret);
      const other = await signInWithCode(OTHER_SCAN, otherSecret);
      const reset = await adminPost(`/users/${await idOf(SCAN)}/mfa-reset`);
      expect(reset.statusCode).to.equal(200);
      const res = await refresh(other.cookie);
      expect(res.statusCode, res.body).to.equal(200);
    });

    it('the old authenticator stops working: the next sign-in asks for a setup code and refuses its codes', async () => {
      const {clock, enrolDirectly, resetTwoFactor, setupChallenge, sendCode} =
        await setupApp();
      const oldSecret = await enrolDirectly(SCAN);
      await resetTwoFactor(SCAN);
      const challenge = await setupChallenge(SCAN);
      const res = await sendCode(challenge, codeFor(oldSecret, clock));
      expect(res.statusCode, res.body).to.equal(401);
      expect(res.json()).to.not.have.property('accessToken');
    });

    it('is written to the access log naming who reset whom, without the code', async () => {
      const {repo, adminUser, enrolDirectly, resetTwoFactor} = await setupApp();
      await enrolDirectly(SCAN);
      const setupCode = await resetTwoFactor(SCAN);
      const scan = await repo.getUserByEmail(SCAN);
      const {items} = await repo.listAccessEvents({limit: 200});
      const entry = items.find(
        e => e.target === scan.name && /reset/i.test(e.action),
      );
      expect(entry, 'the reset in the access log').to.not.equal(undefined);
      expect(entry.actor).to.equal(adminUser.name);
      expectNoCode(JSON.stringify(items), setupCode, 'the access log');
    });

    it('"Give setup code" is written to the access log naming the administrator and the user, without the code', async () => {
      const {repo, adminUser, giveCode} = await setupApp();
      const setupCode = await giveCode(SCAN);
      const scan = await repo.getUserByEmail(SCAN);
      const {items} = await repo.listAccessEvents({limit: 200});
      const entry = items.find(
        e => e.target === scan.name && e.actor === adminUser.name,
      );
      expect(entry, 'the setup code given, in the access log').to.not.equal(
        undefined,
      );
      expectNoCode(JSON.stringify(items), setupCode, 'the access log');
    });
  });

  describe('wrong setup codes count towards the lockout of wrong codes (CB-101)', () => {
    /** Ten wrong setup codes for `email`, five per sign-in, each from another address. */
    async function tenWrongSetupCodes(ctx, email, given) {
      for (let round = 0; round < 2; round++) {
        const challenge = await ctx.setupChallenge(email);
        for (let i = 0; i < 5; i++) {
          const res = await ctx.sendSetupCode(
            challenge,
            unknownCode(given),
            `203.0.113.${round * 5 + i + 1}`,
          );
          expect(res.statusCode, res.body).to.be.oneOf([401, 429]);
        }
      }
    }

    it('ten wrong setup codes, from any addresses, lock the step: the right code is then refused with 429', async () => {
      const ctx = await setupApp();
      const setupCode = await ctx.giveCode(SCAN);
      await tenWrongSetupCodes(ctx, SCAN, setupCode);
      expectLocked(
        await ctx.sendSetupCode(await ctx.setupChallenge(SCAN), setupCode),
      );
    });

    it('when the lockout has ended, the right setup code works', async () => {
      const ctx = await setupApp();
      const setupCode = await ctx.giveCode(SCAN);
      await tenWrongSetupCodes(ctx, SCAN, setupCode);
      ctx.clock.advance(15 * MINUTE + 1000);
      await ctx.setUp(SCAN, setupCode);
    });

    it("the lockout is per user: another user's right setup code still works", async () => {
      const ctx = await setupApp();
      const scanCode = await ctx.giveCode(SCAN);
      const reviewersCode = await ctx.giveCode(REVIEWER);
      await tenWrongSetupCodes(ctx, SCAN, scanCode);
      await ctx.setUp(REVIEWER, reviewersCode);
    });

    it('nine wrong setup codes do not lock: the right one still works', async () => {
      const ctx = await setupApp();
      const setupCode = await ctx.giveCode(SCAN);
      for (let i = 0; i < 9; i++) {
        const challenge = await ctx.setupChallenge(SCAN);
        expectSetupRefused(
          await ctx.sendSetupCode(challenge, unknownCode(setupCode)),
        );
      }
      await ctx.setUp(SCAN, setupCode);
    });

    it('each wrong setup code and the lockout are written to the access log, naming the user', async () => {
      const ctx = await setupApp();
      const setupCode = await ctx.giveCode(SCAN);
      const scan = await ctx.repo.getUserByEmail(SCAN);
      await tenWrongSetupCodes(ctx, SCAN, setupCode);
      const {items} = await ctx.repo.listAccessEvents({
        kind: 'denied',
        limit: 200,
      });
      const mine = items.filter(e => e.target === scan.name);
      expect(mine.length).to.be.at.least(11);
      expect(mine.some(e => /locked/i.test(e.action))).to.equal(true);
    });
  });

  describe('the code is never written to any log', () => {
    it('a whole journey leaves the code out of the app log, the console, the access log, the events and every email', async () => {
      const lines = [];
      const stream = {write: line => lines.push(String(line))};
      const mailer = recordingMailer();
      const consoleLines = [];
      const saved = {};
      for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        saved[method] = console[method];
        console[method] = (...args) => consoleLines.push(args.join(' '));
      }
      let codes;
      let ctx;
      try {
        ctx = await setupApp({mailer, logger: {level: 'trace', stream}});
        const given = await ctx.giveCode(REVIEWER);
        await ctx.enrolDirectly(SCAN);
        const fromReset = await ctx.resetTwoFactor(SCAN);
        // a wrong try, then the right one
        await ctx.sendSetupCode(
          await ctx.setupChallenge(SCAN),
          unknownCode(given, fromReset),
        );
        await ctx.setUp(SCAN, fromReset);
        await ctx.setUp(REVIEWER, given);
        codes = [given, fromReset];
      } finally {
        Object.assign(console, saved);
      }
      expect(lines.length, 'the app wrote its log').to.be.greaterThan(0);
      const {items} = await ctx.repo.listAccessEvents({limit: 200});
      for (const code of codes) {
        expectNoCode(lines.join('\n'), code, 'the app log');
        expectNoCode(consoleLines.join('\n'), code, 'the console');
        expectNoCode(JSON.stringify(items), code, 'the access log');
        expectNoCode(JSON.stringify(ctx.published), code, 'the events');
        expectNoCode(JSON.stringify(mailer.sent), code, 'the emails');
      }
    });
  });

  describe('the email notice "A new authenticator was added to your account"', () => {
    it('is emailed to the user after the authenticator is set up with a setup code, without the code or the secret', async () => {
      const mailer = recordingMailer();
      const {giveCode, setUp} = await setupApp({mailer});
      const setupCode = await giveCode(SCAN);
      const secret = await setUp(SCAN, setupCode);
      const notices = mailer.sent.filter(m =>
        NOTICE.test(`${m.subject}\n${m.text}\n${m.html}`),
      );
      expect(notices.length).to.equal(1);
      expect(notices[0].to).to.equal(SCAN);
      expectNoCode(JSON.stringify(notices[0]), setupCode, 'the notice');
      expect(JSON.stringify(notices[0])).to.not.include(secret);
    });

    it('is emailed each time an authenticator is added: again after a reset', async () => {
      const mailer = recordingMailer();
      const {giveCode, resetTwoFactor, setUp} = await setupApp({mailer});
      await setUp(SCAN, await giveCode(SCAN));
      await setUp(SCAN, await resetTwoFactor(SCAN));
      const notices = mailer.sent.filter(
        m => m.to === SCAN && NOTICE.test(`${m.subject}\n${m.text}`),
      );
      expect(notices.length).to.equal(2);
    });

    it('is not emailed for a wrong code, a wrong setup code or a code given', async () => {
      const mailer = recordingMailer();
      const {clock, giveCode, setupChallenge, sendSetupCode, qrStep, sendCode} =
        await setupApp({mailer});
      const setupCode = await giveCode(SCAN);
      await sendSetupCode(await setupChallenge(SCAN), unknownCode(setupCode));
      const step = await qrStep(SCAN, setupCode);
      await sendCode(step.challenge, wrongCodeFor(step.secret, clock));
      const notices = mailer.sent.filter(m =>
        NOTICE.test(`${m.subject}\n${m.text}`),
      );
      expect(notices).to.deep.equal([]);
    });

    it('a mail failure does not block: the sign-in goes through', async () => {
      const mailer = {
        enabled: true,
        async send() {
          throw new Error('connect ECONNREFUSED 127.0.0.1:25');
        },
      };
      const {repo, giveCode, setUp} = await setupApp({mailer});
      await setUp(SCAN, await giveCode(SCAN));
      expect((await repo.getUserByEmail(SCAN)).mfaEnrolled).to.equal(true);
    });

    it('nothing waits for the mail: a mail server that never answers does not hold up the sign-in', async function () {
      this.timeout(10_000);
      const mailer = {
        enabled: true,
        send: () => new Promise(() => {}),
      };
      const {clock, giveCode, qrStep, sendCode} = await setupApp({mailer});
      const step = await qrStep(SCAN, await giveCode(SCAN));
      const answer = sendCode(step.challenge, codeFor(step.secret, clock));
      const late = new Promise(resolve =>
        setTimeout(() => resolve('no answer within 3 s'), 3000),
      );
      const res = await Promise.race([answer, late]);
      expect(res, 'the sign-in answered').to.not.be.a('string');
      expect(res.statusCode, res.body).to.equal(200);
    });

    it('with email not configured, the setup still goes through', async () => {
      const mailer = {
        enabled: false,
        async send() {
          throw new Error('email is not configured');
        },
      };
      const {repo, giveCode, setUp} = await setupApp({mailer});
      await setUp(SCAN, await giveCode(SCAN));
      expect((await repo.getUserByEmail(SCAN)).mfaEnrolled).to.equal(true);
    });
  });

  describe('new users set up the authenticator while accepting the invitation', () => {
    /** Invites a reviewer; returns the invitation token and the new user's email. */
    async function invited(ctx, label = 'n') {
      const email = `${label}.shikongo@deeds.gov.na`;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/users',
        headers: ctx.auth(ctx.admin.token),
        payload: {
          name: `Nangula Shikongo ${label}`,
          email,
          officeId: ctx.office.id,
          roles: ['rev'],
        },
      });
      expect(res.statusCode, res.body).to.equal(201);
      const token = new URL(
        res.json().inviteUrl.replace('/#/', '/'),
      ).searchParams.get('token');
      return {email, token};
    }

    /** POST /invitations/accept with `payload`. */
    function accept(ctx, payload) {
      return ctx.app.inject({
        method: 'POST',
        url: '/invitations/accept',
        payload,
      });
    }

    /** Step 1 of the invitation with two-factor sign-in required: the authenticator secret. */
    async function passwordChosen(ctx, token) {
      const res = await accept(ctx, {token, password: NEW_PASSWORD});
      expect(res.statusCode, res.body).to.equal(200);
      expect(res.json().secret, 'the authenticator secret').to.be.a('string');
      return res.json().secret;
    }

    /** A password-step sign-in that must be refused. */
    async function expectSignInRefused(ctx, email, password) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {email, password},
      });
      expect(res.statusCode, res.body).to.equal(401);
    }

    it('choosing the password gives the authenticator secret and QR link, and the account is not active yet', async () => {
      const ctx = await setupApp();
      const {email, token} = await invited(ctx);
      const res = await accept(ctx, {token, password: NEW_PASSWORD});
      expect(res.statusCode, res.body).to.equal(200);
      expect(res.json().next).to.equal('mfa-enroll');
      expect(res.json().secret).to.match(/^[A-Z2-7]{16,}$/);
      expect(res.json().otpauthUrl).to.match(/^otpauth:\/\/totp\//);
      expect((await ctx.repo.getUserByEmail(email)).status).to.equal('Invited');
      await expectSignInRefused(ctx, email, NEW_PASSWORD);
    });

    it('the right authenticator code activates the account with the authenticator set up', async () => {
      const ctx = await setupApp();
      const {email, token} = await invited(ctx);
      const secret = await passwordChosen(ctx, token);
      const res = await accept(ctx, {
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, ctx.clock),
      });
      expect(res.statusCode, res.body).to.equal(200);
      const user = await ctx.repo.getUserByEmail(email);
      expect(user.status).to.equal('Active');
      expect(user.mfaEnrolled).to.equal(true);
      // the next sign-in asks for the authenticator code, not a setup code
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {email, password: NEW_PASSWORD},
      });
      expect(login.json().next).to.equal('mfa');
      const signedIn = await ctx.sendCode(
        login.json().challenge,
        codeFor(secret, ctx.clock),
      );
      expect(signedIn.statusCode, signedIn.body).to.equal(200);
    });

    it('a wrong authenticator code is refused: the account stays invited and the link still works', async () => {
      const ctx = await setupApp();
      const {email, token} = await invited(ctx);
      const secret = await passwordChosen(ctx, token);
      const wrong = await accept(ctx, {
        token,
        password: NEW_PASSWORD,
        code: wrongCodeFor(secret, ctx.clock),
      });
      expect(wrong.statusCode, wrong.body).to.be.oneOf([400, 401]);
      expect((await ctx.repo.getUserByEmail(email)).status).to.equal('Invited');
      const right = await accept(ctx, {
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, ctx.clock),
      });
      expect(right.statusCode, right.body).to.equal(200);
    });

    it('the link is used up once the account is active', async () => {
      const ctx = await setupApp();
      const {token} = await invited(ctx);
      const secret = await passwordChosen(ctx, token);
      await accept(ctx, {
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, ctx.clock),
      });
      const again = await accept(ctx, {token, password: NEW_PASSWORD});
      expect(again.statusCode).to.equal(400);
      expect(again.json().message).to.include(
        'This invitation is invalid or has expired',
      );
      expect(again.json()).to.not.have.property('secret');
    });

    it('an expired link is refused at the authenticator step too', async () => {
      const ctx = await setupApp();
      const {email, token} = await invited(ctx);
      const secret = await passwordChosen(ctx, token);
      ctx.clock.advance(72 * HOUR + MINUTE);
      const late = await accept(ctx, {
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, ctx.clock),
      });
      expect(late.statusCode).to.equal(400);
      expect((await ctx.repo.getUserByEmail(email)).status).to.equal('Invited');
    });

    it('the notice "A new authenticator was added to your account" is emailed after activation too', async () => {
      const mailer = recordingMailer();
      const ctx = await setupApp({mailer});
      const {email, token} = await invited(ctx);
      const secret = await passwordChosen(ctx, token);
      await accept(ctx, {
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, ctx.clock),
      });
      const notices = mailer.sent.filter(
        m => m.to === email && NOTICE.test(`${m.subject}\n${m.text}`),
      );
      expect(notices.length).to.equal(1);
    });

    it('when two-factor sign-in is not required, choosing the password activates the account as today', async () => {
      const ctx = await setupApp({mfa: false});
      const {email, token} = await invited(ctx);
      const res = await accept(ctx, {token, password: NEW_PASSWORD});
      expect(res.statusCode, res.body).to.equal(200);
      expect(res.json().email).to.equal(email);
      expect(res.json()).to.not.have.property('secret');
      expect((await ctx.repo.getUserByEmail(email)).status).to.equal('Active');
    });
  });

  describe('the codes printed on the console and the setting (added by the builder)', () => {
    const ADMIN_EMAIL = 'first.admin@example.org';

    it('the seed names the first administrator and the active demo users it creates, once, for their printed setup codes', async () => {
      const repo = createMemoryRepo();
      const first = await seedIdentity(repo, {
        admin: {name: 'First admin', email: ADMIN_EMAIL, password: PASSWORD},
        demoPassword: PASSWORD,
      });
      const emails = first.created.map(u => u.email);
      expect(emails).to.include(ADMIN_EMAIL);
      expect(emails).to.include(SCAN);
      // invited demo users set up their authenticator with their invitation
      for (const user of await repo.listUsers()) {
        expect(emails.includes(user.email), user.email).to.equal(
          user.status === 'Active',
        );
      }
      const again = await seedIdentity(repo, {
        admin: {name: 'First admin', email: ADMIN_EMAIL, password: PASSWORD},
        demoPassword: PASSWORD,
      });
      expect(again.created).to.deep.equal([]);
    });

    it("the end-to-end tests' key sets up the demo users' authenticators directly, so no code is needed", async () => {
      const repo = createMemoryRepo();
      const {created} = await seedIdentity(repo, {
        demoPassword: PASSWORD,
        demoMfaKey: 'a test key',
      });
      expect(created).to.deep.equal([]);
      const scan = await repo.getUserByEmail(SCAN);
      expect(scan.mfaEnrolled).to.equal(true);
      expect(scan.mfaSecret).to.equal(demoMfaSecret('a test key', SCAN));
      expect(scan.mfaSecret).to.match(/^[A-Z2-7]{32}$/);
      expect(demoMfaSecret('a test key', REVIEWER)).to.not.equal(
        scan.mfaSecret,
      );
    });

    it('a code issued for the console works once at sign-in, and its line holds the code and its validity', async () => {
      const ctx = await setupApp();
      const {setupCode} = await issueSetupCode(ctx.repo, await ctx.idOf(SCAN), {
        now: ctx.clock(),
        ttlHours: 72,
      });
      expect(setupCodeLine(SCAN, setupCode, 72)).to.equal(
        `Setup code for ${SCAN}: ${setupCode} (sets up the authenticator at the next sign-in; one use, valid for 72 hours)`,
      );
      await ctx.setUp(SCAN, setupCode);
      expectSetupRefused(
        await ctx.sendSetupCode(await ctx.setupChallenge(REVIEWER), setupCode),
      );
    });

    it('SETUP_CODE_TTL_HOURS is documented with its default (72) and passed on by the compose install', () => {
      const repoDir = new URL('../../../../', import.meta.url);
      const docs = ['backend/README.md', 'deploy/README.md']
        .map(path => readFileSync(new URL(path, repoDir), 'utf8'))
        .join('\n');
      const lines = docs
        .split('\n')
        .filter(line => line.includes('SETUP_CODE_TTL_HOURS'));
      expect(lines, 'a line documenting SETUP_CODE_TTL_HOURS').to.not.be.empty;
      expect(lines.join('\n')).to.include('72');
      const compose = readFileSync(
        new URL('deploy/docker-compose.yml', repoDir),
        'utf8',
      );
      expect(compose).to.match(
        /^\s+SETUP_CODE_TTL_HOURS: \$\{SETUP_CODE_TTL_HOURS:-72\}/m,
      );
    });
  });

  // Runs only with a throwaway PostgreSQL database: IDENTITY_TEST_DATABASE_URL (its identity schema
  // is dropped and made again for each test).
  const pgUrl = process.env.IDENTITY_TEST_DATABASE_URL;
  (pgUrl ? describe : describe.skip)('on PostgreSQL', function () {
    this.timeout(60_000);
    let sequelize;
    before(() => {
      sequelize = new Sequelize(pgUrl, {logging: false});
    });
    after(() => sequelize.close());

    async function freshRepo() {
      await sequelize.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await ensureSchema(sequelize, SCHEMA);
      const repo = createSequelizeRepo(sequelize);
      await repo.sync();
      return repo;
    }

    /** Every row of every table of the identity schema, as text. */
    async function everyRow() {
      const [tables] = await sequelize.query(
        // as text: the column's own type (sql_identifier) comes back as an array, not a string
        'SELECT table_name::text AS table_name FROM information_schema.tables WHERE table_schema = :schema',
        {replacements: {schema: SCHEMA}},
      );
      const rows = [];
      for (const {table_name: table} of tables) {
        const [found] = await sequelize.query(
          `SELECT * FROM "${SCHEMA}"."${table}"`,
        );
        rows.push(JSON.stringify(found));
      }
      return rows.join('\n');
    }

    it('the setup code sets up the authenticator, once', async () => {
      const ctx = await setupApp({repo: await freshRepo()});
      const setupCode = await ctx.giveCode(SCAN);
      const challenge = await ctx.setupChallenge(SCAN);
      const step = (await ctx.sendSetupCode(challenge, setupCode)).json();
      expect(step.next).to.equal('mfa-enroll');
      const res = await ctx.sendCode(
        step.challenge,
        codeFor(step.secret, ctx.clock),
      );
      expect(res.statusCode, res.body).to.equal(200);
      expect((await ctx.repo.getUserByEmail(SCAN)).mfaEnrolled).to.equal(true);
      expectSetupRefused(await ctx.sendSetupCode(challenge, setupCode));
    });

    it('a new code voids the previous one, and the code expires after 72 hours', async () => {
      const ctx = await setupApp({repo: await freshRepo()});
      const first = await ctx.giveCode(SCAN);
      const second = await ctx.giveCode(SCAN);
      expectSetupRefused(
        await ctx.sendSetupCode(await ctx.setupChallenge(SCAN), first),
      );
      ctx.clock.advance(72 * HOUR + MINUTE);
      expectSetupRefused(
        await ctx.sendSetupCode(await ctx.setupChallenge(SCAN), second),
      );
    });

    it('no table holds the plain setup code', async () => {
      const ctx = await setupApp({repo: await freshRepo()});
      const given = await ctx.giveCode(REVIEWER);
      await ctx.enrolDirectly(SCAN);
      const fromReset = await ctx.resetTwoFactor(SCAN);
      const rows = await everyRow();
      expectNoCode(rows, given, 'the database');
      expectNoCode(rows, fromReset, 'the database');
    });

    it("the reset ends the user's sessions in the database", async () => {
      const ctx = await setupApp({repo: await freshRepo()});
      const secret = await ctx.enrolDirectly(SCAN);
      const session = await ctx.signInWithCode(SCAN, secret);
      await ctx.resetTwoFactor(SCAN);
      const sid = session.cookie.split('.')[0];
      expect((await ctx.repo.getSession(sid)).revokedAt).to.not.equal(null);
      expect((await ctx.refresh(session.cookie)).statusCode).to.equal(401);
    });

    it('starting twice on the same database keeps the setup code working', async () => {
      const repo = await freshRepo();
      await repo.sync();
      const ctx = await setupApp({repo});
      await ctx.setUp(SCAN, await ctx.giveCode(SCAN));
    });
  });
});
