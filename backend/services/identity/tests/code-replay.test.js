import {readFileSync} from 'node:fs';
import {expect} from 'chai';
import {Sequelize} from 'sequelize';
import {ensureSchema} from '@lrfe/common';
import {makeApp, codeFor, wrongCodeFor, PASSWORD} from './helpers.js';
import * as totpLib from '../src/totp.js';
import {generateSecret, totp} from '../src/totp.js';
import {SCHEMA} from '../src/repo/models.js';
import {createSequelizeRepo} from '../src/repo/sequelize.js';

/**
 * CB-104: an authenticator code is accepted once. The server keeps, per user, the last time step
 * it accepted a code for, and refuses a code for that step or an earlier one, even inside the
 * ±1 step window (about 90 s) that verifyTotp allows for clock drift.
 *
 * - Every place that accepts an authenticator code records the step: the sign-in's code step
 *   (verifyMfa), the authenticator set-up after a setup code (CB-102), and the invitation's
 *   activation with an authenticator.
 * - A refused replay looks exactly like a wrong code: 401 "Invalid authenticator code", counted
 *   towards the wrong-code limits (CB-101) and written to the access log as "MFA failed".
 * - Normal sign-in is unchanged: the next step's code is accepted; a user with no recorded step
 *   signs in with the current code; Reset 2FA (a new secret) starts afresh.
 * - The step is stored with the user, in memory and on PostgreSQL (a new user column added at
 *   start-up; an existing database is upgraded).
 *
 * The test clock starts on a step boundary and only moves when a test advances it.
 */

const STEP_MS = 30_000;
const ADMIN = 'p.hamutenya@deeds.gov.na';
const SCAN = 'k.iipinge@deeds.gov.na';
const OTHER_SCAN = 's.nangolo@deeds.gov.na';
const NEW_PASSWORD = 'a new password for the invitee';

/**
 * The code of `secret` for the time step `steps` away from the test clock's (negative: earlier).
 * @param {string} secret
 * @param {function(): !Date} clock
 * @param {number} steps
 * @return {string}
 */
function codeAtStep(secret, clock, steps) {
  return totp(secret, clock().getTime() + steps * STEP_MS);
}

/**
 * The identity app with two-factor sign-in required, and the steps of sign-in, set-up and
 * invitation over HTTP. The administrator signs in while the policy is off, so needs no code.
 * @param {{repo: (!Object|undefined)}=} options
 * @return {!Promise<!Object>}
 */
