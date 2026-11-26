import {createEventBus, createRevocationList} from '@lrfe/common';
import {IdentityService} from '../src/identity.service.js';
import {createMemoryRepo} from '../src/repo/memory.js';
import {seedIdentity} from '../src/seed.js';
import {buildApp} from '../src/app.js';
import {totp} from '../src/totp.js';

export const PASSWORD = 'correct horse battery staple';
export const JWT_SECRET = 'identity-test-secret-identity-test-secret';

/** A controllable clock: `clock.advance(ms)`. */
export function makeClock(start = Date.parse('2026-09-28T08:00:00Z')) {
  let now = start;
  const clock = () => new Date(now);
  clock.advance = ms => {
    now += ms;
  };
  return clock;
}

/**
 * Service over a seeded in-memory repo. Demo users all share PASSWORD. MFA policy off unless `mfa`.
 * `clock` defaults to a controllable fake one; pass `() => new Date()` where tokens' real issue
 * times must line up with the service's clock (revocations). `repo`: another store (PostgreSQL).
 * `mailer`: a mailer of the test's own (the service's default when left out); `config`: settings
 * added to the service's config.
 */
export async function makeService({
  mfa = false,
  clock = makeClock(),
  repo = createMemoryRepo(),
  mailer = undefined,
  config = {},
} = {}) {
  await seedIdentity(repo, {demoPassword: PASSWORD});
  await repo.savePolicies({
    mfa,
    eid: true,
    ipAllow: false,
    timeout: 30,
    fourEyes: true,
  });
  const events = createEventBus({driver: 'memory', source: 'identity'});
  const published = [];
  events.subscribe('*', e => published.push(e));
  const service = new IdentityService({
    repo,
    events,
    clock,
    mailer,
    config: {exposeInviteLinks: true, ...config},
  });
  const user = async email => repo.getUserByEmail(email);
  // users (other than administrators) are invited into an office
  const office = await repo.createOffice({
    code: 'WDH',
    name: 'Deeds Registry · Windhoek',
    type: 'registry',
  });
  return {repo, service, clock, published, user, office, events};
}

/**
 * The service behind its HTTP app, ready for requests. `logger`: the app's logger options (none
 * when left out), for tests that read what the app logs.
 */
export async function makeApp({logger, ...opts} = {}) {
  const ctx = await makeService(opts);
  const app = await buildApp({
    service: ctx.service,
    jwtSecret: JWT_SECRET,
    cookie: {name: 'lrfe_rt', path: '/api/auth', secure: false},
    revocations: createRevocationList({events: ctx.events}),
    ...(logger ? {logger} : {}),
  });
  await app.ready();

  /** Sign in over HTTP (no MFA) and return { token, cookie, body }. */
  async function login(email, password = PASSWORD) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {email, password},
    });
    if (res.statusCode !== 200) {
      throw new Error(`login failed ${res.statusCode}: ${res.body}`);
    }
    const cookie = res.cookies.find(c => c.name === 'lrfe_rt');
    return {
      token: res.json().accessToken,
      cookie: cookie?.value,
      body: res.json(),
    };
  }
  const auth = token => ({authorization: `Bearer ${token}`});
  return {...ctx, app, login, auth};
}

/** The authenticator code for `secret` at the test clock's time. */
export const codeFor = (secret, clock) => totp(secret, clock().getTime());

/**
 * A 6-digit code that is wrong for `secret` at the test clock's time: none of the codes the
 * server accepts (the current one and one step of clock drift either side).
 * @param {string} secret
 * @param {function(): !Date} clock
 * @return {string}
 */
export function wrongCodeFor(secret, clock) {
  const at = clock().getTime();
  const accepted = new Set(
    [-30_000, 0, 30_000].map(drift => totp(secret, at + drift)),
  );
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!accepted.has(candidate)) {
      return candidate;
    }
  }
}

/** The administrator who gives setup codes in tests that call the service directly (CB-102). */
export const SETUP_ACTOR = {id: null, name: 'Test administrator'};

/**
 * The password step of a user without an authenticator and the setup-code step after it, through
 * the service (CB-102): an administrator gives a setup code, the user enters it. Returns the
 * authenticator step: the user's id and the secret to enrol (not enrolled yet).
 * @param {!Object} service
 * @param {string} email
 * @param {string=} password
 * @return {!Promise<{userId: string, secret: string, otpauthUrl: string}>}
 */
export async function setupCodeStep(service, email, password = PASSWORD) {
  const step1 = await service.login({email, password});
  if (step1.next !== 'setup-code') {
    throw new Error(
      `${email}: expected the setup-code step, got ${step1.next}`,
    );
  }
  const {setupCode} = await service.giveSetupCode(step1.userId, SETUP_ACTOR);
  return service.verifySetupCode({userId: step1.userId, setupCode});
}

/**
 * Sets up `email`'s authenticator the way a user without one does (CB-102), through the service:
 * a setup code, then the authenticator's code. Returns the secret and the new session.
 * @param {!Object} service
 * @param {function(): !Date} clock
 * @param {string} email
 * @param {string=} password
 * @return {!Promise<{secret: string, session: !Object}>}
 */
export async function enrolWithSetupCode(
  service,
  clock,
  email,
  password = PASSWORD,
) {
  const step = await setupCodeStep(service, email, password);
  const session = await service.verifyMfa({
    userId: step.userId,
    code: codeFor(step.secret, clock),
  });
  return {secret: step.secret, session};
}
