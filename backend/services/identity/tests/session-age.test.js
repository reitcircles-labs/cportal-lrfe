import {expect} from 'chai';
import {Sequelize} from 'sequelize';
import {ensureSchema} from '@lrfe/common';
import {
  makeService,
  makeApp,
  makeClock,
  codeFor,
  enrolWithSetupCode,
  PASSWORD,
} from './helpers.js';
import {DEFAULT_POLICIES} from '../src/catalogue.js';
import {defineModels, SCHEMA} from '../src/repo/models.js';
import {createSequelizeRepo} from '../src/repo/sequelize.js';

// CB-100: a session has a maximum age (site policy `maxSessionAge`, whole hours, default 12),
// counted from sign-in. Refresh refuses an older session, ends it and logs it; the user signs in
// again with password and authenticator code. Younger sessions refresh as before.

const ADMIN = 'p.hamutenya@deeds.gov.na';
const SCAN = 'k.iipinge@deeds.gov.na';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EXPIRED = 'Session expired, sign in again';

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
 * Keeps a session active (never idle) by refreshing every 25 minutes until `ageMs` after sign-in.
 * @param {!Object} service
 * @param {function(): !Date} clock the controllable test clock
 * @param {string} refreshToken the token received at sign-in
 * @param {number} ageMs how long after sign-in to stop
 * @return {!Promise<string>} the latest refresh token
 */
async function keepActive(service, clock, refreshToken, ageMs) {
  const start = clock().getTime();
  let token = refreshToken;
  while (clock().getTime() + 25 * MINUTE <= start + ageMs) {
    clock.advance(25 * MINUTE);
    token = (await service.refresh(token)).refreshToken;
  }
  clock.advance(start + ageMs - clock().getTime());
  return token;
}

/** The policies of the test site, as an administrator would save them. */
async function savePolicies(service, actor, changes) {
  const {policies} = await service.getPolicySettings();
  return service.savePolicies({policies: {...policies, ...changes}}, actor);
}

/** The 'Session expired' entries of the access log. */
async function expiryEvents(repo) {
  const {items} = await repo.listAccessEvents({kind: 'session'});
  return items.filter(e => e.action === 'Session expired');
}

