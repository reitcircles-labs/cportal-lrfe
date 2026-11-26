import {randomUUID} from 'node:crypto';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  SESSION_REVOKED,
  DEFAULT_ORG_FULL_NAME,
} from '@lrfe/common';
import {
  PERMS,
  PERM_GROUPS,
  ROLE_IDS,
  ACCESS_KINDS,
  DEFAULT_POLICIES,
  effectivePerms,
  sodConflicts,
  isKnownPerm,
  normalizePerms,
  permLabel,
  OFFICE_TYPES,
  OFFICE_CODE_PATTERN,
  ORGANISATION_CODE_PATTERN,
  NATIONAL_ROLES,
} from './catalogue.js';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  safeEqual,
} from './crypto.js';
import {CodeGuard} from './code-guard.js';
import {
  authenticatorAddedEmail,
  createMailer,
  invitationEmail,
} from './mailer.js';
import {DEFAULT_ORGANISATION_KEY, demoMfaSecret} from './seed.js';
import {
  DEFAULT_SETUP_CODE_TTL_HOURS,
  issueSetupCode,
  normaliseSetupCode,
  setupCodeHash,
} from './setup-code.js';
import {generateSecret, matchTotpStep, otpauthUrl} from './totp.js';

/** The shortest and longest maximum session age a site may set, in hours (CB-100). */
const MIN_SESSION_AGE_HOURS = 1;
const MAX_SESSION_AGE_HOURS = 168;

const SYSTEM = {id: null, name: 'System'};
const HOUR_MS = 60 * 60_000;
const normEmail = email =>
  String(email || '')
    .trim()
    .toLowerCase();
const OFFICE_TYPE_LABEL = {
  registry: 'Registry office',
  external: 'External body',
};
const isNational = roleIds => roleIds.some(r => NATIONAL_ROLES.includes(r));
// a session id is a UUID (randomUUID); anything else in a cookie never reaches the database
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSessionId = sid => SESSION_ID.test(String(sid || ''));
// the message id lets an admin find the email in the mail provider's delivery log (e.g. Google Email Log Search)
const emailNote = e =>
  e.sent
    ? `invitation emailed${e.messageId ? ` (message id ${e.messageId})` : ''}`
    : `invitation not emailed: ${e.reason}`;
// Saving a change that breaks an enabled segregation-of-duties rule is allowed (the admin confirms
// it), but the access log must show it as an exception, naming the rule(s).
const conflictNote = rules =>
  rules.length
    ? ` · duty conflict accepted: ${rules.map(r => r.label).join('; ')}`
    : '';
const nameList = (names, max = 10) =>
  names.slice(0, max).join(', ') +
  (names.length > max ? ` and ${names.length - max} more` : '');

/**
 * Identity & access: sign-in (password + TOTP), sessions, users, the fixed roles' permission
 * matrix, security policies and the admin access log. Transport-agnostic — the route layer
 * signs tokens from the `claims` this returns and owns cookies.
 */
export class IdentityService {
  constructor({
    repo,
    events,
    mailer = createMailer(),
    clock = () => new Date(),
    config = {},
  }) {
    this.repo = repo;
    this.events = events;
    this.mailer = mailer;
    this.clock = clock;
    this.config = {
      issuer: DEFAULT_ORG_FULL_NAME,
      inviteTtlHours: 72,
      // how long an administrator's one-time setup code works (CB-102)
      setupCodeTtlHours: DEFAULT_SETUP_CODE_TTL_HOURS,
      minPasswordLength: 12,
      exposeInviteLinks: false,
      inviteUrlBase: 'http://localhost:4200/#/invite',
      // how long an access token lives; a revocation is kept until the last one has expired
      accessTtlSeconds: 900,
      // limits on guessing authenticator codes (CB-101); the defaults when not given
      codeGuard: undefined,
      // end-to-end tests only (SEED_DEMO_MFA_KEY): its seeded demo users may reuse a code (CB-104)
      demoMfaKey: undefined,
      ...config,
    };
    this.dummyHash = null;
    this.codeGuard = new CodeGuard({clock, limits: this.config.codeGuard});
  }

  // ---------------------------------------------------------------- helpers

  async context() {
    const [roles, sod, policies, offices, organisations] = await Promise.all([
      this.repo.listRoles(),
      this.repo.listSod(),
      this.repo.getPolicies(),
      this.repo.listOffices(),
      this.repo.listOrganisations(),
    ]);
    roles.sort((a, b) => ROLE_IDS.indexOf(a.id) - ROLE_IDS.indexOf(b.id));
    return {
      roles,
      sod,
      // a setting added after the policies were first saved reads its default (CB-100)
      policies: {...DEFAULT_POLICIES, ...policies},
      offices,
      organisations,
    };
  }

  /** Enabled duty rules that `afterPerms` breaks and `beforePerms` did not. */
  newConflicts(beforePerms, afterPerms, sod) {
    const had = new Set(sodConflicts(beforePerms, sod).map(r => r.id));
    return sodConflicts(afterPerms, sod).filter(r => !had.has(r.id));
  }

  roleLabels(roleIds, roles) {
    return roleIds
      .map(id => roles.find(r => r.id === id)?.label || id)
      .join(', ');
  }

