import {DataTypes} from 'sequelize';
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
const ORGANISATION_FIELDS = ['code', 'name', 'status'];
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
      if (!(await q.describeTable(office)).organisationId) {
        await q.addColumn(office, 'organisationId', {type: DataTypes.UUID});
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
  };
}
