import {randomUUID} from 'node:crypto';
import {
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
import {createMailer, invitationEmail} from './mailer.js';
import {DEFAULT_ORGANISATION_KEY} from './seed.js';
import {generateSecret, otpauthUrl, verifyTotp} from './totp.js';

const SYSTEM = {id: null, name: 'System'};
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
      minPasswordLength: 12,
      exposeInviteLinks: false,
      inviteUrlBase: 'http://localhost:4200/#/invite',
      // how long an access token lives; a revocation is kept until the last one has expired
      accessTtlSeconds: 900,
      ...config,
    };
    this.dummyHash = null;
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
      policies: policies ?? DEFAULT_POLICIES,
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
   *   { next: 'mfa', userId }                                    enrolled user must send a TOTP code
   *   { next: 'mfa-enroll', userId, secret, otpauthUrl }         MFA required by policy, not yet enrolled
   *   { next: 'done', refreshToken, claims, me }                 signed in
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
      const secret = generateSecret();
      await this.repo.updateUser(user.id, {pendingMfaSecret: secret});
      return {
        next: 'mfa-enroll',
        userId: user.id,
        secret,
        otpauthUrl: otpauthUrl(secret, user.email, this.config.issuer),
      };
    }
    return {
      next: 'done',
      ...(await this.startSession(user, {ip, method: 'password'})),
    };
  }

  /** Step 2 of sign-in: verify a TOTP code (and complete enrolment if this is the first one). */
  async verifyMfa({userId, code, ip}) {
    const user = await this.repo.getUser(userId);
    if (
      !user ||
      user.status !== 'Active' ||
      (await this.suspendedOrganisationOf(user))
    ) {
      throw new UnauthorizedError('Sign-in expired, start again');
    }
    const enrolling = !user.mfaEnrolled;
    const secret = enrolling ? user.pendingMfaSecret : user.mfaSecret;
    // TODO: remember the last accepted time step per user to block code replay within the window.
    if (!secret || !verifyTotp(secret, code, this.clock().getTime())) {
      await this.log(
        'denied',
        'MFA failed',
        user.name,
        'Invalid authenticator code',
      );
      throw new UnauthorizedError('Invalid authenticator code');
    }
    let current = user;
    if (enrolling) {
      current = await this.repo.updateUser(user.id, {
        mfaSecret: secret,
        mfaEnrolled: true,
        pendingMfaSecret: null,
      });
      await this.log(
        'user',
        'MFA enrolled',
        user.name,
        'Authenticator app',
        this.selfActor(user),
      );
    }
    return this.startSession(current, {ip, method: 'MFA'});
  }

  async startSession(user, {ip, method}) {
    const now = this.clock();
    const sid = randomUUID();
    const secret = randomToken();
    await this.repo.createSession({
      id: sid,
      userId: user.id,
      refreshHash: sha256(secret),
      lastSeenAt: now,
      revokedAt: null,
      ip: ip ?? null,
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

  /** Rotate a refresh token. Enforces the idle timeout policy and the user's current status. */
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

  publicOrganisation(o, offices = [], users = []) {
    return {
      id: o.id,
      code: o.code,
      name: o.name,
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

  async createOrganisation({code, name}, actor) {
    const cleanCode = String(code || '')
      .trim()
      .toUpperCase();
    if (!new RegExp(ORGANISATION_CODE_PATTERN).test(cleanCode)) {
      throw new BadRequestError('The code must be 2 to 5 letters, e.g. ABC');
    }
    const cleanName = this.organisationName(name);
    if (await this.repo.getOrganisationByCode(cleanCode)) {
      throw new ConflictError(
        `An organisation with code ${cleanCode} already exists`,
      );
    }
    const organisation = await this.repo.createOrganisation({
      code: cleanCode,
      name: cleanName,
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

  /** The name can change; the code cannot. */
  async updateOrganisation(id, {name}, actor) {
    const organisation = await this.requireOrganisation(id);
    if (name === undefined) {
      return this.organisationWithCounts(organisation);
    }
    const cleanName = this.organisationName(name);
    if (cleanName === organisation.name) {
      return this.organisationWithCounts(organisation);
    }
    const updated = await this.repo.updateOrganisation(id, {name: cleanName});
    await this.log(
      'organisation',
      'Organisation updated',
      `${organisation.code} · ${updated.name}`,
      `name: ${organisation.name} → ${updated.name}`,
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

  async acceptInvite({token, password}) {
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
    await this.repo.updateUser(user.id, {
      passwordHash: await hashPassword(password),
      status: 'Active',
      inviteHash: null,
      inviteExpiresAt: null,
    });
    await this.log(
      'user',
      'Invitation accepted',
      user.name,
      user.email,
      this.selfActor(user),
    );
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

  async resetMfa(id, actor) {
    const user = await this.requireUser(id);
    const updated = await this.repo.updateUser(id, {
      mfaEnrolled: false,
      mfaSecret: null,
      pendingMfaSecret: null,
    });
    await this.log(
      'user',
      'MFA reset',
      user.name,
      'Must re-enrol at next sign-in',
      actor,
    );
    return this.publicUser(updated, await this.context());
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
