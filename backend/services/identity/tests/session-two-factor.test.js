import {randomUUID} from 'node:crypto';
import {expect} from 'chai';
import {Sequelize} from 'sequelize';
import {ensureSchema, SESSION_REVOKED} from '@lrfe/common';
import {
  makeService,
  makeApp,
  makeClock,
  codeFor,
  enrolWithSetupCode,
  setupCodeStep,
  PASSWORD,
} from './helpers.js';
import {randomToken, sha256} from '../src/crypto.js';
import {generateSecret} from '../src/totp.js';
import {defineModels, SCHEMA} from '../src/repo/models.js';
import {createSequelizeRepo} from '../src/repo/sequelize.js';

/**
 * CB-103: a session records whether it was opened with two-factor sign-in (2FA).
 *
 * - Opened with 2FA: a sign-in with an authenticator code, and the authenticator's set-up after a
 *   setup code. (Activating an invitation with an authenticator opens no session: the sign-in after
 *   it takes a code.) A password-only sign-in (policy off, user without an authenticator) is not.
 * - "Reset 2FA" ends all of the user's sessions and announces the revocation, like a suspension:
 *   the access and refresh tokens from before are refused (CB-102 did this part).
 * - Refresh refuses a session opened without 2FA once the site policy `mfa` is on, or once the user
 *   has an authenticator: 401 "Session expired, sign in again", and the session is ended. A session
 *   opened with 2FA refreshes as before.
 * - A session stored before this change (no record of 2FA) is left alone: not refused for missing
 *   2FA (the CB-100 maximum session age ends it). Nobody is signed out by the upgrade.
 * - The record is kept in memory and on PostgreSQL (a new session column added at start-up; an
 *   existing database is upgraded).
 *
 * Tests marked "(already passes)" prove behaviour that exists before CB-103 ("CB-102": the reset
 * part; "CB-100": the maximum session age); they guard it against a regression.
 */

const ADMIN = 'p.hamutenya@deeds.gov.na';
const SCAN = 'k.iipinge@deeds.gov.na';
const OTHER_SCAN = 's.nangolo@deeds.gov.na';
const STEP_MS = 30_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EXPIRED = 'Session expired, sign in again';
const NEW_PASSWORD = 'a new password for the invitee';

/** The session fields stored before CB-103 (CB-100 added startedAt). */
const FIELDS_BEFORE = [
  'id',
  'userId',
  'refreshHash',
  'startedAt',
  'lastSeenAt',
  'revokedAt',
  'ip',
];

/** The session table's columns before CB-103, on PostgreSQL. */
const COLUMNS_BEFORE = [...FIELDS_BEFORE, 'createdAt', 'updatedAt'];

/**
 * Awaits a promise that must fail with an HTTP-like error.
 * @param {!Promise} promise
 * @param {number} statusCode
 * @param {string=} messagePart
 * @return {!Promise<!Error>}
 */
async function rejects(promise, statusCode, messagePart) {
  try {
    await promise;
  } catch (err) {
    expect(err.statusCode, err.message).to.equal(statusCode);
    if (messagePart) {
      expect(err.message).to.include(messagePart);
    }
    return err;
  }
  throw new Error(`expected a ${statusCode} error`);
}

/**
 * The policies of the test site, as an administrator would save them.
 * @param {!Object} ctx the test context (service and actor)
 * @param {!Object} changes
 * @return {!Promise<!Object>}
 */
async function savePolicies(ctx, changes) {
  const {policies} = await ctx.service.getPolicySettings();
  return ctx.service.savePolicies(
    {policies: {...policies, ...changes}},
    ctx.actor,
  );
}

/**
 * The identity service over a seeded store, with the administrator as the actor.
 * @param {!Object=} options as makeService takes them
 * @return {!Promise<!Object>}
 */
async function setup(options = {}) {
  const ctx = await makeService(options);
  const admin = await ctx.user(ADMIN);
  return {...ctx, actor: {id: admin.id, name: admin.name}};
}

/**
 * Gives `email` an authenticator directly in the store, as an earlier enrolment left it.
 * @param {!Object} ctx
 * @param {string} email
 * @return {!Promise<string>} the secret
 */