  publicUser(user, {roles, sod, offices = [], organisations = []}) {
    const perms = effectivePerms(user.roles, roles);
    const office = user.officeId
      ? offices.find(o => o.id === user.officeId)
      : null;
    const organisation = user.organisationId
      ? organisations.find(o => o.id === user.organisationId)
      : null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      roles: [...user.roles],
      // the office's current name; '' when the user has none (national administrators, or not assigned yet)
      office: office?.name ?? '',
      officeId: office?.id ?? null,
      officeCode: office?.code ?? null,
      // the organisation's current name (CB-19); '' only before the seed has given the user one
      organisation: organisation?.name ?? '',
      organisationId: organisation?.id ?? null,
      organisationCarrierCode: organisation?.carrierCode ?? null,
      status: user.status,
      mfa: !!user.mfaEnrolled,
      lastActive: user.lastActiveAt ?? null,
      conflicts: sodConflicts(perms, sod).map(r => r.id),
    };
  }

  /**
   * The user acting for themselves (accepting an invitation, enrolling MFA, signing in or out), with
   * their organisation for the trail.
   */
  selfActor(user) {
    return {id: user.id, name: user.name, org: user.organisationId ?? null};
  }

  async log(kind, action, target, detail, actor = SYSTEM) {
    const entry = {
      time: this.clock(),
      actorId: actor.id ?? null,
      actor: actor.name,
      kind,
      action,
      target: target || '',
      detail: detail || '',
    };
    // the access-log entry and its event are committed together (API-613)
    await this.events.atomic(async () => {
      await this.repo.addAccessEvent(entry);
      await this.events.publish(
        `identity.${kind}`,
        {action, target: entry.target, detail: entry.detail},
        {actor},
      );
    });
  }

  async requireUser(id) {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  /** The user's organisation when it is suspended (its users cannot sign in), otherwise null. */
  async suspendedOrganisationOf(user) {
    if (!user.organisationId) {
      return null;
    }
    const organisation = await this.repo.getOrganisation(user.organisationId);
    return organisation?.status === 'Suspended' ? organisation : null;
  }

  validateRoleIds(roleIds) {
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
      throw new BadRequestError('At least one role is required');
    }
    const unknown = roleIds.filter(r => !ROLE_IDS.includes(r));
    if (unknown.length) {
      throw new BadRequestError(`Unknown role(s): ${unknown.join(', ')}`);
    }
    return [...new Set(roleIds)];
  }

  /**
   * Refuse any change after which no active user could manage the permission matrix. A user of a
   * suspended organisation cannot sign in, so does not count.
   */
  assertAdminRemains(users, roles, organisations = []) {
    const suspended = new Set(
      organisations.filter(o => o.status === 'Suspended').map(o => o.id),
    );
    const ok = users.some(
      u =>
        u.status === 'Active' &&
        !suspended.has(u.organisationId) &&
        effectivePerms(u.roles, roles).includes('admin.roles'),
    );
    if (!ok) {
      throw new ConflictError(
        'This change would leave no active user able to manage roles & permissions',
      );
    }
  }

  // ---------------------------------------------------------------- sign-in & sessions

  /**
   * Step 1 of sign-in. Returns one of:
   *   { next: 'mfa', userId }                    enrolled user must send a TOTP code
   *   { next: 'setup-code', userId }             MFA required by policy, not yet enrolled: the
   *                                              administrator's setup code first (CB-102)
   *   { next: 'done', refreshToken, claims, me } signed in
   * The password alone never gives an authenticator secret (CB-102).
   */
  async login({email, password, ip}) {
    const user = await this.repo.getUserByEmail(normEmail(email));
    let ok = false;
    if (user?.passwordHash) {
      ok = await verifyPassword(String(password || ''), user.passwordHash);
    } else {
      // Spend the same time as a real check so response timing doesn't reveal which emails exist.
      this.dummyHash ??= await hashPassword(randomToken());
      await verifyPassword(String(password || ''), this.dummyHash);
    }
    if (!ok) {
      await this.log(
        'denied',
        'Sign-in failed',
        normEmail(email),
        'Wrong email or password',
      );
      throw new UnauthorizedError('Wrong email or password');
    }
    if (user.status !== 'Active') {
      await this.log(
        'denied',
        'Sign-in blocked',
        user.name,
        `Account ${user.status.toLowerCase()}`,
      );
      throw new ForbiddenError(
        'This account is suspended. Contact a system administrator.',
      );
    }
    // a suspended organisation blocks its users exactly like a suspended account (CB-19)
    const organisation = await this.suspendedOrganisationOf(user);
    if (organisation) {
      await this.log(
        'denied',
        'Sign-in blocked',
        user.name,
        `Organisation ${organisation.name} suspended`,
      );
      throw new ForbiddenError(
        'This account is suspended. Contact a system administrator.',
      );
    }
    const {policies} = await this.context();
    if (user.mfaEnrolled) return {next: 'mfa', userId: user.id};
    if (policies.mfa) {
      return {next: 'setup-code', userId: user.id};
    }
    return {
      next: 'done',
      ...(await this.startSession(user, {ip, method: 'password'})),
    };
  }

  /**
   * Step 2 of sign-in: verify a TOTP code (and complete enrolment if this is the first one) sent on
   * `challenge`, the step-1 challenge's id and expiry time in ms (the HTTP route always gives it).
   * Enrolment needs the setup code that led to it (verifySetupCode) to be still valid; it is used
   * up here, once (CB-102).
   * Guessing is limited (CB-101): a challenge is void after a number of wrong codes (401), and a
   * user with too many wrong codes in the window is locked out of this step for a while (429), the
   * right code included.
   * A code is accepted once (CB-104): a code for the time step last accepted, or an earlier one, is
   * refused like a wrong code.
   * @param {{userId: string, code: string, ip: (string|undefined),
   *     challenge: ({id: string, expiresAt: number}|undefined)}} attempt
   * @return {!Promise<!Object>} the new session, as startSession returns it
   */
  async verifyMfa({userId, code, ip, challenge}) {
    const user = await this.signingInUser(userId);
    const enrolling = !user.mfaEnrolled;
    // enrolling needs the setup code that led to this step, still valid and unused (CB-102)
    let setupCode = null;
    if (enrolling) {
      setupCode = this.validSetupCodeOf(user);
      if (!setupCode) {
        throw new UnauthorizedError('Sign-in expired, start again');
      }
    }
    const secret = enrolling ? user.pendingMfaSecret : user.mfaSecret;
    // From the check of the limits to counting a wrong code nothing is awaited, so codes sent at
    // the same time cannot all slip under a limit. Only a right code that loses a race to record its
    // step is counted after an await; its sender already has the code.
    this.assertCodeStepOpen(user, challenge);
    // a code is accepted once (CB-104): a replay is refused like a wrong code
    const step = secret
      ? matchTotpStep(secret, code, this.clock().getTime())
      : null;
    const checkReuse = !enrolling && !this.isSeededTestUser(user);
    if (step === null || (checkReuse && !this.isNewCodeStep(user, step))) {
      await this.refuseCode(user, challenge);
    }
    if (checkReuse) {
      // the step is recorded in one step of the store: of two sign-ins racing with it, one goes on
      const recorded = await this.repo.recordMfaStep(user.id, step);
      if (!recorded) {
        await this.refuseCode(user, challenge);
      }
    }
    this.codeGuard.recordSuccess(user.id);
    let current = user;
    if (enrolling) {
      // the setup code is used up here, once: of two sign-ins racing with it, one sets up
      const enrolled = await this.repo.enrolWithSetupCode(user.id, {
        setupCodeHash: setupCode,
        secret,
        step,
      });
      if (!enrolled) {
        throw new UnauthorizedError('Sign-in expired, start again');
      }
      current = await this.repo.getUser(user.id);
      await this.authenticatorAdded(user);
    }
    return this.startSession(current, {ip, method: 'MFA'});
  }

  /**
   * Step 2 of sign-in for a user without an authenticator while two-factor sign-in is required
   * (CB-102): the one-time setup code an administrator gave. The right code leads to the
   * authenticator step: a new secret to enrol, which only a code from it sets up. A wrong or
   * expired code counts towards the user's lockout of wrong codes (CB-101), like a wrong
   * authenticator code; a right one does not clear the count (only a completed sign-in does). The
   * code is used up when the authenticator is set up (verifyMfa), so stopping at the QR step lets
   * the user start again with the same code while it is valid.
   * @param {{userId: string, setupCode: *, challenge: {id: string, expiresAt: number}}} attempt
   * @return {!Promise<{userId: string, secret: string, otpauthUrl: string}>}
   */
  async verifySetupCode({userId, setupCode, challenge}) {
    const user = await this.signingInUser(userId);
    if (user.mfaEnrolled) {
      throw new UnauthorizedError('Sign-in expired, start again');
    }
    this.assertCodeStepOpen(user, challenge);
    const stored = this.validSetupCodeOf(user);
    const typed = normaliseSetupCode(setupCode);
    const right =
      stored !== null &&
      typed !== null &&
      safeEqual(setupCodeHash(user.id, typed), stored);
    if (!right) {
      await this.recordWrongCode(
        user,
        challenge,
        'Setup code failed',
        'Wrong or expired setup code',
      );
      throw new UnauthorizedError(
        'This setup code is wrong or has expired. Ask your administrator for a new one.',
      );
    }
    const secret = generateSecret();
    await this.repo.updateUser(user.id, {pendingMfaSecret: secret});
    return {
      userId: user.id,
      secret,
      otpauthUrl: otpauthUrl(secret, user.email, this.config.issuer),
    };
  }

  /**
   * The user of a sign-in's later step, who must still be allowed to sign in.
   * @param {string} userId
   * @return {!Promise<!Object>}
   * @throws {UnauthorizedError} when the user is gone, not active or in a suspended organisation
   */
  async signingInUser(userId) {
    const user = await this.repo.getUser(userId);
    if (
      !user ||
      user.status !== 'Active' ||
      (await this.suspendedOrganisationOf(user))
    ) {
      throw new UnauthorizedError('Sign-in expired, start again');
    }
    return user;
  }

  /**
   * The hash of the user's setup code while it may be used (given and not expired), else null.
   * @param {!Object} user
   * @return {?string}
   */
  validSetupCodeOf(user) {
    if (!user.setupCodeHash || !user.setupCodeExpiresAt) {
      return null;
    }
    if (new Date(user.setupCodeExpiresAt) < this.clock()) {
      return null;
    }
    return user.setupCodeHash;
  }

  /**
   * Whether `step` is later than the last time step a code of `user` was accepted for (CB-104).
   * @param {!Object} user
   * @param {number} step
   * @return {boolean}
   */
  isNewCodeStep(user, step) {
    const last = user.mfaLastStep ?? null;
    return last === null || step > last;
  }

  /**
   * Test-only (CB-104): whether `user`'s authenticator is the one the end-to-end tests' seeding
   * gave them (SEED_DEMO_MFA_KEY, which identity refuses unless NODE_ENV=test). The tests sign the
   * same demo users in from parallel workers within one time step, so these users may reuse a
   * code; everything else about the code check is unchanged. Without the key, and for every user
   * who set up an authenticator the normal way, a code is accepted once.
   * @param {!Object} user
   * @return {boolean}
   */
  isSeededTestUser(user) {
    const key = this.config.demoMfaKey;
    if (!key || !user.mfaSecret) {
      return false;
    }
    return user.mfaSecret === demoMfaSecret(key, user.email);
  }

  /**
   * Refuses an authenticator code that is wrong or was used before (CB-104): both are answered,
   * counted (CB-101) and written to the access log alike.
   * @param {!Object} user
   * @param {({id: string, expiresAt: number}|undefined)} challenge
   * @return {!Promise<void>} always rejects, with the wrong-code error
   */
  async refuseCode(user, challenge) {
    await this.recordWrongCode(
      user,
      challenge,
      'MFA failed',
      'Invalid authenticator code',
    );
    throw new UnauthorizedError('Invalid authenticator code');
  }

  /**
   * Refuses a code step the limits on guessing close (CB-101): 429 while the user is locked out,
   * 401 once the challenge used up its wrong codes. Synchronous, so nothing is awaited between
   * this check and counting the result.
   * @param {!Object} user
   * @param {({id: string, expiresAt: number}|undefined)} challenge
   */
  assertCodeStepOpen(user, challenge) {
    const refusal = this.codeGuard.refusal(user.id, challenge);
    if (refusal?.reason === 'locked') {
      const minutes = refusal.minutesLeft === 1 ? 'minute' : 'minutes';
      throw new AppError(
        429,
        `Too many wrong codes, try again in ${refusal.minutesLeft} ${minutes}`,
      );
    }
    if (refusal) {
      throw new UnauthorizedError('Too many wrong codes: sign in again');
    }
  }

  /**
   * Counts a wrong code (authenticator or setup code) towards the limits and writes it, and the
   * lockout it may cause, to the access log. Never the code itself.
   * @param {!Object} user
   * @param {({id: string, expiresAt: number}|undefined)} challenge
   * @param {string} action the access log's action, e.g. "MFA failed"
   * @param {string} detail
   */
  async recordWrongCode(user, challenge, action, detail) {
    const locked = this.codeGuard.recordWrong(user.id, challenge);
    await this.log('denied', action, user.name, detail);
    if (locked) {
      const limits = this.codeGuard.limits;
      await this.log(
        'denied',
        'MFA locked',
        user.name,
        `${limits.lockoutWrongCodes} wrong codes in ${limits.lockoutWindowMinutes} min: ` +
          `code step locked for ${limits.lockoutMinutes} min`,
      );
    }
  }

  /**
   * After an authenticator was set up: the access log, and a best-effort email to the user
   * (CB-102). Nothing waits for the email, and a mail failure never stops the sign-in.
   * @param {!Object} user
   */
  async authenticatorAdded(user) {
    await this.log(
      'user',
      'MFA enrolled',
      user.name,
      'Authenticator app',
      this.selfActor(user),
    );
    if (!this.mailer.enabled) {
      return;
    }
    const notice = authenticatorAddedEmail({
      name: user.name,
      issuer: this.config.issuer,
      at: this.clock(),
    });
    Promise.resolve()
      .then(() => this.mailer.send({to: user.email, ...notice}))
      .catch(() => {
        // best effort: the user is signed in either way
      });
  }

  /**
   * A new one-time setup code for `user` (CB-102): stored only as its hash with its expiry,
   * replacing any earlier code and any authenticator secret shown before.
   * @param {!Object} user
   * @return {!Promise<{setupCode: string, expiresAt: !Date}>} the code, to show once
   */
  async issueSetupCode(user) {
    return issueSetupCode(this.repo, user.id, {
      now: this.clock(),
      ttlHours: this.config.setupCodeTtlHours,
    });
  }

  /**
   * Opens a session for a signed-in user and records whether it was opened with 2FA (CB-103).
   * @param {!Object} user the user signing in
   * @param {{ip: (?string|undefined), method: string}} options the client address and the sign-in
   *     method: 'MFA' (an authenticator code, or the set-up after a setup code) or 'password'
   * @return {!Promise<!Object>} the refresh token, the access token claims and the user's view
   */
  async startSession(user, {ip, method}) {
    const now = this.clock();
    const sid = randomUUID();
    const secret = randomToken();
    await this.repo.createSession({
      id: sid,
      userId: user.id,
      refreshHash: sha256(secret),
      // the sign-in time, kept through refreshes: the maximum session age counts from it (CB-100)
      startedAt: now,
      lastSeenAt: now,
      revokedAt: null,
      ip: ip ?? null,
      // opened with 2FA; kept through refreshes (CB-103)
      twoFactor: method === 'MFA',
    });
    const current = await this.repo.updateUser(user.id, {lastActiveAt: now});
    const ctx = await this.context();
    await this.log(
      'session',
      'Signed in',
      user.name,
      `as ${this.roleLabels(user.roles, ctx.roles)} · ${method}`,
      this.selfActor(user),
    );
    return {
      refreshToken: `${sid}.${secret}`,
      ...this.sessionPayload(current, sid, ctx),
    };
  }

  sessionPayload(user, sid, ctx) {
    const perms = effectivePerms(user.roles, ctx.roles);
    const myRoles = ctx.roles.filter(r => user.roles.includes(r.id));
    return {
      claims: {
        typ: 'access',
        sub: user.id,
        name: user.name,
        email: user.email,
        roles: [...user.roles],
        perms,
        sid,
        // the caller's organisation, for every service (CB-20); read with organisationOf
        org: user.organisationId ?? null,
      },
      me: {
        user: this.publicUser(user, ctx),
        roles: myRoles.map(({id, label, home}) => ({id, label, home})),
        perms,
        home: myRoles[0]?.home || '/',
        policies: {
          timeout: ctx.policies.timeout,
          fourEyes: ctx.policies.fourEyes,
        },
      },
    };
  }

  /**
   * Rotate a refresh token. Enforces the idle timeout and maximum session age policies, the
   * user's current status and 2FA: a session opened without 2FA ends once 2FA is mandatory or
   * the user has an authenticator (CB-103). Its access token is not revoked: it runs out by
   * itself (at most 15 minutes).
   * @param {string} refreshToken the refresh token, `<session id>.<secret>`
   * @return {!Promise<!Object>} the new refresh token, the access token claims and the user's view
   */
  async refresh(refreshToken) {
    const [sid, secret] = String(refreshToken || '').split('.');
    const expired = () =>
      new UnauthorizedError('Session expired, sign in again');
    if (!isSessionId(sid) || !secret) throw expired();
    const session = await this.repo.getSession(sid);
    if (!session || session.revokedAt) throw expired();
    const now = this.clock();
    if (!safeEqual(sha256(secret), session.refreshHash)) {
      // An old refresh token was replayed: treat the session as compromised.
      await this.repo.updateSession(sid, {revokedAt: now});
      await this.announceRevoked({sid, reason: 'refresh token replayed'});
      throw expired();
    }
    const ctx = await this.context();
    const user = await this.repo.getUser(session.userId);
    const idleMs = now - new Date(session.lastSeenAt);
    if (idleMs > ctx.policies.timeout * 60_000) {
      await this.repo.updateSession(sid, {revokedAt: now});
      if (user) {
        await this.log(
          'session',
          'Session expired',
          user.name,
          `Idle for more than ${ctx.policies.timeout} minutes`,
        );
      }
      throw expired();
    }
    // Even an active session ends after the maximum age: the user signs in again (CB-100).
    const ageMs = now - new Date(session.startedAt);
    if (ageMs > ctx.policies.maxSessionAge * HOUR_MS) {
      await this.repo.updateSession(sid, {revokedAt: now});
      if (user) {
        await this.log(
          'session',
          'Session expired',
          user.name,
          `Older than the maximum session age of ${ctx.policies.maxSessionAge} hours`,
        );
      }
      throw expired();
    }
    const organisation = ctx.organisations.find(
      o => o.id === user?.organisationId,
    );
    if (
      !user ||
      user.status !== 'Active' ||
      organisation?.status === 'Suspended'
    ) {
      await this.repo.updateSession(sid, {revokedAt: now});
      throw expired();
    }
    // A session stored before CB-103 has no record of 2FA and is left alone.
    if (session.twoFactor === false && (ctx.policies.mfa || user.mfaEnrolled)) {
      await this.repo.updateSession(sid, {revokedAt: now});
      await this.log(
        'session',
        'Session expired',
        user.name,
        'Opened without two-factor sign-in, which is now required',
      );
      throw expired();
    }
    const next = randomToken();
    await this.repo.updateSession(sid, {
      refreshHash: sha256(next),
      lastSeenAt: now,
    });
    const current = await this.repo.updateUser(user.id, {lastActiveAt: now});
    return {
      refreshToken: `${sid}.${next}`,
      ...this.sessionPayload(current, sid, ctx),
    };
  }

  async logout({sid, actor}) {
    // a cookie that holds no session id ends nothing, like no cookie (API-819)
    if (!isSessionId(sid)) return;
    const session = await this.repo.getSession(sid);
    if (!session || session.revokedAt) return;
    await this.repo.updateSession(sid, {revokedAt: this.clock()});
    await this.announceRevoked({sid, reason: 'signed out'});
    const user = await this.repo.getUser(session.userId);
    if (user) {
      await this.log(
        'session',
        'Signed out',
        user.name,
        '',
        actor || this.selfActor(user),
      );
    }
  }

  /**
   * Tell every service that tokens of this session (sid) or user (userId, tokens issued until
   * now) must be refused from now on, not only once they expire (createRevocationList, API-610).
   * Never throws: the session is already ended in the database either way.
   */
  async announceRevoked({userId, sid, reason}) {
    const now = this.clock();
    // a minute of slack for clocks that differ between services
    const expiresAt = new Date(
      now.getTime() + (this.config.accessTtlSeconds + 60) * 1000,
    );
    try {
      // broadcast only (API-613): every service must hear it now; it is not kept in the event stream
      await this.events?.publish(
        SESSION_REVOKED,
        {
          userId,
          sid,
          reason,
          revokedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        {durable: false},
      );
    } catch {
      /* the event bus logs its own failures */
    }
  }

  async me(userId) {
    const user = await this.requireUser(userId);
    return this.sessionPayload(user, null, await this.context()).me;
  }

  // ---------------------------------------------------------------- catalogue

  async catalogue() {
    const ctx = await this.context();
    return {groups: PERM_GROUPS, perms: PERMS, roles: ctx.roles};
  }

  // ---------------------------------------------------------------- offices

  /** Offices with the number of their users who are not suspended. */
  async listOffices() {
    const [offices, users] = await Promise.all([
      this.repo.listOffices(),
      this.repo.listUsers(),
    ]);
    return offices.map(o => this.publicOffice(o, users));
  }

  publicOffice(o, users = []) {
    return {
      id: o.id,
      code: o.code,
      name: o.name,
      type: o.type,
      address: o.address,
      contact: o.contact,
      organisationId: o.organisationId ?? null,
      status: o.status,
      createdAt: o.createdAt ?? null,
      users: users.filter(u => u.officeId === o.id && u.status !== 'Suspended')
        .length,
    };
  }

  async requireOffice(id) {
    const office = await this.repo.getOffice(id);
    if (!office) throw new NotFoundError('Office not found');
    return office;
  }

  /**
   * The office a user is invited into or moved to. Everyone needs an active office, except holders
   * of a national role (administrators), who may have none. → office | null
   */
  async officeForUser(officeId, roleIds) {
    if (!officeId) {
      if (isNational(roleIds)) return null;
      throw new BadRequestError(
        'Choose an office: only system administrators can be without one',
      );
    }
    const office = await this.repo.getOffice(officeId);
    if (!office) throw new BadRequestError('That office does not exist');
    if (office.status !== 'Active') {
      throw new ConflictError(
        `${office.name} is suspended: users cannot be added to it`,
      );
    }
    return office;
  }

  officeFields({name, type, address, contact}, partial) {
    const out = {};
    if (name !== undefined || !partial) {
      if (!String(name || '').trim()) {
        throw new BadRequestError('Name is required');
      }
      out.name = String(name).trim();
    }
    if (type !== undefined || !partial) {
      const t = type ?? 'registry';
      if (!OFFICE_TYPES.includes(t)) {
        throw new BadRequestError(
          `Type must be one of: ${OFFICE_TYPES.join(', ')}`,
        );
      }
      out.type = t;
    }
    if (address !== undefined || !partial) {
      out.address = String(address ?? '').trim();
    }
    if (contact !== undefined || !partial) {
      out.contact = String(contact ?? '').trim();
    }
    return out;
  }

  /** A new office belongs to the given organisation, or to the default one (CB-19). */
  async createOffice({code, organisationId, ...rest}, actor) {
    const cleanCode = String(code || '')
      .trim()
      .toUpperCase();
    if (!new RegExp(OFFICE_CODE_PATTERN).test(cleanCode)) {
      throw new BadRequestError('The code must be 2 to 5 letters, e.g. WDH');
    }
    const fields = this.officeFields(rest, false);
    if (await this.repo.getOfficeByCode(cleanCode)) {
      throw new ConflictError(
        `An office with code ${cleanCode} already exists`,
      );
    }
    const organisation = await this.organisationToJoin(
      organisationId || (await this.defaultOrganisationId()),
    );
    const office = await this.repo.createOffice({
      code: cleanCode,
      ...fields,
      organisationId: organisation?.id ?? null,
      status: 'Active',
    });
    await this.log(
      'office',
      'Office added',
      `${office.code} · ${office.name}`,
      OFFICE_TYPE_LABEL[office.type],
      actor,
    );
    return this.publicOffice(office);
  }

  /** Name, type, address and contact can change; the code cannot. */
  async updateOffice(id, patch, actor) {
    const office = await this.requireOffice(id);
    const fields = this.officeFields(patch, true);
    const changed = Object.keys(fields).filter(k => fields[k] !== office[k]);
    if (!changed.length) {
      return this.publicOffice(office, await this.repo.listUsers());
    }
    const updated = await this.repo.updateOffice(id, fields);
    const detail = changed
      .map(k =>
        k === 'name'
          ? `name: ${office.name} → ${updated.name}`
          : k === 'type'
            ? `type: ${OFFICE_TYPE_LABEL[updated.type]}`
            : `${k} updated`,
      )
      .join(' · ');
    await this.log(
      'office',
      'Office updated',
      `${office.code} · ${updated.name}`,
      detail,
      actor,
    );
    return this.publicOffice(updated, await this.repo.listUsers());
  }

  /** Suspending stops new invitations into the office; its users and their work are unchanged. */
  async setOfficeStatus(id, status, reason, actor) {
    if (!['Active', 'Suspended'].includes(status)) {
      throw new BadRequestError('Status must be Active or Suspended');
    }
    const office = await this.requireOffice(id);
    if (office.status === status) {
      return this.publicOffice(office, await this.repo.listUsers());
    }
    const updated = await this.repo.updateOffice(id, {status});
    await this.log(
      'office',
      status === 'Suspended' ? 'Office suspended' : 'Office reactivated',
      `${office.code} · ${office.name}`,
      reason ||
        (status === 'Suspended'
          ? 'No new invitations into this office'
          : 'Invitations allowed again'),
      actor,
    );
    return this.publicOffice(updated, await this.repo.listUsers());
  }

  /** Move a user to another office (or to none, for administrators). */
  async setUserOffice(id, officeId, actor) {
    const user = await this.requireUser(id);
    const office = await this.officeForUser(officeId || null, user.roles);
    // a move never changes the user's organisation: the office must belong to it
    if (
      office?.organisationId &&
      user.organisationId &&
      office.organisationId !== user.organisationId
    ) {
      throw new BadRequestError(
        `${office.name} belongs to another organisation than ${user.name}'s`,
      );
    }
    if ((user.officeId ?? null) === (office?.id ?? null)) {
      return this.publicUser(user, await this.context());
    }
    const before = user.officeId
      ? await this.repo.getOffice(user.officeId)
      : null;
    const updated = await this.repo.updateUser(id, {
      officeId: office?.id ?? null,
    });
    await this.log(
      'user',
      'Office changed',
      user.name,
      `${before?.code ?? 'none'} → ${office?.code ?? 'National'}`,
      actor,
    );
    return this.publicUser(updated, await this.context());
  }

  // ---------------------------------------------------------------- organisations

  /** Organisations with the number of their offices, and of their users who are not suspended. */
  async listOrganisations() {
    const [organisations, offices, users] = await Promise.all([
      this.repo.listOrganisations(),
      this.repo.listOffices(),
      this.repo.listUsers(),
    ]);
    return organisations.map(o => this.publicOrganisation(o, offices, users));
  }

  /**
   * The organisations registered and active on the platform, sorted by name, with their id, code
   * and name only (CB-44): those a B/L may name as its shipper or consignee, for the record
   * service. Never the default organisation, the platform operator's own (CB-48): it takes no
   * part in a B/L.
   * @return {!Promise<!Array<{id: string, code: string, name: string}>>}
   */
  async activeOrganisations() {
    const [organisations, operatorId] = await Promise.all([
      this.repo.listOrganisations(),
      this.defaultOrganisationId(),
    ]);
    return organisations
      .filter(o => o.status === 'Active' && o.id !== operatorId)
      .map(o => ({id: o.id, code: o.code, name: o.name}))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  publicOrganisation(o, offices = [], users = []) {
    return {
      id: o.id,
      code: o.code,
      name: o.name,
      carrierCode: o.carrierCode ?? null,
      status: o.status,
      createdAt: o.createdAt ?? null,
      offices: offices.filter(x => x.organisationId === o.id).length,
      users: users.filter(
        u => u.organisationId === o.id && u.status !== 'Suspended',
      ).length,
    };
  }

  /** The organisation as listed, with its counts. */
  async organisationWithCounts(o) {
    const [offices, users] = await Promise.all([
      this.repo.listOffices(),
      this.repo.listUsers(),
    ]);
    return this.publicOrganisation(o, offices, users);
  }

  async requireOrganisation(id) {
    const organisation = await this.repo.getOrganisation(id);
    if (!organisation) throw new NotFoundError('Organisation not found');
    return organisation;
  }

  /**
   * Whether an organisation is registered and active, for the product's record service (CB-34):
   * its id, status and name, nothing else about it; `operator: true` for the default
   * organisation, the platform operator's own, which takes no part in a B/L (CB-48). 404 when
   * there is no such organisation.
   * @param {string} id
   * @return {!Promise<{id: string, status: string, name: string, operator: (boolean|undefined)}>}
   */
  async organisationStanding(id) {
    const organisation = await this.requireOrganisation(id);
    // the name too (CB-42): the parties of a B/L see each other's names
    const standing = {
      id: organisation.id,
      status: organisation.status,
      name: organisation.name,
    };
    if (organisation.id === (await this.defaultOrganisationId())) {
      standing.operator = true;
    }
    return standing;
  }

  /** The id of the default organisation (made by the seed), or null before the seed has run. */
  async defaultOrganisationId() {
    return (await this.repo.getSetting(DEFAULT_ORGANISATION_KEY)) ?? null;
  }

  /** The organisation of a signed-in actor; null for the system or an actor without one. */
  async organisationIdOf(actor) {
    if (!actor?.id) {
      return null;
    }
    return (await this.repo.getUser(actor.id))?.organisationId ?? null;
  }

  /**
   * The organisation a new user or office joins: it must exist and be active. → organisation |
   * null (no id: only before the seed has made the default organisation)
   */
  async organisationToJoin(id) {
    if (!id) {
      return null;
    }
    const organisation = await this.repo.getOrganisation(id);
    if (!organisation) {
      throw new BadRequestError('That organisation does not exist');
    }
    if (organisation.status !== 'Active') {
      throw new ConflictError(
        `${organisation.name} is suspended: nothing can be added to it`,
      );
    }
    return organisation;
  }

  organisationName(name) {
    if (!String(name || '').trim()) {
      throw new BadRequestError('Name is required');
    }
    return String(name).trim();
  }

  /**
   * Cleans an optional default carrier code (2-4 uppercase alphanumeric chars, CB-68), or null.
   * @param {*} carrierCode
   * @return {?string}
   */
  organisationCarrierCode(carrierCode) {
    if (carrierCode === null || carrierCode === undefined) {
      return null;
    }
    const clean = String(carrierCode).trim().toUpperCase();
    if (clean === '') {
      return null;
    }
    if (!/^[A-Z0-9]{2,4}$/.test(clean)) {
      throw new BadRequestError(
        'Carrier code must be 2 to 4 letters or digits',
      );
    }
    return clean;
  }

  async createOrganisation({code, name, carrierCode = null}, actor) {
    const cleanCode = String(code || '')
      .trim()
      .toUpperCase();
    if (!new RegExp(ORGANISATION_CODE_PATTERN).test(cleanCode)) {
      throw new BadRequestError('The code must be 2 to 5 letters, e.g. ABC');
    }
    const cleanName = this.organisationName(name);
    const cleanCarrierCode = this.organisationCarrierCode(carrierCode);
    if (await this.repo.getOrganisationByCode(cleanCode)) {
      throw new ConflictError(
        `An organisation with code ${cleanCode} already exists`,
      );
    }
    const organisation = await this.repo.createOrganisation({
      code: cleanCode,
      name: cleanName,
      carrierCode: cleanCarrierCode,
      status: 'Active',
    });
    await this.log(
      'organisation',
      'Organisation added',
      `${organisation.code} · ${organisation.name}`,
      '',
      actor,
    );
    return this.publicOrganisation(organisation);
  }

  /** The name and optional default carrier code can change; the code cannot. */
  async updateOrganisation(id, {name, carrierCode}, actor) {
    const organisation = await this.requireOrganisation(id);
    const patch = {};
    const details = [];
    if (name !== undefined) {
      const cleanName = this.organisationName(name);
      if (cleanName !== organisation.name) {
        patch.name = cleanName;
        details.push(`name: ${organisation.name} → ${cleanName}`);
      }
    }
    if (carrierCode !== undefined) {
      const cleanCarrier = this.organisationCarrierCode(carrierCode);
      if (cleanCarrier !== (organisation.carrierCode ?? null)) {
        patch.carrierCode = cleanCarrier;
        details.push(
          `carrier code: ${organisation.carrierCode ?? 'none'} → ${cleanCarrier ?? 'none'}`,
        );
      }
    }
    if (Object.keys(patch).length === 0) {
      return this.organisationWithCounts(organisation);
    }
    const updated = await this.repo.updateOrganisation(id, patch);
    await this.log(
      'organisation',
      'Organisation updated',
      `${organisation.code} · ${updated.name}`,
      details.join(' · '),
      actor,
    );
    return this.organisationWithCounts(updated);
  }

  /**
   * Suspending stops every user of the organisation from signing in, like a suspended account, and
   * ends their sessions; their accounts are unchanged, so reactivating lets them in again.
   */
  async setOrganisationStatus(id, status, reason, actor) {
    if (!['Active', 'Suspended'].includes(status)) {
      throw new BadRequestError('Status must be Active or Suspended');
    }
    const organisation = await this.requireOrganisation(id);
    if (organisation.status === status) {
      return this.organisationWithCounts(organisation);
    }
    const [users, ctx] = await Promise.all([
      this.repo.listUsers(),
      this.context(),
    ]);
    if (status === 'Suspended') {
      this.assertAdminRemains(
        users,
        ctx.roles,
        ctx.organisations.map(o => (o.id === id ? {...o, status} : o)),
      );
    }
    const updated = await this.repo.updateOrganisation(id, {status});
    if (status === 'Suspended') {
      for (const user of users.filter(u => u.organisationId === id)) {
        await this.repo.revokeUserSessions(user.id, this.clock());
        await this.announceRevoked({
          userId: user.id,
          reason: 'organisation suspended',
        });
      }
      const keys = await this.repo.listOrganisationApiKeys(id);
      for (const key of keys.filter(k => k.status === 'Active')) {
        await this.announceRevoked({
          sid: key.id,
          userId: `api-key:${key.id}`,
          reason: 'organisation suspended',
        });
      }
    }
    await this.log(
      'organisation',
      status === 'Suspended'
        ? 'Organisation suspended'
        : 'Organisation reactivated',
      `${organisation.code} · ${organisation.name}`,
      reason ||
        (status === 'Suspended'
          ? 'Its users cannot sign in'
          : 'Its users can sign in again'),
      actor,
    );
    return this.organisationWithCounts(updated);
  }

  // ---------------------------------------------------------------- organisation API keys (CB-56)

  /** Public representation of an API key (never includes its hash or secret). */
  publicApiKey(key) {
    return {
      id: key.id,
      organisationId: key.organisationId,
      name: key.name,
      prefix: key.prefix,
      perms: [...(key.perms ?? [])],
      status: key.status,
      createdAt: key.createdAt,
      createdByName: key.createdByName ?? null,
      revokedAt: key.revokedAt ?? null,
      lastUsedAt: key.lastUsedAt ?? null,
    };
  }

  /** Validate API key permissions: non-empty list of known non-admin permissions. */
  validateApiKeyPerms(perms) {
    if (perms === undefined) {
      const defaults = ['bl.read', 'bl.draft'].filter(isKnownPerm);
      if (defaults.length > 0) {
        return defaults;
      }
      return PERMS.filter(p => !p.id.startsWith('admin.'))
        .slice(0, 1)
        .map(p => p.id);
    }
    if (!Array.isArray(perms) || perms.length === 0) {
      throw new BadRequestError('At least one permission is required');
    }
    const clean = [...new Set(perms)];
    const invalid = clean.filter(
      p => !isKnownPerm(p) || p.startsWith('admin.'),
    );
    if (invalid.length > 0) {
      throw new BadRequestError(
        `API keys cannot hold invalid or admin permissions: ${invalid.join(', ')}`,
      );
    }
    return clean;
  }

  /** Lists all API keys of an organisation (secrets and hashes omitted). */
  async listOrganisationApiKeys(organisationId) {
    await this.requireOrganisation(organisationId);
    const keys = await this.repo.listOrganisationApiKeys(organisationId);
    return keys.map(k => this.publicApiKey(k));
  }

  /** Creates an API key for an active organisation and returns its secret once. */
  async createOrganisationApiKey(organisationId, {name, perms}, actor) {
    const organisation = await this.requireOrganisation(organisationId);
    if (organisation.status !== 'Active') {
      throw new ConflictError('Suspended organisations cannot create API keys');
    }
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName || cleanName.length > 100) {
      throw new BadRequestError(
        'API key name must be 1 to 100 characters long',
      );
    }
    const cleanPerms = this.validateApiKeyPerms(perms);
    const secret = `lrfe_${randomToken(24)}`;
    const prefix = secret.slice(0, 12);
    const created = await this.repo.createOrganisationApiKey({
      organisationId,
      name: cleanName,
      prefix,
      keyHash: sha256(secret),
      perms: cleanPerms,
      status: 'Active',
      createdById: actor?.id ?? null,
      createdByName: actor?.name ?? null,
    });
    await this.log(
      'organisation',
      'API key created',
      `${organisation.code} · ${cleanName}`,
      `${prefix}… (${cleanPerms.join(', ')})`,
      actor,
    );
    return {...this.publicApiKey(created), secret};
  }

  /** Revokes an active API key and broadcasts immediate token revocation. */
  async revokeOrganisationApiKey(organisationId, keyId, actor) {
    const organisation = await this.requireOrganisation(organisationId);
    const key = await this.repo.getOrganisationApiKey(keyId);
    if (!key || key.organisationId !== organisationId) {
      throw new NotFoundError('API key not found');
    }
    if (key.status === 'Revoked') {
      return this.publicApiKey(key);
    }
    const updated = await this.repo.updateOrganisationApiKey(keyId, {
      status: 'Revoked',
      revokedAt: this.clock(),
      revokedById: actor?.id ?? null,
    });
    await this.announceRevoked({
      sid: keyId,
      userId: `api-key:${keyId}`,
      reason: 'API key revoked',
    });
    await this.log(
      'organisation',
      'API key revoked',
      `${organisation.code} · ${key.name}`,
      `${key.prefix}…`,
      actor,
    );
    return this.publicApiKey(updated);
  }

  /** Exchanges a carrier API key secret for short-lived access token claims. */
  async exchangeApiKey(secret) {
    const raw = typeof secret === 'string' ? secret.trim() : '';
    if (!raw.startsWith('lrfe_')) {
      throw new UnauthorizedError('Invalid or revoked API key');
    }
    const key = await this.repo.getOrganisationApiKeyByHash(sha256(raw));
    if (!key || key.status !== 'Active') {
      throw new UnauthorizedError('Invalid or revoked API key');
    }
    const organisation = await this.repo.getOrganisation(key.organisationId);
    if (!organisation || organisation.status !== 'Active') {
      throw new UnauthorizedError('Organisation is not active');
    }
    await this.repo.updateOrganisationApiKey(key.id, {
      lastUsedAt: this.clock(),
    });
    return {
      claims: {
        typ: 'access',
        sub: `api-key:${key.id}`,
        name: `${key.name} (API)`,
        email: null,
        roles: [],
        perms: [...(key.perms ?? [])],
        org: organisation.id,
        sid: key.id,
      },
      apiKey: this.publicApiKey(key),
    };
  }

  // ---------------------------------------------------------------- users

  async listUsers() {
    const [users, ctx] = await Promise.all([
      this.repo.listUsers(),
      this.context(),
    ]);
    return users
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(u => this.publicUser(u, ctx));
  }

  inviteLink(token) {
    return `${this.config.inviteUrlBase}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Invite a user into an office (or none, for administrators) and an organisation: the one given,
   * else the office's, else the inviter's, else the default organisation (CB-19).
   */
  async invite({name, email, officeId = null, organisationId, roles}, actor) {
    const cleanEmail = normEmail(email);
    const roleIds = this.validateRoleIds(roles);
    if (!String(name || '').trim()) {
      throw new BadRequestError('Name is required');
    }
    if (await this.repo.getUserByEmail(cleanEmail)) {
      throw new ConflictError('A user with this email already exists');
    }
    const office = await this.officeForUser(officeId, roleIds);
    const organisation = await this.organisationToJoin(
      organisationId ||
        office?.organisationId ||
        (await this.organisationIdOf(actor)) ||
        (await this.defaultOrganisationId()),
    );
    if (
      office?.organisationId &&
      organisation &&
      office.organisationId !== organisation.id
    ) {
      throw new BadRequestError(
        `${office.name} belongs to another organisation than ${organisation.name}`,
      );
    }
    const token = randomToken();
    const expiresAt = new Date(
      this.clock().getTime() + this.config.inviteTtlHours * 3_600_000,
    );
    const user = await this.repo.createUser({
      name: name.trim(),
      email: cleanEmail,
      officeId: office?.id ?? null,
      organisationId: organisation?.id ?? null,
      roles: roleIds,
      status: 'Invited',
      inviteHash: sha256(token),
      inviteExpiresAt: expiresAt,
    });
    const ctx = await this.context();
    const roleText = this.roleLabels(roleIds, ctx.roles);
    const mail = await this.emailInvitation(
      user,
      token,
      expiresAt,
      roleText,
      actor,
      false,
    );
    const conflicts = sodConflicts(effectivePerms(roleIds, ctx.roles), ctx.sod);
    // The link is a credential until used: it goes to the user by email, and to the admin only
    // when IDENTITY_EXPOSE_INVITE_LINKS=true (dev). Never into events or logs.
    await this.events.atomic(async () => {
      await this.log(
        'user',
        'Invited',
        user.name,
        `${office ? office.code : 'National'} · Roles: ${roleText}${conflictNote(conflicts)} · ${emailNote(mail)}`,
        actor,
      );
      await this.events.publish(
        'identity.user.invited',
        {
          userId: user.id,
          email: user.email,
          name: user.name,
          emailSent: mail.sent,
        },
        {actor},
      );
    });
    return {
      user: this.publicUser(user, ctx),
      email: mail,
      ...(this.config.exposeInviteLinks
        ? {inviteUrl: this.inviteLink(token)}
        : {}),
    };
  }

  async resendInvite(id, actor) {
    const user = await this.requireUser(id);
    if (user.status !== 'Invited') {
      throw new ConflictError(
        'Only invited users can be sent a new invitation',
      );
    }
    const office = user.officeId
      ? await this.repo.getOffice(user.officeId)
      : null;
    if (office?.status === 'Suspended') {
      throw new ConflictError(
        `${office.name} is suspended: reactivate it, or move the user to another office first`,
      );
    }
    const token = randomToken();
    const expiresAt = new Date(
      this.clock().getTime() + this.config.inviteTtlHours * 3_600_000,
    );
    await this.repo.updateUser(id, {
      inviteHash: sha256(token),
      inviteExpiresAt: expiresAt,
    });
    const ctx = await this.context();
    const mail = await this.emailInvitation(
      user,
      token,
      expiresAt,
      this.roleLabels(user.roles, ctx.roles),
      actor,
      true,
    );
    await this.events.atomic(async () => {
      await this.log(
        'user',
        'Invitation resent',
        user.name,
        `${user.email} · ${emailNote(mail)}`,
        actor,
      );
      await this.events.publish(
        'identity.user.invited',
        {
          userId: user.id,
          email: user.email,
          name: user.name,
          emailSent: mail.sent,
        },
        {actor},
      );
    });
    return {
      email: mail,
      ...(this.config.exposeInviteLinks
        ? {inviteUrl: this.inviteLink(token)}
        : {}),
    };
  }

  /**
   * Email the invitation link. Never throws: the user exists either way, and the admin is told
   * whether the email went out → { sent, to, reason? }.
   */
  async emailInvitation(user, token, expiresAt, roles, actor, resend) {
    if (!this.mailer.enabled) {
      return {
        sent: false,
        to: user.email,
        reason: 'Email is not configured on the server',
      };
    }
    try {
      const content = invitationEmail({
        name: user.name,
        link: this.inviteLink(token),
        expiresAt,
        invitedBy: actor?.name || 'An administrator',
        roles,
        issuer: this.config.issuer,
        resend,
      });
      const res = await this.mailer.send({to: user.email, ...content});
      return {
        sent: true,
        to: user.email,
        ...(res?.id ? {messageId: res.id} : {}),
      };
    } catch (err) {
      return {sent: false, to: user.email, reason: err.message};
    }
  }

  /**
   * Accepting an invitation. While two-factor sign-in is required the authenticator is set up
   * here, before the link is used up (CB-102): the link is the proof the password alone is not.
   * Without `code` the answer is the authenticator's secret ({ next: 'mfa-enroll', email, secret,
   * otpauthUrl }) and the account stays invited; with the code from it the account is activated
   * with the authenticator. Wrong codes count towards the user's lockout of wrong codes (CB-101).
   * @param {{token: string, password: string, code: (string|undefined)}} acceptance
   * @return {!Promise<!Object>} { email } once active
   */
  async acceptInvite({token, password, code}) {
    const user = token
      ? await this.repo.getUserByInviteHash(sha256(String(token)))
      : null;
    if (
      !user ||
      user.status !== 'Invited' ||
      new Date(user.inviteExpiresAt) < this.clock()
    ) {
      throw new BadRequestError(
        'This invitation is invalid or has expired. Ask an administrator to resend it.',
      );
    }
    if (String(password || '').length < this.config.minPasswordLength) {
      throw new BadRequestError(
        `Password must be at least ${this.config.minPasswordLength} characters`,
      );
    }
    const {policies} = await this.context();
    const withAuthenticator = policies.mfa && !user.mfaEnrolled;
    if (withAuthenticator && code === undefined) {
      const secret = generateSecret();
      await this.repo.updateUser(user.id, {pendingMfaSecret: secret});
      return {
        next: 'mfa-enroll',
        email: user.email,
        secret,
        otpauthUrl: otpauthUrl(secret, user.email, this.config.issuer),
      };
    }
    const patch = {
      passwordHash: await hashPassword(password),
      status: 'Active',
      inviteHash: null,
      inviteExpiresAt: null,
    };
    if (withAuthenticator) {
      this.assertCodeStepOpen(user);
      const secret = user.pendingMfaSecret;
      const step = secret
        ? matchTotpStep(secret, code, this.clock().getTime())
        : null;
      if (step === null) {
        await this.refuseCode(user, undefined);
      }
      this.codeGuard.recordSuccess(user.id);
      // the step of the code that set it up counts as used (CB-104)
      Object.assign(patch, {
        mfaEnrolled: true,
        mfaSecret: secret,
        pendingMfaSecret: null,
        mfaLastStep: step,
      });
    }
    await this.repo.updateUser(user.id, patch);
    await this.log(
      'user',
      'Invitation accepted',
      user.name,
      user.email,
      this.selfActor(user),
    );
    if (withAuthenticator) {
      await this.authenticatorAdded(user);
    }
    return {email: user.email};
  }

  async setUserRoles(id, roles, actor) {
    if (id === actor.id) {
      throw new ForbiddenError('You cannot change your own roles');
    }
    const roleIds = this.validateRoleIds(roles);
    const user = await this.requireUser(id);
    const [users, ctx] = await Promise.all([
      this.repo.listUsers(),
      this.context(),
    ]);
    this.assertAdminRemains(
      users.map(u => (u.id === id ? {...u, roles: roleIds} : u)),
      ctx.roles,
      ctx.organisations,
    );
    const added = roleIds
      .filter(r => !user.roles.includes(r))
      .map(r => '+ ' + this.roleLabels([r], ctx.roles));
    const removed = user.roles
      .filter(r => !roleIds.includes(r))
      .map(r => '− ' + this.roleLabels([r], ctx.roles));
    const conflicts = this.newConflicts(
      effectivePerms(user.roles, ctx.roles),
      effectivePerms(roleIds, ctx.roles),
      ctx.sod,
    );
    const updated = await this.repo.updateUser(id, {roles: roleIds});
    if (added.length + removed.length) {
      await this.log(
        'user',
        'Roles changed',
        user.name,
        [...added, ...removed].join(', ') + conflictNote(conflicts),
        actor,
      );
    }
    return this.publicUser(updated, ctx);
  }

  async setStatus(id, status, reason, actor) {
    if (!['Active', 'Suspended'].includes(status)) {
      throw new BadRequestError(`Status must be Active or Suspended`);
    }
    if (id === actor.id) {
      throw new ForbiddenError('You cannot change your own status');
    }
    const user = await this.requireUser(id);
    const ctx = await this.context();
    if (status === 'Suspended') {
      if (user.status === 'Suspended') return this.publicUser(user, ctx);
      const users = await this.repo.listUsers();
      this.assertAdminRemains(
        users.map(u => (u.id === id ? {...u, status} : u)),
        ctx.roles,
        ctx.organisations,
      );
      const updated = await this.repo.updateUser(id, {status: 'Suspended'});
      await this.repo.revokeUserSessions(id, this.clock());
      await this.announceRevoked({userId: id, reason: 'suspended'});
      await this.log(
        'user',
        'Suspended',
        user.name,
        reason || 'Access revoked',
        actor,
      );
      return this.publicUser(updated, ctx);
    }
    if (user.status !== 'Suspended') {
      throw new ConflictError('Only suspended users can be reactivated');
    }
    // Someone suspended before accepting their invitation goes back to Invited, not Active.
    const updated = await this.repo.updateUser(id, {
      status: user.passwordHash ? 'Active' : 'Invited',
    });
    await this.log(
      'user',
      'Reactivated',
      user.name,
      reason || 'Access restored',
      actor,
    );
    return this.publicUser(updated, ctx);
  }

  /**
   * "Reset 2FA" (CB-102): the user's authenticator stops working, their sessions end at once, and
   * the administrator gets a one-time setup code to give them, shown only in this answer.
   * Invited users set up their authenticator when they accept the invitation.
   * @param {string} id
   * @param {!Object} actor
   * @return {!Promise<{user: !Object, setupCode: string, expiresAt: !Date}>}
   */
  async resetMfa(id, actor) {
    const user = await this.requireUser(id);
    if (user.status === 'Invited') {
      throw new ConflictError(
        'Invited users set up their authenticator when they accept the invitation',
      );
    }
    await this.repo.updateUser(id, {
      mfaEnrolled: false,
      mfaSecret: null,
      // the next authenticator starts afresh (CB-104)
      mfaLastStep: null,
    });
    const {setupCode, expiresAt} = await this.issueSetupCode(user);
    await this.repo.revokeUserSessions(id, this.clock());
    await this.announceRevoked({userId: id, reason: 'authenticator reset'});
    await this.log(
      'user',
      'MFA reset',
      user.name,
      `Sessions ended; setup code given, valid for ${this.config.setupCodeTtlHours} hours`,
      actor,
    );
    const updated = await this.repo.getUser(id);
    return {
      user: this.publicUser(updated, await this.context()),
      setupCode,
      expiresAt,
    };
  }

  /**
   * "Give setup code" (CB-102): a one-time setup code for an active user without an authenticator,
   * shown only in this answer. A new code voids the one given before.
   * @param {string} id
   * @param {!Object} actor
   * @return {!Promise<{user: !Object, setupCode: string, expiresAt: !Date}>}
   */
  async giveSetupCode(id, actor) {
    const user = await this.requireUser(id);
    if (user.status !== 'Active') {
      throw new ConflictError(
        user.status === 'Invited'
          ? 'Invited users set up their authenticator when they accept the invitation'
          : 'Only active users can be given a setup code',
      );
    }
    if (user.mfaEnrolled) {
      throw new ConflictError(
        'This user has an authenticator: reset 2FA to give a setup code',
      );
    }
    const {setupCode, expiresAt} = await this.issueSetupCode(user);
    await this.log(
      'user',
      'Setup code given',
      user.name,
      `One use, valid for ${this.config.setupCodeTtlHours} hours`,
      actor,
    );
    return {
      user: this.publicUser(user, await this.context()),
      setupCode,
      expiresAt,
    };
  }

  // ---------------------------------------------------------------- roles (fixed set, editable permissions)

  async listRoles() {
    return (await this.context()).roles;
  }

  /** `matrix` maps role id → full permission list for that role. Roles left out are unchanged. */
  async saveMatrix(matrix, actor) {
    if (!matrix || typeof matrix !== 'object') {
      throw new BadRequestError('matrix is required');
    }
    const unknownRoles = Object.keys(matrix).filter(
      id => !ROLE_IDS.includes(id),
    );
    if (unknownRoles.length) {
      throw new BadRequestError(`Unknown role(s): ${unknownRoles.join(', ')}`);
    }
    for (const [id, perms] of Object.entries(matrix)) {
      if (!Array.isArray(perms)) {
        throw new BadRequestError(`Permissions for ${id} must be a list`);
      }
      const bad = perms.filter(p => !isKnownPerm(p));
      if (bad.length) {
        throw new BadRequestError(`Unknown permission(s): ${bad.join(', ')}`);
      }
    }
    const [users, ctx] = await Promise.all([
      this.repo.listUsers(),
      this.context(),
    ]);
    const next = ctx.roles.map(r =>
      matrix[r.id] ? {...r, perms: normalizePerms(matrix[r.id])} : r,
    );
    this.assertAdminRemains(users, next, ctx.organisations);

    let changes = 0;
    for (const role of next) {
      const before = new Set(ctx.roles.find(r => r.id === role.id).perms);
      const after = new Set(role.perms);
      const add = PERMS.filter(p => after.has(p.id) && !before.has(p.id)).map(
        p => '+ ' + p.label,
      );
      const rem = PERMS.filter(p => before.has(p.id) && !after.has(p.id)).map(
        p => '− ' + p.label,
      );
      if (add.length + rem.length) {
        changes += add.length + rem.length;
        await this.repo.updateRolePerms(role.id, role.perms);
        await this.log(
          'role',
          'Permissions changed',
          role.label,
          [...add, ...rem].join(', '),
          actor,
        );
      }
    }
    // A role change can put every holder of the role in conflict at once: log who, and which rule.
    const created = users
      .map(u => ({
        u,
        rules: this.newConflicts(
          effectivePerms(u.roles, ctx.roles),
          effectivePerms(u.roles, next),
          ctx.sod,
        ),
      }))
      .filter(x => x.rules.length);
    if (created.length) {
      await this.log(
        'role',
        'Duty conflict accepted',
        `${created.length} user${created.length === 1 ? '' : 's'}`,
        nameList(
          created.map(
            ({u, rules}) => `${u.name} (${rules.map(r => r.label).join('; ')})`,
          ),
        ),
        actor,
      );
    }
    return {roles: next, changes};
  }

  // ---------------------------------------------------------------- policies

  /** The policies other services enforce, read each time they need them (API-663): only those, no settings. */
  async effectivePolicies() {
    const {policies} = await this.context();
    return {fourEyes: policies.fourEyes !== false};
  }

  async getPolicySettings() {
    const {policies, sod} = await this.context();
    return {policies, sod};
  }

  async savePolicies({policies, sod = []}, actor) {
    const p = policies || {};
    for (const k of ['mfa', 'eid', 'ipAllow', 'fourEyes']) {
      if (typeof p[k] !== 'boolean') {
        throw new BadRequestError(`policies.${k} must be true or false`);
      }
    }
    if (!Number.isInteger(p.timeout) || p.timeout < 5 || p.timeout > 480) {
      throw new BadRequestError(
        'policies.timeout must be a whole number of minutes between 5 and 480',
      );
    }
    const ctx = await this.context();
    // A save without the maximum session age keeps the current value (CB-100).
    const maxSessionAge = Object.hasOwn(p, 'maxSessionAge')
      ? p.maxSessionAge
      : ctx.policies.maxSessionAge;
    if (
      !Number.isInteger(maxSessionAge) ||
      maxSessionAge < MIN_SESSION_AGE_HOURS ||
      maxSessionAge > MAX_SESSION_AGE_HOURS
    ) {
      throw new BadRequestError(
        `policies.maxSessionAge must be a whole number of hours between ${MIN_SESSION_AGE_HOURS} and ${MAX_SESSION_AGE_HOURS}`,
      );
    }
    const unknown = sod.filter(r => !ctx.sod.some(x => x.id === r.id));
    if (unknown.length) {
      throw new BadRequestError(
        `Unknown segregation-of-duties rule(s): ${unknown.map(r => r.id).join(', ')}`,
      );
    }

    const old = ctx.policies;
    const ch = [];
    const users = await this.repo.listUsers();
    if (old.mfa !== p.mfa) ch.push('MFA ' + (p.mfa ? 'required' : 'optional'));
    if (old.eid !== p.eid) ch.push('National eID ' + (p.eid ? 'on' : 'off'));
    if (old.ipAllow !== p.ipAllow) {
      ch.push('Network restriction ' + (p.ipAllow ? 'on' : 'off'));
    }
    if (old.timeout !== p.timeout) {
      ch.push(`Session timeout ${old.timeout} → ${p.timeout} min`);
    }
    if (old.maxSessionAge !== maxSessionAge) {
      ch.push(`Maximum session age ${old.maxSessionAge} → ${maxSessionAge} h`);
    }
    if (old.fourEyes !== p.fourEyes) {
      ch.push('Four-eyes finalization ' + (p.fourEyes ? 'on' : 'off'));
    }
    // Only the on/off switch of a rule is editable; the rule definitions are fixed.
    const nextSod = ctx.sod.map(rule => {
      const incoming = sod.find(r => r.id === rule.id);
      if (
        !incoming ||
        typeof incoming.on !== 'boolean' ||
        incoming.on === rule.on
      ) {
        return rule;
      }
      // Enabling a rule that users already break turns their roles into accepted exceptions.
      const breaking = incoming.on
        ? users.filter(
            u =>
              sodConflicts(effectivePerms(u.roles, ctx.roles), [
                {...rule, on: true},
              ]).length,
          )
        : [];
      ch.push(
        (incoming.on ? 'Enabled: ' : 'Disabled: ') +
          rule.label +
          (breaking.length
            ? ` (duty conflict accepted for ${breaking.length} user${breaking.length === 1 ? '' : 's'}: ${nameList(breaking.map(u => u.name))})`
            : ''),
      );
      return {...rule, on: incoming.on};
    });

    const nextPolicies = {
      mfa: p.mfa,
      eid: p.eid,
      ipAllow: p.ipAllow,
      timeout: p.timeout,
      maxSessionAge,
      fourEyes: p.fourEyes,
    };
    await this.repo.savePolicies(nextPolicies);
    await this.repo.saveSod(nextSod);
    await this.log(
      'policy',
      'Policy updated',
      'Security policies',
      ch.join(' · ') || 'No changes',
      actor,
    );
    return {policies: nextPolicies, sod: nextSod, changes: ch.length};
  }

  // ---------------------------------------------------------------- access log

  async listAccessLog({kind, limit = 50, offset = 0} = {}) {
    if (kind && !ACCESS_KINDS.includes(kind)) {
      throw new BadRequestError(`Unknown kind "${kind}"`);
    }
    return this.repo.listAccessEvents({kind, limit, offset});
  }

  /** Called by the auth guard when a signed-in user hits an endpoint they lack permission for. */
  async recordDenied(user, perm) {
    const label = String(perm).split(' | ').map(permLabel).join(' or ');
    await this.log('denied', 'Access denied', user?.name || '—', label);
  }
}