describe('maximum session age (CB-100)', () => {
  async function setup(opts) {
    const ctx = await makeService(opts);
    const admin = await ctx.user(ADMIN);
    return {...ctx, actor: {id: admin.id, name: admin.name}};
  }

  describe('the setting', () => {
    it('defaults to 12 hours', () => {
      expect(DEFAULT_POLICIES.maxSessionAge).to.equal(12);
    });

    it('a site whose policies were saved before the setting existed reads the 12-hour default', async () => {
      // makeService saves policies without maxSessionAge, as an install from before CB-100 has them
      const {service} = await setup();
      const {policies} = await service.getPolicySettings();
      expect(policies.maxSessionAge).to.equal(12);
      expect(policies.timeout).to.equal(30);
    });

    it('is saved with the other policies and logged in the change summary', async () => {
      const {service, repo, actor} = await setup();
      const res = await savePolicies(service, actor, {maxSessionAge: 8});
      expect(res.policies.maxSessionAge).to.equal(8);
      expect(res.changes).to.equal(1);
      expect(
        (await service.getPolicySettings()).policies.maxSessionAge,
      ).to.equal(8);
      const {items} = await repo.listAccessEvents({kind: 'policy'});
      expect(items[0].detail).to.include('Maximum session age 12 → 8');
    });

    it('saving the same maximum age again changes nothing', async () => {
      const {service, actor} = await setup();
      const res = await savePolicies(service, actor, {maxSessionAge: 12});
      expect(res.changes).to.equal(0);
    });

    for (const bad of [0, -1, 2.5, '12', null, 'toString', Number.NaN]) {
      const shown = typeof bad === 'string' ? `"${bad}"` : String(bad);
      it(`refuses a maximum session age of ${shown} with 400`, async () => {
        const {service, actor} = await setup();
        await rejects(
          savePolicies(service, actor, {maxSessionAge: bad}),
          400,
          'maxSessionAge',
        );
        expect(
          (await service.getPolicySettings()).policies.maxSessionAge,
        ).to.equal(12);
      });
    }
  });

  describe('a session younger than the maximum age', () => {
    it('refreshes as before, all the way to just under 12 hours after sign-in', async () => {
      const {service, clock, repo} = await setup();
      const {refreshToken} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(
        service,
        clock,
        refreshToken,
        12 * HOUR - MINUTE,
      );
      const next = await service.refresh(token);
      expect(next.refreshToken).to.not.equal(token);
      expect(next.claims.sub).to.equal((await repo.getUserByEmail(SCAN)).id);
      expect(await expiryEvents(repo)).to.deep.equal([]);
    });

    it('still expires when idle for longer than the idle timeout, logged as idle', async () => {
      const {service, clock, repo} = await setup();
      const {refreshToken} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      clock.advance(31 * MINUTE);
      await rejects(service.refresh(refreshToken), 401, EXPIRED);
      const [event] = await expiryEvents(repo);
      expect(event.detail).to.equal('Idle for more than 30 minutes');
    });

    it('keeps its sign-in time when refreshed (the age counts from sign-in, not the last refresh)', async () => {
      const {service, clock, repo} = await setup();
      const signedInAt = clock().toISOString();
      const {refreshToken, claims} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      await keepActive(service, clock, refreshToken, 2 * HOUR);
      const session = await repo.getSession(claims.sid);
      expect(new Date(session.startedAt).toISOString()).to.equal(signedInAt);
      expect(new Date(session.lastSeenAt).getTime()).to.be.greaterThan(
        Date.parse(signedInAt),
      );
    });
  });

  describe('a session older than the maximum age', () => {
    it('is refused at refresh even though it was never idle', async () => {
      const {service, clock} = await setup();
      const {refreshToken} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(
        service,
        clock,
        refreshToken,
        12 * HOUR + MINUTE,
      );
      await rejects(service.refresh(token), 401, EXPIRED);
    });

    it('is ended in the database at the time it is refused', async () => {
      const {service, clock, repo} = await setup();
      const {refreshToken, claims} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(
        service,
        clock,
        refreshToken,
        12 * HOUR + MINUTE,
      );
      await rejects(service.refresh(token), 401);
      const session = await repo.getSession(claims.sid);
      expect(new Date(session.revokedAt).toISOString()).to.equal(
        clock().toISOString(),
      );
    });

    it('is written to the access log as an expired session naming the user and the maximum age', async () => {
      const {service, clock, repo} = await setup();
      const {refreshToken} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(
        service,
        clock,
        refreshToken,
        12 * HOUR + MINUTE,
      );
      await rejects(service.refresh(token), 401);
      const events = await expiryEvents(repo);
      expect(events).to.have.length(1);
      expect(events[0].target).to.equal('Kristofina Iipinge');
      expect(events[0].detail).to.match(/maximum session age/i);
      expect(events[0].detail).to.include('12 hours');
    });

    it('stays ended when the administrator raises the maximum age afterwards', async () => {
      const {service, clock, actor} = await setup();
      const {refreshToken} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(
        service,
        clock,
        refreshToken,
        12 * HOUR + MINUTE,
      );
      await rejects(service.refresh(token), 401);
      await savePolicies(service, actor, {maxSessionAge: 24});
      await rejects(service.refresh(token), 401, EXPIRED);
    });

    it('follows the saved setting: with 2 hours, a session refreshes at 1 h 59 and is refused at 2 h 01', async () => {
      const {service, clock, actor} = await setup();
      await savePolicies(service, actor, {maxSessionAge: 2});
      const first = await service.login({email: SCAN, password: PASSWORD});
      const token = await keepActive(
        service,
        clock,
        first.refreshToken,
        2 * HOUR - MINUTE,
      );
      const next = await service.refresh(token);
      clock.advance(2 * MINUTE);
      await rejects(service.refresh(next.refreshToken), 401, EXPIRED);
    });

    it('applies to sessions already running when the administrator shortens the maximum age', async () => {
      const {service, clock, actor} = await setup();
      const {refreshToken} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(service, clock, refreshToken, 3 * HOUR);
      await savePolicies(service, actor, {maxSessionAge: 2});
      await rejects(service.refresh(token), 401, EXPIRED);
    });

    it('two refreshes racing on an over-age session are both refused and the session stays ended', async () => {
      const {service, clock, repo} = await setup();
      const {refreshToken, claims} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      const token = await keepActive(
        service,
        clock,
        refreshToken,
        12 * HOUR + MINUTE,
      );
      const results = await Promise.allSettled([
        service.refresh(token),
        service.refresh(token),
      ]);
      expect(results.map(r => r.status)).to.deep.equal([
        'rejected',
        'rejected',
      ]);
      expect(results.map(r => r.reason.statusCode)).to.deep.equal([401, 401]);
      expect((await repo.getSession(claims.sid)).revokedAt).to.not.equal(null);
    });

    it('the user signs in again with password and authenticator code and gets a fresh session', async () => {
      const {service, clock, user} = await setup({mfa: true});
      // CB-102: the authenticator is set up with a setup code
      const {session: first} = await enrolWithSetupCode(service, clock, SCAN);
      const enrol = {userId: first.claims.sub};
      const token = await keepActive(
        service,
        clock,
        first.refreshToken,
        12 * HOUR + MINUTE,
      );
      await rejects(service.refresh(token), 401, EXPIRED);

      // the password alone is not enough: the authenticator code is asked again
      const again = await service.login({email: SCAN, password: PASSWORD});
      expect(again).to.deep.equal({next: 'mfa', userId: enrol.userId});
      clock.advance(30_000);
      const secret = (await user(SCAN)).mfaSecret;
      const fresh = await service.verifyMfa({
        userId: again.userId,
        code: codeFor(secret, clock),
      });
      expect(fresh.claims.sid).to.not.equal(first.claims.sid);

      // the new session's age counts from this sign-in
      const later = await keepActive(
        service,
        clock,
        fresh.refreshToken,
        11 * HOUR,
      );
      expect((await service.refresh(later)).claims.sub).to.equal(enrol.userId);
    });
  });

  describe('over HTTP', () => {
    it('refresh of an over-age session: 401 and the refresh cookie is cleared', async () => {
      const {app, login, service, clock} = await makeApp({clock: makeClock()});
      const {cookie} = await login(SCAN);
      const token = await keepActive(
        service,
        clock,
        cookie,
        12 * HOUR + MINUTE,
      );
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {lrfe_rt: token},
      });
      expect(res.statusCode).to.equal(401);
      const cleared = res.cookies.find(c => c.name === 'lrfe_rt');
      expect(cleared.value).to.equal('');
    });

    it('the administrator reads the maximum session age with the policies', async () => {
      const {app, login, auth} = await makeApp();
      const {token} = await login(ADMIN);
      const res = await app.inject({url: '/policies', headers: auth(token)});
      expect(res.statusCode).to.equal(200);
      expect(res.json().policies.maxSessionAge).to.equal(12);
    });

    it('the administrator saves the maximum session age with the policies', async () => {
      const {app, login, auth} = await makeApp();
      const {token} = await login(ADMIN);
      const {policies} = (
        await app.inject({url: '/policies', headers: auth(token)})
      ).json();
      const saved = await app.inject({
        method: 'PUT',
        url: '/policies',
        headers: auth(token),
        payload: {policies: {...policies, maxSessionAge: 8}},
      });
      expect(saved.statusCode).to.equal(200);
      expect(saved.json().policies.maxSessionAge).to.equal(8);
      const read = await app.inject({url: '/policies', headers: auth(token)});
      expect(read.json().policies.maxSessionAge).to.equal(8);
    });
  });

  describe('the session start, in the stores', () => {
    it('the PostgreSQL session model has a startedAt column', () => {
      const models = defineModels(
        new Sequelize('postgres://u:p@localhost:1/none', {logging: false}),
      );
      const attrs = Object.keys(models.Session.getAttributes());
      expect(attrs).to.include('startedAt');
    });

    it('every field the service writes on a session exists in the PostgreSQL model', async () => {
      const models = defineModels(
        new Sequelize('postgres://u:p@localhost:1/none', {logging: false}),
      );
      const {service, repo, clock} = await setup();
      const {refreshToken, claims} = await service.login({
        email: SCAN,
        password: PASSWORD,
      });
      clock.advance(MINUTE);
      await service.refresh(refreshToken);
      const session = await repo.getSession(claims.sid);
      expect(Object.keys(models.Session.getAttributes())).to.include.members(
        Object.keys(session),
      );
      expect(session.startedAt).to.not.equal(undefined);
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

      it('keeps the sign-in time through refreshes and refuses the session after the maximum age', async () => {
        const repo = await freshRepo();
        const {service, clock} = await makeService({repo});
        const signedInAt = clock().toISOString();
        const {refreshToken, claims} = await service.login({
          email: SCAN,
          password: PASSWORD,
        });
        const token = await keepActive(service, clock, refreshToken, 2 * HOUR);
        const kept = await repo.getSession(claims.sid);
        expect(new Date(kept.startedAt).toISOString()).to.equal(signedInAt);

        // refresh at the 2-hour mark, so the next stretch starts active (never idle 30 min)
        const atTwoHours = (await service.refresh(token)).refreshToken;
        const last = await keepActive(
          service,
          clock,
          atTwoHours,
          10 * HOUR + MINUTE,
        );
        await rejects(service.refresh(last), 401, EXPIRED);
        expect((await repo.getSession(claims.sid)).revokedAt).to.not.equal(
          null,
        );
      });

      it('an upgrade adds the session start column to a database from before, safely on every start', async () => {
        await freshRepo();
        await sequelize.query(
          `ALTER TABLE "${SCHEMA}"."session" DROP COLUMN "startedAt"`,
        );
        const repo = createSequelizeRepo(sequelize);
        await repo.sync();
        await repo.sync();
        const columns = await sequelize
          .getQueryInterface()
          .describeTable({tableName: 'session', schema: SCHEMA});
        expect(columns).to.have.property('startedAt');
      });

      it('a session existing at the upgrade gets its creation time as its start, and still refreshes', async () => {
        const repo = await freshRepo();
        const {service, clock} = await makeService({repo});
        const {refreshToken, claims} = await service.login({
          email: SCAN,
          password: PASSWORD,
        });
        const created = (await repo.getSession(claims.sid)).createdAt;
        await sequelize.query(
          `ALTER TABLE "${SCHEMA}"."session" DROP COLUMN "startedAt"`,
        );
        await createSequelizeRepo(sequelize).sync();
        const upgraded = await repo.getSession(claims.sid);
        expect(new Date(upgraded.startedAt).toISOString()).to.equal(
          new Date(created).toISOString(),
        );
        clock.advance(MINUTE);
        await service.refresh(refreshToken);
      });

      it('the maximum session age is saved and read back from the database', async () => {
        const repo = await freshRepo();
        const {service, user} = await makeService({repo});
        const admin = await user(ADMIN);
        await savePolicies(
          service,
          {id: admin.id, name: admin.name},
          {maxSessionAge: 6},
        );
        expect((await repo.getPolicies()).maxSessionAge).to.equal(6);
      });
    });
  });
});