async function enrolDirectly(ctx, email) {
  const secret = generateSecret();
  const user = await ctx.repo.getUserByEmail(email);
  await ctx.repo.updateUser(user.id, {
    mfaEnrolled: true,
    mfaSecret: secret,
    pendingMfaSecret: null,
  });
  return secret;
}

/**
 * A password-only sign-in: the policy is off and the user has no authenticator.
 * @param {!Object} ctx
 * @param {string} email
 * @return {!Promise<!Object>} the session, as login returns it
 */
async function passwordSession(ctx, email) {
  const session = await ctx.service.login({email, password: PASSWORD});
  expect(session.next, `password-only sign-in of ${email}`).to.equal('done');
  return session;
}

/**
 * A sign-in with password and authenticator code of a user who has an authenticator (one is given
 * in the store if needed). The clock moves on a step first, so the code is a new one (CB-104).
 * @param {!Object} ctx
 * @param {string} email
 * @return {!Promise<!Object>} the session, as verifyMfa returns it
 */
async function codeSession(ctx, email) {
  const user = await ctx.repo.getUserByEmail(email);
  const secret = user.mfaEnrolled
    ? user.mfaSecret
    : await enrolDirectly(ctx, email);
  const step1 = await ctx.service.login({email, password: PASSWORD});
  expect(step1.next, `the step after ${email}'s password`).to.equal('mfa');
  ctx.clock.advance(STEP_MS);
  return ctx.service.verifyMfa({
    userId: step1.userId,
    code: codeFor(secret, ctx.clock),
  });
}

/**
 * Refreshes `count` times, a minute apart; returns the latest refresh token.
 * @param {!Object} ctx
 * @param {string} refreshToken
 * @param {number} count
 * @return {!Promise<string>}
 */
async function refreshTimes(ctx, refreshToken, count) {
  let token = refreshToken;
  for (let i = 0; i < count; i++) {
    ctx.clock.advance(MINUTE);
    token = (await ctx.service.refresh(token)).refreshToken;
  }
  return token;
}

/**
 * A session stored the way the service stored them before CB-103: no record of 2FA.
 * @param {!Object} ctx
 * @param {string} email
 * @return {!Promise<{refreshToken: string, sid: string}>}
 */
async function sessionFromBefore(ctx, email) {
  const user = await ctx.repo.getUserByEmail(email);
  const sid = randomUUID();
  const secret = randomToken();
  const now = ctx.clock();
  await ctx.repo.createSession({
    id: sid,
    userId: user.id,
    refreshHash: sha256(secret),
    startedAt: now,
    lastSeenAt: now,
    revokedAt: null,
    ip: null,
  });
  return {refreshToken: `${sid}.${secret}`, sid};
}

/**
 * The fields of a stored session beyond those stored before CB-103.
 * @param {!Object} session
 * @return {!Object}
 */
function newFieldsOf(session) {
  return Object.fromEntries(
    Object.entries(session).filter(([key]) => !FIELDS_BEFORE.includes(key)),
  );
}

