import {randomUUID} from 'node:crypto';

const clone = v => (v === undefined ? v : structuredClone(v));

/**
 * In-memory implementation of the identity repository. Used by the tests and by
 * IDENTITY_STORE=memory (run the service without Postgres while wiring up the frontend).
 * Must stay behaviourally identical to ./sequelize.js — the service only sees this interface.
 */
export function createMemoryRepo() {
  const users = new Map();
  const roles = new Map();
  const sod = new Map();
  const sessions = new Map();
  const events = [];
  const offices = new Map();
  const organisations = new Map();
  const settings = new Map();
  let policies = null;
  let eventSeq = 0;

  return {
    // users
    async listUsers() {
      return [...users.values()].map(clone);
    },
    async getUser(id) {
      return clone(users.get(id)) ?? null;
    },
    async getUserByEmail(email) {
      return clone([...users.values()].find(u => u.email === email)) ?? null;
    },
    async getUserByInviteHash(hash) {
      return (
        clone([...users.values()].find(u => u.inviteHash === hash)) ?? null
      );
    },
    async createUser(data) {
      const user = {
        id: randomUUID(),
        office: '',
        officeId: null,
        organisationId: null,
        status: 'Invited',
        roles: [],
        passwordHash: null,
        mfaEnrolled: false,
        mfaSecret: null,
        pendingMfaSecret: null,
        inviteHash: null,
        inviteExpiresAt: null,
        lastActiveAt: null,
        createdAt: new Date(),
        ...clone(data),
      };
      users.set(user.id, user);
      return clone(user);
    },
    async updateUser(id, patch) {
      const user = users.get(id);
      if (!user) return null;
      Object.assign(user, clone(patch));
      return clone(user);
    },

    // settings (key → JSON value)
    async getSetting(key) {
      return clone(settings.get(key)) ?? null;
    },
    async setSetting(key, value) {
      settings.set(key, clone(value));
    },

    // offices (never deleted; the code never changes)
    async listOffices() {
      return [...offices.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(clone);
    },
    async getOffice(id) {
      return clone(offices.get(id)) ?? null;
    },
    async getOfficeByCode(code) {
      return clone([...offices.values()].find(o => o.code === code)) ?? null;
    },
    async createOffice(data) {
      const now = new Date();
      const office = {
        id: randomUUID(),
        type: 'registry',
        address: '',
        contact: '',
        organisationId: null,
        status: 'Active',
        createdAt: now,
        updatedAt: now,
        ...clone(data),
      };
      offices.set(office.id, office);
      return clone(office);
    },
    async updateOffice(id, patch) {
      const office = offices.get(id);
      if (!office) return null;
      const {code, ...rest} = clone(patch);
      Object.assign(office, rest, {updatedAt: new Date()});
      return clone(office);
    },

    // organisations (never deleted; the code never changes)
    async listOrganisations() {
      return [...organisations.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(clone);
    },
    async getOrganisation(id) {
      return clone(organisations.get(id)) ?? null;
    },
    async getOrganisationByCode(code) {
      return (
        clone([...organisations.values()].find(o => o.code === code)) ?? null
      );
    },
    async createOrganisation(data) {
      const now = new Date();
      const organisation = {
        id: randomUUID(),
        status: 'Active',
        createdAt: now,
        updatedAt: now,
        ...clone(data),
      };
      organisations.set(organisation.id, organisation);
      return clone(organisation);
    },
    async updateOrganisation(id, patch) {
      const organisation = organisations.get(id);
      if (!organisation) return null;
      const {code, ...rest} = clone(patch);
      Object.assign(organisation, rest, {updatedAt: new Date()});
      return clone(organisation);
    },
    /** Put every office and user without an organisation into this one → { offices, users } counts. */
    async assignOrganisation(organisationId) {
      const counts = {offices: 0, users: 0};
      for (const office of offices.values()) {
        if (!office.organisationId) {
          office.organisationId = organisationId;
          counts.offices++;
        }
      }
      for (const user of users.values()) {
        if (!user.organisationId) {
          user.organisationId = organisationId;
          counts.users++;
        }
      }
      return counts;
    },

    // roles (fixed set; only perms change after seeding)
    async listRoles() {
      return [...roles.values()].map(clone);
    },
    async upsertRole(role) {
      roles.set(role.id, {...roles.get(role.id), ...clone(role)});
    },
    async updateRolePerms(id, perms) {
      const role = roles.get(id);
      if (role) role.perms = [...perms];
    },

    // policies & segregation of duties
    async getPolicies() {
      return clone(policies);
    },
    async savePolicies(p) {
      policies = clone(p);
    },
    async listSod() {
      return [...sod.values()].map(clone);
    },
    async saveSod(rules) {
      rules.forEach(r => sod.set(r.id, {...sod.get(r.id), ...clone(r)}));
    },

    // sessions
    async createSession(s) {
      sessions.set(s.id, clone(s));
      return clone(s);
    },
    async getSession(id) {
      return clone(sessions.get(id)) ?? null;
    },
    async updateSession(id, patch) {
      if (sessions.has(id)) Object.assign(sessions.get(id), clone(patch));
    },
    async revokeUserSessions(userId, at) {
      for (const s of sessions.values()) {
        if (s.userId === userId && !s.revokedAt) s.revokedAt = at;
      }
    },

    // access log (append-only)
    async addAccessEvent(e) {
      events.push({id: ++eventSeq, ...clone(e)});
    },
    async listAccessEvents({kind, limit = 50, offset = 0} = {}) {
      const all = events
        .filter(e => !kind || e.kind === kind)
        .sort((a, b) => b.id - a.id);
      return {
        items: all.slice(offset, offset + limit).map(clone),
        total: all.length,
      };
    },
  };
}
