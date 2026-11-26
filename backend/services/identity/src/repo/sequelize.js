import {DataTypes, Op} from 'sequelize';
import {inTransaction} from '@lrfe/common';
import {defineModels, SCHEMA} from './models.js';

const POLICIES_KEY = 'security.policies';
const OFFICE_FIELDS = [
  'code',
  'name',
  'type',
  'address',
  'contact',
  'organisationId',
  'status',
];
const ORGANISATION_FIELDS = ['code', 'name', 'carrierCode', 'status'];
const API_KEY_FIELDS = [
  'organisationId',
  'name',
  'prefix',
  'keyHash',
  'perms',
  'status',
  'createdById',
  'createdByName',
  'revokedAt',
  'revokedById',
  'lastUsedAt',
];
const USER_FIELDS = [
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
  'mfaLastStep',
  'inviteHash',
  'inviteExpiresAt',
  'lastActiveAt',
];

/** Postgres implementation of the identity repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
  const m = defineModels(sequelize);

  const toUser = (row, roleIds) =>
    row && {...row.get({plain: true}), roles: roleIds};
  const rolesOf = async (userId, transaction) =>
    (await m.UserRole.findAll({where: {userId}, transaction})).map(
      r => r.roleId,
    );
  const pick = (obj, keys) =>
    Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));

  async function setRoles(userId, roleIds, transaction) {
    await m.UserRole.destroy({where: {userId}, transaction});
    await m.UserRole.bulkCreate(
      roleIds.map(roleId => ({userId, roleId})),
      {transaction},
    );
  }

  async function findUser(where) {
    const row = await m.User.findOne({where});
    return row ? toUser(row, await rolesOf(row.id)) : null;
  }

  return {
    models: m,
    /**
     * Create missing tables, then bring tables created by an older version up to date.
     * sequelize.sync() never adds columns to an existing table, so each later column is added
     * here, idempotently (safe on every start).
     */
    async sync() {
      await sequelize.sync();
      const q = sequelize.getQueryInterface();
      const user = {tableName: 'user', schema: SCHEMA};
      const office = {tableName: 'office', schema: SCHEMA};
      const userColumns = await q.describeTable(user);
      if (!userColumns.officeId) {
        await q.addColumn(user, 'officeId', {type: DataTypes.UUID});
      }
      // CB-19: the organisation of each user and office (filled in by the seed)
      if (!userColumns.organisationId) {
        await q.addColumn(user, 'organisationId', {type: DataTypes.UUID});
      }
      // CB-102: the one-time setup code of a user without an authenticator
      if (!userColumns.setupCodeHash) {
        await q.addColumn(user, 'setupCodeHash', {type: DataTypes.STRING});
      }
      if (!userColumns.setupCodeExpiresAt) {
        await q.addColumn(user, 'setupCodeExpiresAt', {type: DataTypes.DATE});
      }
      // CB-104: the time step of the last accepted authenticator code
      if (!userColumns.mfaLastStep) {
        await q.addColumn(user, 'mfaLastStep', {type: DataTypes.INTEGER});
      }
      if (!(await q.describeTable(office)).organisationId) {
        await q.addColumn(office, 'organisationId', {type: DataTypes.UUID});
      }
      // CB-68: optional default SMDG carrier code per organisation
      const organisation = {tableName: 'organisation', schema: SCHEMA};
      if (!(await q.describeTable(organisation)).carrierCode) {
        await q.addColumn(organisation, 'carrierCode', {
          type: DataTypes.STRING(4),
        });
      }
      // CB-100: the sign-in time of each session. A session from before gets its creation time
      // (the upgrade time if none is stored); the column is NOT NULL once filled. A start that
      // stopped half-way (column added, still optional) finishes the step on the next start.
      const session = {tableName: 'session', schema: SCHEMA};
      const startedAt = (await q.describeTable(session)).startedAt;
      if (!startedAt || startedAt.allowNull) {
        if (!startedAt) {
          await q.addColumn(session, 'startedAt', {type: DataTypes.DATE});
        }
        await sequelize.query(
          `UPDATE "${SCHEMA}"."session" SET "startedAt" = COALESCE("createdAt", NOW()) WHERE "startedAt" IS NULL`,
        );
        await q.changeColumn(session, 'startedAt', {
          type: DataTypes.DATE,
          allowNull: false,
        });
      }
      for (const kind of ['office', 'organisation']) {
        await sequelize.query(
          `ALTER TYPE "${SCHEMA}"."enum_access_event_kind" ADD VALUE IF NOT EXISTS '${kind}'`,
        );
      }
    },

    async getSetting(key) {
      return (await m.Setting.findByPk(key))?.value ?? null;
    },
    async setSetting(key, value) {
      await m.Setting.upsert({key, value});
    },

    async listOffices() {
      return (await m.Office.findAll({order: [['code', 'ASC']]})).map(r =>
        r.get({plain: true}),
      );
    },
    async getOffice(id) {
      return (await m.Office.findByPk(id))?.get({plain: true}) ?? null;
    },
    async getOfficeByCode(code) {
      return (
        (await m.Office.findOne({where: {code}}))?.get({plain: true}) ?? null
      );
    },
    async createOffice(data) {
      return (await m.Office.create(pick(data, OFFICE_FIELDS))).get({
        plain: true,
      });
    },
    async updateOffice(id, patch) {
      const row = await m.Office.findByPk(id);
      if (!row) return null;
      await row.update(
        pick(
          patch,
          OFFICE_FIELDS.filter(f => f !== 'code'),
        ),
      );
      return row.get({plain: true});
    },

    async listOrganisations() {
      return (await m.Organisation.findAll({order: [['code', 'ASC']]})).map(r =>
        r.get({plain: true}),
      );
    },
    async getOrganisation(id) {
      return (await m.Organisation.findByPk(id))?.get({plain: true}) ?? null;
    },
    async getOrganisationByCode(code) {
      return (
        (await m.Organisation.findOne({where: {code}}))?.get({plain: true}) ??
        null
      );
    },
    async createOrganisation(data) {
      return (await m.Organisation.create(pick(data, ORGANISATION_FIELDS))).get(
        {plain: true},
      );
    },
    async updateOrganisation(id, patch) {
      const row = await m.Organisation.findByPk(id);
      if (!row) return null;
      await row.update(
        pick(
          patch,
          ORGANISATION_FIELDS.filter(f => f !== 'code'),
        ),
      );
      return row.get({plain: true});
    },
    /** Put every office and user without an organisation into this one → { offices, users } counts. */
    async assignOrganisation(organisationId) {
      return inTransaction(sequelize, async transaction => {
        const where = {organisationId: null};
        const [offices] = await m.Office.update(
          {organisationId},
          {where, transaction},
        );
        const [users] = await m.User.update(
          {organisationId},
          {where, transaction},
        );
        return {offices, users};
      });
    },

    async listUsers() {
      const [rows, links] = await Promise.all([
        m.User.findAll({order: [['name', 'ASC']]}),
        m.UserRole.findAll(),
      ]);
      return rows.map(r =>
        toUser(
          r,
          links.filter(l => l.userId === r.id).map(l => l.roleId),
        ),
      );
    },
    getUser: id => findUser({id}),
    getUserByEmail: email => findUser({email}),
    getUserByInviteHash: inviteHash => findUser({inviteHash}),
    async createUser(data) {
      return inTransaction(sequelize, async transaction => {
        const row = await m.User.create(pick(data, USER_FIELDS), {transaction});
        await setRoles(row.id, data.roles || [], transaction);
        return toUser(row, data.roles || []);
      });
    },
    async updateUser(id, patch) {
      return inTransaction(sequelize, async transaction => {
        const row = await m.User.findByPk(id, {transaction});
        if (!row) return null;
        await row.update(pick(patch, USER_FIELDS), {transaction});
        if (patch.roles) await setRoles(id, patch.roles, transaction);
        return toUser(row, patch.roles || (await rolesOf(id, transaction)));
      });
    },

    /**
     * Sets up the user's authenticator with `secret` only while the user has none and still holds
     * the setup code of `setupCodeHash`, which is used up (CB-102). In one statement, so two
     * sign-ins with the same code set up one authenticator at most.
     * The time step of the code that set it up is recorded as the last accepted one (CB-104).
     * @param {string} id
     * @param {{setupCodeHash: string, secret: string, step: number}} enrolment
     * @return {!Promise<boolean>} whether this call set it up
     */
    async enrolWithSetupCode(id, {setupCodeHash, secret, step}) {
      const [count] = await m.User.update(
        {
          mfaEnrolled: true,
          mfaSecret: secret,
          pendingMfaSecret: null,
          setupCodeHash: null,
          setupCodeExpiresAt: null,
          mfaLastStep: step,
        },
        {where: {id, setupCodeHash, mfaEnrolled: false}},
      );
      return count === 1;
    },

    /**
     * Records `step` as the user's last accepted authenticator time step, only when it is later
     * than the one recorded (or none is), so a code is accepted once (CB-104). In one statement,
     * so of two sign-ins with the same code one records it.
     * @param {string} id
     * @param {number} step
     * @return {!Promise<boolean>} whether this call recorded it
     */
    async recordMfaStep(id, step) {
      const [count] = await m.User.update(
        {mfaLastStep: step},
        {
          where: {
            id,
            [Op.or]: [{mfaLastStep: null}, {mfaLastStep: {[Op.lt]: step}}],
          },
        },
      );
      return count === 1;
    },

    async listRoles() {
      return (await m.Role.findAll()).map(r => r.get({plain: true}));
    },
    async upsertRole(role) {
      await m.Role.upsert(role);
    },
    async updateRolePerms(id, perms) {
      await m.Role.update({perms}, {where: {id}});
    },

    async getPolicies() {
      return (await m.Setting.findByPk(POLICIES_KEY))?.value ?? null;
    },
    async savePolicies(value) {
      await m.Setting.upsert({key: POLICIES_KEY, value});
    },
    async listSod() {
      return (await m.SodRule.findAll({order: [['id', 'ASC']]})).map(
        ({id, a, b, label, enabled}) => ({id, a, b, label, on: enabled}),
      );
    },
    async saveSod(rules) {
      await inTransaction(sequelize, async transaction => {
        for (const {id, a, b, label, on} of rules) {
          const existing = await m.SodRule.findByPk(id, {transaction});
          if (existing) await existing.update({enabled: on}, {transaction});
          else {
            await m.SodRule.create(
              {id, a, b, label, enabled: on},
              {transaction},
            );
          }
        }
      });
    },

    async createSession(s) {
      return (await m.Session.create(s)).get({plain: true});
    },
    async getSession(id) {
      return (await m.Session.findByPk(id))?.get({plain: true}) ?? null;
    },
    async updateSession(id, patch) {
      await m.Session.update(patch, {where: {id}});
    },
    async revokeUserSessions(userId, at) {
      await m.Session.update(
        {revokedAt: at},
        {where: {userId, revokedAt: null}},
      );
    },

    async addAccessEvent(e) {
      await m.AccessEvent.create(e);
    },
    async listAccessEvents({kind, limit = 50, offset = 0} = {}) {
      const {rows, count} = await m.AccessEvent.findAndCountAll({
        where: kind ? {kind} : {},
        order: [['id', 'DESC']],
        limit,
        offset,
      });
      return {items: rows.map(r => r.get({plain: true})), total: count};
    },

    async listOrganisationApiKeys(organisationId) {
      return (
        await m.OrganisationApiKey.findAll({
          where: {organisationId},
          order: [['createdAt', 'DESC']],
        })
      ).map(r => r.get({plain: true}));
    },
    async getOrganisationApiKey(id) {
      return (
        (await m.OrganisationApiKey.findByPk(id))?.get({plain: true}) ?? null
      );
    },
    async getOrganisationApiKeyByHash(keyHash) {
      return (
        (await m.OrganisationApiKey.findOne({where: {keyHash}}))?.get({
          plain: true,
        }) ?? null
      );
    },
    async createOrganisationApiKey(data) {
      return (
        await m.OrganisationApiKey.create(pick(data, API_KEY_FIELDS))
      ).get({plain: true});
    },
    async updateOrganisationApiKey(id, patch) {
      const row = await m.OrganisationApiKey.findByPk(id);
      if (!row) {
        return null;
      }
      await row.update(pick(patch, API_KEY_FIELDS));
      return row.get({plain: true});
    },
  };
}