describe('sessions record whether 2FA was done (CB-103)', () => {
  describe("Done when: after an administrator's 2FA reset, the user's access and refresh tokens are refused", () => {
    it('(already passes: CB-102) a session opened with an authenticator code cannot refresh after the reset', async () => {
      const ctx = await setup();
      const {refreshToken} = await codeSession(ctx, SCAN);
      await ctx.service.resetMfa((await ctx.user(SCAN)).id, ctx.actor);
      await rejects(ctx.service.refresh(refreshToken), 401, EXPIRED);
    });

    it("(already passes: CB-102) every one of the user's sessions ends, already refreshed ones too", async () => {
      const ctx = await setup();
      const first = await codeSession(ctx, SCAN);
      const second = await codeSession(ctx, SCAN);
      const refreshed = await refreshTimes(ctx, first.refreshToken, 2);
      await ctx.service.resetMfa((await ctx.user(SCAN)).id, ctx.actor);
      for (const token of [refreshed, second.refreshToken]) {
        await rejects(ctx.service.refresh(token), 401, EXPIRED);
      }
      for (const sid of [first.claims.sid, second.claims.sid]) {
        expect((await ctx.repo.getSession(sid)).revokedAt).to.not.equal(null);
      }
    });

    it("(already passes: CB-102) the reset is announced to every service as a revocation of all the user's tokens", async () => {
      const ctx = await setup();
      await codeSession(ctx, SCAN);
      const id = (await ctx.user(SCAN)).id;
      await ctx.service.resetMfa(id, ctx.actor);
      const revoked = ctx.published.filter(e => e.type === SESSION_REVOKED);
      expect(revoked.map(e => e.data.userId)).to.include(id);
    });

    it("(already passes: CB-102) other users' sessions keep refreshing", async () => {
      const ctx = await setup();
      await codeSession(ctx, SCAN);
      const other = await codeSession(ctx, OTHER_SCAN);
      await ctx.service.resetMfa((await ctx.user(SCAN)).id, ctx.actor);
      ctx.clock.advance(MINUTE);
      const next = await ctx.service.refresh(other.refreshToken);
      expect(next.claims.sub).to.equal((await ctx.user(OTHER_SCAN)).id);
    });

    it('(already passes: CB-102) over HTTP: an access token issued before the reset is refused at once', async () => {
      const {app, auth, repo, service, user} = await makeApp({
        clock: () => new Date(),
      });
      const secret = generateSecret();
      const scan = await user(SCAN);
      await repo.updateUser(scan.id, {mfaEnrolled: true, mfaSecret: secret});
      const step1 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {email: SCAN, password: PASSWORD},
      });
      const signedIn = await app.inject({
        method: 'POST',
        url: '/auth/mfa',
        payload: {
          challenge: step1.json().challenge,
          code: codeFor(secret, () => new Date()),
        },
      });
      expect(signedIn.statusCode, signedIn.body).to.equal(200);
      const token = signedIn.json().accessToken;
      expect(
        (await app.inject({url: '/auth/me', headers: auth(token)})).statusCode,
      ).to.equal(200);
      const admin = await user(ADMIN);
      await service.resetMfa(scan.id, {id: admin.id, name: admin.name});
      const after = await app.inject({url: '/auth/me', headers: auth(token)});
      expect(after.statusCode).to.equal(401);
      expect(after.json().message).to.equal('Session ended, sign in again');
    });

    it('(already passes: CB-102) over HTTP: the refresh cookie from before the reset gets 401 and is cleared', async () => {
      const ctx = await makeApp({clock: makeClock()});
      const admin = await ctx.user(ADMIN);
      const session = await codeSession(ctx, SCAN);
      await ctx.service.resetMfa((await ctx.user(SCAN)).id, {
        id: admin.id,
        name: admin.name,
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {lrfe_rt: session.refreshToken},
      });
      expect(res.statusCode).to.equal(401);
      expect(res.json()).to.not.have.property('accessToken');
      expect(res.cookies.find(c => c.name === 'lrfe_rt').value).to.equal('');
    });

    it('(already passes) after the reset, the user sets up a new authenticator with the setup code and the new session refreshes', async () => {
      const ctx = await setup({mfa: true});
      const old = await codeSession(ctx, SCAN);
      await ctx.service.resetMfa((await ctx.user(SCAN)).id, ctx.actor);
      await rejects(ctx.service.refresh(old.refreshToken), 401, EXPIRED);
      const {session} = await enrolWithSetupCode(ctx.service, ctx.clock, SCAN);
      const token = await refreshTimes(ctx, session.refreshToken, 3);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(
        session.claims.sid,
      );
    });
  });

  describe('Done when: after 2FA becomes mandatory, a session opened without 2FA cannot refresh', () => {
    it('(already passes) a password-only session refreshes as before while 2FA is not required', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      const token = await refreshTimes(ctx, session.refreshToken, 3);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(
        session.claims.sid,
      );
    });

    it('a password-only session is refused with 401 "Session expired, sign in again" once the administrator makes 2FA mandatory', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
    });

    it('a password-only session already refreshed before the switch is refused too', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      const token = await refreshTimes(ctx, session.refreshToken, 3);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(token), 401, EXPIRED);
    });

    it('the refused session is ended in the database at the time it is refused', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(session.refreshToken), 401);
      const stored = await ctx.repo.getSession(session.claims.sid);
      expect(new Date(stored.revokedAt).toISOString()).to.equal(
        ctx.clock().toISOString(),
      );
      // the access log says why, like the idle and maximum-age refusals
      const {items} = await ctx.repo.listAccessEvents({kind: 'session'});
      const expiredEntries = items.filter(e => e.action === 'Session expired');
      expect(expiredEntries).to.have.length(1);
      expect(expiredEntries[0].detail).to.match(/two-factor/i);
    });

    it('the refused session stays ended when the administrator makes 2FA optional again', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(session.refreshToken), 401);
      await savePolicies(ctx, {mfa: false});
      await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
    });

    it("applies to every user's password-only sessions, not only one", async () => {
      const ctx = await setup();
      const sessions = [
        await passwordSession(ctx, SCAN),
        await passwordSession(ctx, OTHER_SCAN),
        await passwordSession(ctx, SCAN),
      ];
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      for (const session of sessions) {
        await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
      }
    });

    it('(already passes) the policy counts at the time of the refresh: switched on and off again before it, the session refreshes', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      await savePolicies(ctx, {mfa: false});
      ctx.clock.advance(MINUTE);
      const next = await ctx.service.refresh(session.refreshToken);
      expect(next.claims.sid).to.equal(session.claims.sid);
    });

    it('a password-only session is refused once the user has an authenticator, even while 2FA is optional', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      await enrolDirectly(ctx, SCAN);
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
    });

    it('the user sets up an authenticator in another sign-in: the old password-only session is refused, the new one refreshes', async () => {
      const ctx = await setup();
      const old = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      const {session} = await enrolWithSetupCode(ctx.service, ctx.clock, SCAN);
      await savePolicies(ctx, {mfa: false});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(old.refreshToken), 401, EXPIRED);
      const next = await ctx.service.refresh(session.refreshToken);
      expect(next.claims.sid).to.equal(session.claims.sid);
    });

    it('two refreshes racing on a refused session are both refused and the session stays ended', async () => {
      const ctx = await setup();
      const session = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      const results = await Promise.allSettled([
        ctx.service.refresh(session.refreshToken),
        ctx.service.refresh(session.refreshToken),
      ]);
      expect(results.map(r => r.status)).to.deep.equal([
        'rejected',
        'rejected',
      ]);
      expect(results.map(r => r.reason.statusCode)).to.deep.equal([401, 401]);
      expect(
        (await ctx.repo.getSession(session.claims.sid)).revokedAt,
      ).to.not.equal(null);
    });

    it('the user signs in again: the password alone gives no session, the setup code and the authenticator give one that refreshes', async () => {
      const ctx = await setup();
      const old = await passwordSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(old.refreshToken), 401, EXPIRED);

      const again = await ctx.service.login({email: SCAN, password: PASSWORD});
      expect(again).to.deep.equal({
        next: 'setup-code',
        userId: (await ctx.user(SCAN)).id,
      });
      const step = await setupCodeStep(ctx.service, SCAN);
      const fresh = await ctx.service.verifyMfa({
        userId: step.userId,
        code: codeFor(step.secret, ctx.clock),
      });
      expect(fresh.claims.sid).to.not.equal(old.claims.sid);
      const token = await refreshTimes(ctx, fresh.refreshToken, 3);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(
        fresh.claims.sid,
      );
    });

    it('over HTTP: the refresh of a password-only session after the switch gets 401, the message, and a cleared cookie', async () => {
      const ctx = await makeApp({clock: makeClock()});
      const admin = await ctx.user(ADMIN);
      const {cookie} = await ctx.login(SCAN);
      await savePolicies(
        {service: ctx.service, actor: {id: admin.id, name: admin.name}},
        {mfa: true},
      );
      ctx.clock.advance(MINUTE);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {lrfe_rt: cookie},
      });
      expect(res.statusCode).to.equal(401);
      expect(res.json().message).to.equal(EXPIRED);
      expect(res.json()).to.not.have.property('accessToken');
      expect(res.cookies.find(c => c.name === 'lrfe_rt').value).to.equal('');
    });
  });

  describe('Done when: sessions opened with 2FA are unaffected', () => {
    it('(already passes) signed in with a code while 2FA was optional: keeps refreshing after the administrator makes it mandatory', async () => {
      const ctx = await setup();
      const session = await codeSession(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      const token = await refreshTimes(ctx, session.refreshToken, 5);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(
        session.claims.sid,
      );
    });

    it('(already passes) signed in with a code while 2FA is mandatory: keeps refreshing, refresh after refresh', async () => {
      const ctx = await setup({mfa: true});
      const session = await codeSession(ctx, SCAN);
      const token = await refreshTimes(ctx, session.refreshToken, 10);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(
        session.claims.sid,
      );
    });

    it('(already passes) the session of the authenticator set-up after a setup code counts as 2FA and keeps refreshing', async () => {
      const ctx = await setup({mfa: true});
      const {session} = await enrolWithSetupCode(ctx.service, ctx.clock, SCAN);
      const token = await refreshTimes(ctx, session.refreshToken, 5);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(
        session.claims.sid,
      );
    });

    it('(already passes) a user who activated the invitation with an authenticator signs in with a code and the session keeps refreshing', async () => {
      const ctx = await setup({mfa: true});
      const created = await ctx.service.invite(
        {
          name: 'Nangula Shikongo',
          email: 'n.shikongo@deeds.gov.na',
          officeId: ctx.office.id,
          roles: ['rev'],
        },
        ctx.actor,
      );
      const token = new URL(
        created.inviteUrl.replace('/#/', '/'),
      ).searchParams.get('token');
      const {secret} = await ctx.service.acceptInvite({
        token,
        password: NEW_PASSWORD,
      });
      await ctx.service.acceptInvite({
        token,
        password: NEW_PASSWORD,
        code: codeFor(secret, ctx.clock),
      });
      const step1 = await ctx.service.login({
        email: 'n.shikongo@deeds.gov.na',
        password: NEW_PASSWORD,
      });
      expect(step1.next).to.equal('mfa');
      ctx.clock.advance(STEP_MS);
      const session = await ctx.service.verifyMfa({
        userId: step1.userId,
        code: codeFor(secret, ctx.clock),
      });
      const next = await refreshTimes(ctx, session.refreshToken, 3);
      expect((await ctx.service.refresh(next)).claims.sid).to.equal(
        session.claims.sid,
      );
    });

    it("refusing one user's password-only session leaves another user's 2FA session running", async () => {
      const ctx = await setup();
      const password = await passwordSession(ctx, SCAN);
      const withCode = await codeSession(ctx, OTHER_SCAN);
      await savePolicies(ctx, {mfa: true});
      ctx.clock.advance(MINUTE);
      await rejects(ctx.service.refresh(password.refreshToken), 401, EXPIRED);
      const next = await ctx.service.refresh(withCode.refreshToken);
      expect(next.claims.sid).to.equal(withCode.claims.sid);
    });

    it('(already passes: CB-100) a 2FA session still ends at the maximum session age', async () => {
      const ctx = await setup({mfa: true});
      const session = await codeSession(ctx, SCAN);
      let token = session.refreshToken;
      const start = ctx.clock().getTime();
      while (ctx.clock().getTime() + 25 * MINUTE <= start + 12 * HOUR) {
        ctx.clock.advance(25 * MINUTE);
        token = (await ctx.service.refresh(token)).refreshToken;
      }
      ctx.clock.advance(start + 12 * HOUR + MINUTE - ctx.clock().getTime());
      await rejects(ctx.service.refresh(token), 401, EXPIRED);
    });

    it('(already passes) over HTTP: a session signed in with a code refreshes after 2FA becomes mandatory', async () => {
      const ctx = await makeApp({clock: makeClock()});
      const admin = await ctx.user(ADMIN);
      const secret = await enrolDirectly(ctx, SCAN);
      const step1 = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {email: SCAN, password: PASSWORD},
      });
      ctx.clock.advance(STEP_MS);
      const signedIn = await ctx.app.inject({
        method: 'POST',
        url: '/auth/mfa',
        payload: {
          challenge: step1.json().challenge,
          code: codeFor(secret, ctx.clock),
        },
      });
      expect(signedIn.statusCode, signedIn.body).to.equal(200);
      const cookie = signedIn.cookies.find(c => c.name === 'lrfe_rt').value;
      await savePolicies(
        {service: ctx.service, actor: {id: admin.id, name: admin.name}},
        {mfa: true},
      );
      ctx.clock.advance(MINUTE);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {lrfe_rt: cookie},
      });
      expect(res.statusCode, res.body).to.equal(200);
      expect(res.json().accessToken).to.be.a('string');
    });
  });

  describe('sessions stored before this change (no record of 2FA) are left alone', () => {
    it('(already passes) a session from before refreshes while 2FA is mandatory', async () => {
      const ctx = await setup({mfa: true});
      await enrolDirectly(ctx, SCAN);
      const {refreshToken, sid} = await sessionFromBefore(ctx, SCAN);
      ctx.clock.advance(MINUTE);
      const next = await ctx.service.refresh(refreshToken);
      expect(next.claims.sid).to.equal(sid);
      expect((await ctx.repo.getSession(sid)).revokedAt).to.equal(null);
    });

    it('(already passes) a session from before refreshes after 2FA becomes mandatory, for a user without an authenticator', async () => {
      const ctx = await setup();
      const {refreshToken, sid} = await sessionFromBefore(ctx, SCAN);
      await savePolicies(ctx, {mfa: true});
      const token = await refreshTimes(ctx, refreshToken, 3);
      expect((await ctx.service.refresh(token)).claims.sid).to.equal(sid);
    });

    it('(already passes: CB-100) a session from before still ends at the maximum session age', async () => {
      const ctx = await setup({mfa: true});
      const {refreshToken} = await sessionFromBefore(ctx, SCAN);
      let token = refreshToken;
      const start = ctx.clock().getTime();
      while (ctx.clock().getTime() + 25 * MINUTE <= start + 12 * HOUR) {
        ctx.clock.advance(25 * MINUTE);
        token = (await ctx.service.refresh(token)).refreshToken;
      }
      ctx.clock.advance(start + 12 * HOUR + MINUTE - ctx.clock().getTime());
      await rejects(ctx.service.refresh(token), 401, EXPIRED);
    });
  });

  describe('the record of 2FA, in the stores', () => {
    it('a session opened with a code is stored differently from a password-only one', async () => {
      const ctx = await setup();
      const password = await passwordSession(ctx, OTHER_SCAN);
      const withCode = await codeSession(ctx, SCAN);
      const passwordFields = newFieldsOf(
        await ctx.repo.getSession(password.claims.sid),
      );
      const codeFields = newFieldsOf(
        await ctx.repo.getSession(withCode.claims.sid),
      );
      expect(Object.keys(codeFields), 'a field recording 2FA').to.not.be.empty;
      expect(codeFields).to.not.deep.equal(passwordFields);
    });

    it('the record of 2FA is kept through refreshes', async () => {
      const ctx = await setup();
      const withCode = await codeSession(ctx, SCAN);
      const before = newFieldsOf(
        await ctx.repo.getSession(withCode.claims.sid),
      );
      expect(Object.keys(before), 'a field recording 2FA').to.not.be.empty;
      await refreshTimes(ctx, withCode.refreshToken, 3);
      const after = newFieldsOf(await ctx.repo.getSession(withCode.claims.sid));
      expect(after).to.deep.equal(before);
    });

    it('the PostgreSQL session model has a column for the record of 2FA', () => {
      const models = defineModels(
        new Sequelize('postgres://u:p@localhost:1/none', {logging: false}),
      );
      const added = Object.keys(models.Session.getAttributes()).filter(
        name => !COLUMNS_BEFORE.includes(name),
      );
      expect(added, 'a session column added by CB-103').to.not.be.empty;
    });

    it('(already passes) every field the service writes on a session exists in the PostgreSQL model', async () => {
      const models = defineModels(
        new Sequelize('postgres://u:p@localhost:1/none', {logging: false}),
      );
      const ctx = await setup();
      const password = await passwordSession(ctx, OTHER_SCAN);
      const withCode = await codeSession(ctx, SCAN);
      await refreshTimes(ctx, withCode.refreshToken, 1);
      for (const sid of [password.claims.sid, withCode.claims.sid]) {
        const session = await ctx.repo.getSession(sid);
        expect(Object.keys(models.Session.getAttributes())).to.include.members(
          Object.keys(session),
        );
      }
    });

    // Runs only with a throwaway PostgreSQL database: IDENTITY_TEST_DATABASE_URL (its identity
    // schema is dropped and made again for each test).
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

      /** The session columns CB-103 added (whatever their names). */
      async function addedColumns() {
        const columns = await sequelize
          .getQueryInterface()
          .describeTable({tableName: 'session', schema: SCHEMA});
        return Object.keys(columns).filter(
          name => !COLUMNS_BEFORE.includes(name),
        );
      }

      /** Drops the columns CB-103 added, as a database from before has its session table. */
      async function dropAddedColumns() {
        const added = await addedColumns();
        expect(added, 'a session column added by CB-103').to.not.be.empty;
        for (const name of added) {
          await sequelize.query(
            `ALTER TABLE "${SCHEMA}"."session" DROP COLUMN "${name}"`,
          );
        }
        return added;
      }

      it('a password-only session is refused after 2FA becomes mandatory; a session opened with a code refreshes', async () => {
        const repo = await freshRepo();
        const ctx = await setup({repo});
        const password = await passwordSession(ctx, OTHER_SCAN);
        const withCode = await codeSession(ctx, SCAN);
        await savePolicies(ctx, {mfa: true});
        ctx.clock.advance(MINUTE);
        await rejects(ctx.service.refresh(password.refreshToken), 401, EXPIRED);
        expect(
          (await repo.getSession(password.claims.sid)).revokedAt,
        ).to.not.equal(null);
        const token = await refreshTimes(ctx, withCode.refreshToken, 3);
        expect((await ctx.service.refresh(token)).claims.sid).to.equal(
          withCode.claims.sid,
        );
      });

      it('a password-only session is refused once the user has an authenticator', async () => {
        const repo = await freshRepo();
        const ctx = await setup({repo});
        const session = await passwordSession(ctx, SCAN);
        await enrolDirectly(ctx, SCAN);
        ctx.clock.advance(MINUTE);
        await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
      });

      it("(already passes: CB-102) the reset ends the user's sessions in the database", async () => {
        const repo = await freshRepo();
        const ctx = await setup({repo});
        const session = await codeSession(ctx, SCAN);
        await ctx.service.resetMfa((await ctx.user(SCAN)).id, ctx.actor);
        await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
        expect(
          (await repo.getSession(session.claims.sid)).revokedAt,
        ).to.not.equal(null);
      });

      it('an upgrade adds the column to a database from before, safely on every start', async () => {
        await freshRepo();
        const added = await dropAddedColumns();
        const repo = createSequelizeRepo(sequelize);
        await repo.sync();
        await repo.sync();
        expect(await addedColumns()).to.have.members(added);
      });

      it('a session existing at the upgrade is not refused for missing 2FA, even once 2FA is mandatory', async () => {
        const repo = await freshRepo();
        const ctx = await setup({repo});
        const session = await passwordSession(ctx, SCAN);
        await dropAddedColumns();
        await createSequelizeRepo(sequelize).sync();
        await savePolicies(ctx, {mfa: true});
        await enrolDirectly(ctx, SCAN);
        const token = await refreshTimes(ctx, session.refreshToken, 3);
        expect((await ctx.service.refresh(token)).claims.sid).to.equal(
          session.claims.sid,
        );
      });

      it('a new sign-in after the upgrade records 2FA again', async () => {
        const repo = await freshRepo();
        await dropAddedColumns();
        await createSequelizeRepo(sequelize).sync();
        const ctx = await setup({repo});
        const session = await passwordSession(ctx, SCAN);
        await savePolicies(ctx, {mfa: true});
        ctx.clock.advance(MINUTE);
        await rejects(ctx.service.refresh(session.refreshToken), 401, EXPIRED);
      });
    });
  });
});