async function replayApp(options = {}) {
  const ctx = await makeApp({...options, mfa: false});
  const {app, repo, clock} = ctx;
  const admin = await ctx.login(ADMIN);
  await repo.savePolicies({...(await repo.getPolicies()), mfa: true});

  /** The id of the user with `email`. */
  async function idOf(email) {
    return (await repo.getUserByEmail(email)).id;
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

  /** Sign-in step 1: the password. Returns the response body. */
  async function passwordStep(email, password = PASSWORD) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {email, password},
    });
    expect(res.statusCode, `password step of ${email}: ${res.body}`).to.equal(
      200,
    );
    return res.json();
  }

  /** A fresh authenticator-code challenge of an enrolled user. */
  async function challengeFor(email, password = PASSWORD) {
    const step1 = await passwordStep(email, password);
    expect(step1.next, 'the step after the password').to.equal('mfa');
    return step1.challenge;
  }

  /** An authenticator code on a challenge. */
  function sendCode(challenge, code) {
    return app.inject({
      method: 'POST',
      url: '/auth/mfa',
      payload: {challenge, code},
    });
  }

  /** `code` on a fresh challenge of `email`. */
  async function signIn(email, code, password = PASSWORD) {
    return sendCode(await challengeFor(email, password), code);
  }

  /** POST as the administrator. */
  function adminPost(url, payload = undefined) {
    return app.inject({
      method: 'POST',
      url,
      headers: ctx.auth(admin.token),
      ...(payload ? {payload} : {}),
    });
  }

  /** "Reset 2FA" of `email`: the setup code the administrator is shown. */
  async function resetTwoFactor(email) {
    const res = await adminPost(`/users/${await idOf(email)}/mfa-reset`);
    expect(res.statusCode, res.body).to.equal(200);
    return res.json().setupCode;
  }

  /** "Give setup code" for `email`, who has no authenticator. */
  async function giveCode(email) {
    const res = await adminPost(`/users/${await idOf(email)}/setup-code`);
    expect(res.statusCode, res.body).to.equal(200);
    return res.json().setupCode;
  }

  /**
   * Password and setup code of a user without an authenticator (CB-102): the authenticator step's
   * challenge and the secret to set up.
   */
  async function setupStep(email, setupCode) {
    const step1 = await passwordStep(email);
    expect(step1.next, 'the step after the password').to.equal('setup-code');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/setup-code',
      payload: {challenge: step1.challenge, setupCode},
    });
    expect(res.statusCode, `setup code of ${email}: ${res.body}`).to.equal(200);
    return res.json();
  }

  /** Invites a reviewer; returns the invitation token and the new user's email. */
  async function invite(label = 'n') {
    const email = `${label}.shikongo@deeds.gov.na`;
    const res = await adminPost('/users', {
      name: `Nangula Shikongo ${label}`,
      email,
      officeId: ctx.office.id,
      roles: ['rev'],
    });
    expect(res.statusCode, res.body).to.equal(201);
    const token = new URL(
      res.json().inviteUrl.replace('/#/', '/'),
    ).searchParams.get('token');
    return {email, token};
  }

  /** POST /invitations/accept with `payload`. */
  function accept(payload) {
    return app.inject({
      method: 'POST',
      url: '/invitations/accept',
      payload,
    });
  }

  /** Sends `count` wrong codes for `email`, at most 4 per challenge (fresh challenges as needed). */
  async function wrongCodes(email, secret, count) {
    let left = count;
    while (left > 0) {
      const batch = Math.min(left, 4);
      const challenge = await challengeFor(email);
      for (let i = 0; i < batch; i++) {
        expectRefused(await sendCode(challenge, wrongCodeFor(secret, clock)));
      }
      left -= batch;
    }
  }

  /** The "MFA failed" entries of the access log naming `email`'s user. */
  async function failedEntries(email) {
    const name = (await repo.getUserByEmail(email)).name;
    const {items} = await ctx.service.listAccessLog({
      kind: 'denied',
      limit: 200,
    });
    return items.filter(e => e.action === 'MFA failed' && e.target === name);
  }

  return {
    ...ctx,
    idOf,
    enrolDirectly,
    passwordStep,
    challengeFor,
    sendCode,
    signIn,
    resetTwoFactor,
    giveCode,
    setupStep,
    invite,
    accept,
    wrongCodes,
    failedEntries,
  };
}

/** A sign-in that went through: an access token and the refresh cookie. */
function expectSignedIn(res) {
  expect(res.statusCode, res.body).to.equal(200);
  expect(res.json().accessToken).to.be.a('string');
  expect(res.cookies.find(c => c.name === 'lrfe_rt')).to.not.equal(undefined);
}

/** A refused code step: `status`, no access token, no refresh cookie. */
function expectRefused(res, status = 401) {
  expect(res.statusCode, res.body).to.equal(status);
  expect(res.json()).to.not.have.property('accessToken');
  expect(res.cookies.find(c => c.name === 'lrfe_rt')).to.equal(undefined);
}

/** A code refused as a wrong code is: 401 "Invalid authenticator code", no session. */
function expectInvalidCode(res) {
  expectRefused(res);
  expect(res.json().message).to.equal('Invalid authenticator code');
}

describe('reuse of a 2FA code within its time window is refused (CB-104)', () => {
  describe('Done when: a code that was just accepted is refused the second time, even within its window', () => {
    it('the code that just signed in is refused on a second sign-in at the same moment', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      expectInvalidCode(await t.signIn(SCAN, code));
    });

    it('the same code is refused 30 seconds later, while it is still inside the drift window', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      t.clock.advance(STEP_MS);
      expectInvalidCode(await t.signIn(SCAN, code));
    });

    it('a code of an earlier step still inside the window is refused once a later step was accepted', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      // a phone clock one step ahead: the next step's code is accepted (drift)
      expectSignedIn(await t.signIn(SCAN, codeAtStep(secret, t.clock, 1)));
      expectInvalidCode(await t.signIn(SCAN, codeAtStep(secret, t.clock, 0)));
      expectInvalidCode(await t.signIn(SCAN, codeAtStep(secret, t.clock, -1)));
    });

    it('two sign-ins sending the same code at the same time: one session at most', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      const challenges = [
        await t.challengeFor(SCAN),
        await t.challengeFor(SCAN),
      ];
      const responses = await Promise.all(
        challenges.map(challenge => t.sendCode(challenge, code)),
      );
      const signedIn = responses.filter(res => res.statusCode === 200);
      expect(signedIn, 'sign-ins that got a session').to.have.length(1);
      for (const res of responses.filter(r => r.statusCode !== 200)) {
        expectInvalidCode(res);
      }
    });
  });

  describe('every place that accepts an authenticator code records its step', () => {
    it('the code that set up the authenticator after a setup code is refused at the next sign-in', async () => {
      const t = await replayApp();
      const step = await t.setupStep(SCAN, await t.giveCode(SCAN));
      const code = codeFor(step.secret, t.clock);
      expectSignedIn(await t.sendCode(step.challenge, code));
      expectInvalidCode(await t.signIn(SCAN, code));
    });

    it('the code that activated an invitation is refused at the next sign-in', async () => {
      const t = await replayApp();
      const {email, token} = await t.invite();
      const chosen = await t.accept({token, password: NEW_PASSWORD});
      expect(chosen.statusCode, chosen.body).to.equal(200);
      const {secret} = chosen.json();
      const code = codeFor(secret, t.clock);
      const activated = await t.accept({token, password: NEW_PASSWORD, code});
      expect(activated.statusCode, activated.body).to.equal(200);
      expectInvalidCode(await t.signIn(email, code, NEW_PASSWORD));
    });

    it("after the invitation's code, the next step's code signs in", async () => {
      const t = await replayApp();
      const {email, token} = await t.invite();
      const {secret} = (await t.accept({token, password: NEW_PASSWORD})).json();
      const activated = await t.accept({
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, t.clock),
      });
      expect(activated.statusCode, activated.body).to.equal(200);
      t.clock.advance(STEP_MS);
      expectSignedIn(
        await t.signIn(email, codeFor(secret, t.clock), NEW_PASSWORD),
      );
    });
  });

  describe('a refused replay looks exactly like a wrong code', () => {
    it('it is answered exactly as a wrong code: the same status and the same body', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      const wrong = await t.signIn(SCAN, wrongCodeFor(secret, t.clock));
      const replayed = await t.signIn(SCAN, code);
      expect(replayed.statusCode).to.equal(wrong.statusCode);
      // the error handler stamps each answer with the real time; everything else must match
      const {timestamp: replayedAt, ...replayedBody} = replayed.json();
      const {timestamp: wrongAt, ...wrongBody} = wrong.json();
      expect(replayedAt).to.be.a('string');
      expect(wrongAt).to.be.a('string');
      expect(replayedBody).to.deep.equal(wrongBody);
      expectInvalidCode(replayed);
    });

    it('it is written to the access log as "MFA failed" naming the user, like a wrong code', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      expect(await t.failedEntries(SCAN)).to.have.length(0);
      await t.signIn(SCAN, code);
      expect(await t.failedEntries(SCAN)).to.have.length(1);
    });

    it("it counts towards the challenge's limit: four wrong codes and a replay void the challenge", async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      const challenge = await t.challengeFor(SCAN);
      for (let i = 0; i < 4; i++) {
        expectInvalidCode(
          await t.sendCode(challenge, wrongCodeFor(secret, t.clock)),
        );
      }
      expectInvalidCode(await t.sendCode(challenge, code));
      t.clock.advance(STEP_MS);
      // the challenge is void: even the next step's right code is refused on it
      expectRefused(await t.sendCode(challenge, codeFor(secret, t.clock)));
    });

    it("it counts towards the user's lockout: nine wrong codes and a replay lock the 2FA step", async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      await t.wrongCodes(SCAN, secret, 9);
      expectInvalidCode(await t.signIn(SCAN, code));
      t.clock.advance(STEP_MS);
      expectRefused(await t.signIn(SCAN, codeFor(secret, t.clock)), 429);
    });
  });

  describe('Done when: the next valid code is accepted (normal sign-in unchanged)', () => {
    it("the next step's code signs in after a sign-in", async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      expectSignedIn(await t.signIn(SCAN, codeFor(secret, t.clock)));
      t.clock.advance(STEP_MS);
      expectSignedIn(await t.signIn(SCAN, codeFor(secret, t.clock)));
    });

    it('signing in once every step with the code of the moment is never refused', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      for (let i = 0; i < 4; i++) {
        expectSignedIn(await t.signIn(SCAN, codeFor(secret, t.clock)));
        t.clock.advance(STEP_MS);
      }
    });

    it('a user with no step recorded yet signs in with the current code', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      expectSignedIn(await t.signIn(SCAN, codeFor(secret, t.clock)));
    });

    it('a first code from a phone one step behind is still accepted (the drift window is kept)', async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      expectSignedIn(await t.signIn(SCAN, codeAtStep(secret, t.clock, -1)));
    });

    it("one user's accepted code does not block another user's sign-in at the same step", async () => {
      const t = await replayApp();
      const secret = await t.enrolDirectly(SCAN);
      const otherSecret = await t.enrolDirectly(OTHER_SCAN);
      expectSignedIn(await t.signIn(SCAN, codeFor(secret, t.clock)));
      expectSignedIn(await t.signIn(OTHER_SCAN, codeFor(otherSecret, t.clock)));
    });

    it("after Reset 2FA, the new authenticator's code for the same step sets it up", async () => {
      const t = await replayApp();
      const oldSecret = await t.enrolDirectly(SCAN);
      expectSignedIn(await t.signIn(SCAN, codeFor(oldSecret, t.clock)));
      const step = await t.setupStep(SCAN, await t.resetTwoFactor(SCAN));
      expectSignedIn(
        await t.sendCode(step.challenge, codeFor(step.secret, t.clock)),
      );
    });

    it("after Reset 2FA, the new authenticator's code for a step before the last accepted one sets it up", async () => {
      const t = await replayApp();
      const oldSecret = await t.enrolDirectly(SCAN);
      // the old authenticator's last code was for the next step (a phone ahead)
      expectSignedIn(await t.signIn(SCAN, codeAtStep(oldSecret, t.clock, 1)));
      const step = await t.setupStep(SCAN, await t.resetTwoFactor(SCAN));
      expectSignedIn(
        await t.sendCode(step.challenge, codeFor(step.secret, t.clock)),
      );
    });

    it('the TODO about code replay is gone from the identity service', () => {
      const source = readFileSync(
        new URL('../src/identity.service.js', import.meta.url),
        'utf8',
      );
      expect(source).to.not.match(/TODO[^\n]*(replay|time step)/i);
    });
  });

  describe('the step of an accepted code (totp.js matchTotpStep)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const at = Date.parse('2026-09-28T08:00:00Z');
    const step = Math.floor(at / STEP_MS);

    it('matchTotpStep is exported by totp.js', () => {
      expect(totpLib.matchTotpStep).to.be.a('function');
    });

    it('gives the time step of the code it accepts: the current one, or one step either side', () => {
      const {matchTotpStep} = totpLib;
      expect(matchTotpStep(secret, totp(secret, at), at)).to.equal(step);
      expect(matchTotpStep(secret, totp(secret, at - STEP_MS), at)).to.equal(
        step - 1,
      );
      expect(matchTotpStep(secret, totp(secret, at + STEP_MS), at)).to.equal(
        step + 1,
      );
    });

    it('gives null for a code outside the window, a wrong code and anything that is not 6 digits', () => {
      const {matchTotpStep} = totpLib;
      expect(
        matchTotpStep(secret, totp(secret, at + 3 * STEP_MS), at),
      ).to.equal(null);
      const wrong = wrongCodeFor(secret, () => new Date(at));
      expect(matchTotpStep(secret, wrong, at)).to.equal(null);
      for (const code of ['', 'abcdef', '12345', '1234567', 'toString']) {
        expect(matchTotpStep(secret, code, at), `code ${code}`).to.equal(null);
      }
      expect(matchTotpStep(secret, undefined, at)).to.equal(null);
      expect(matchTotpStep(secret, null, at)).to.equal(null);
    });
  });

  // Runs only with a throwaway PostgreSQL database: IDENTITY_TEST_DATABASE_URL (its identity schema
  // is dropped and made again for each test).
  const pgUrl = process.env.IDENTITY_TEST_DATABASE_URL;
  (pgUrl ? describe : describe.skip)('on PostgreSQL', function () {
    this.timeout(60_000);

    /** The user table's columns at CB-102 (commit 2742213), before CB-104. */
    const USER_COLUMNS_BEFORE = [
      'id',
      'name',
      'email',
      'office',
      'officeId',
      'organisationId',
      'status',
      'passwordHash',
      'mfaEnrolled',
      'mfaSecret',
      'pendingMfaSecret',
      'setupCodeHash',
      'setupCodeExpiresAt',
      'inviteHash',
      'inviteExpiresAt',
      'lastActiveAt',
      'createdAt',
      'updatedAt',
    ];
    const USER_TABLE = {tableName: 'user', schema: SCHEMA};
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

    /** The user table's columns added since CB-102. */
    async function newUserColumns() {
      const columns = await sequelize
        .getQueryInterface()
        .describeTable(USER_TABLE);
      return Object.keys(columns).filter(
        name => !USER_COLUMNS_BEFORE.includes(name),
      );
    }

    it('a replayed code is refused, and the next step code signs in', async () => {
      const t = await replayApp({repo: await freshRepo()});
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      expectInvalidCode(await t.signIn(SCAN, code));
      t.clock.advance(STEP_MS);
      expectInvalidCode(await t.signIn(SCAN, code));
      expectSignedIn(await t.signIn(SCAN, codeFor(secret, t.clock)));
    });

    it('the code that set up the authenticator after a setup code is refused at the next sign-in', async () => {
      const t = await replayApp({repo: await freshRepo()});
      const step = await t.setupStep(SCAN, await t.giveCode(SCAN));
      const code = codeFor(step.secret, t.clock);
      expectSignedIn(await t.sendCode(step.challenge, code));
      expectInvalidCode(await t.signIn(SCAN, code));
    });

    it('the code that activated an invitation is refused at the next sign-in', async () => {
      const t = await replayApp({repo: await freshRepo()});
      const {email, token} = await t.invite();
      const {secret} = (await t.accept({token, password: NEW_PASSWORD})).json();
      const code = codeFor(secret, t.clock);
      const activated = await t.accept({token, password: NEW_PASSWORD, code});
      expect(activated.statusCode, activated.body).to.equal(200);
      expectInvalidCode(await t.signIn(email, code, NEW_PASSWORD));
    });

    it('two sign-ins sending the same code at the same time: one session at most', async () => {
      const t = await replayApp({repo: await freshRepo()});
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      const challenges = [
        await t.challengeFor(SCAN),
        await t.challengeFor(SCAN),
      ];
      const responses = await Promise.all(
        challenges.map(challenge => t.sendCode(challenge, code)),
      );
      const signedIn = responses.filter(res => res.statusCode === 200);
      expect(signedIn, 'sign-ins that got a session').to.have.length(1);
    });

    it("after Reset 2FA, the new authenticator's code for a step before the last accepted one sets it up", async () => {
      const t = await replayApp({repo: await freshRepo()});
      const oldSecret = await t.enrolDirectly(SCAN);
      expectSignedIn(await t.signIn(SCAN, codeAtStep(oldSecret, t.clock, 1)));
      const step = await t.setupStep(SCAN, await t.resetTwoFactor(SCAN));
      expectSignedIn(
        await t.sendCode(step.challenge, codeFor(step.secret, t.clock)),
      );
    });

    it('start-up adds a new user column for the accepted step', async () => {
      await freshRepo();
      expect(await newUserColumns()).to.have.length.greaterThan(0);
    });

    it('an existing database without the new column is upgraded at start-up and then refuses replays', async () => {
      await freshRepo();
      // the database as CB-102 left it: without the columns added since
      const q = sequelize.getQueryInterface();
      for (const column of await newUserColumns()) {
        await q.removeColumn(USER_TABLE, column);
      }
      const repo = createSequelizeRepo(sequelize);
      await repo.sync();
      expect(await newUserColumns()).to.have.length.greaterThan(0);
      const t = await replayApp({repo});
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      expectInvalidCode(await t.signIn(SCAN, code));
    });

    it('starting twice on the same database keeps replays refused', async () => {
      const repo = await freshRepo();
      await repo.sync();
      const t = await replayApp({repo});
      const secret = await t.enrolDirectly(SCAN);
      const code = codeFor(secret, t.clock);
      expectSignedIn(await t.signIn(SCAN, code));
      expectInvalidCode(await t.signIn(SCAN, code));
    });
  });
});
