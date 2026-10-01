import { Op } from 'sequelize';
import { defineModels } from './models.js';

const plain = (row) => (row ? row.get({ plain: true }) : null);
/** Array values in `where` mean "one of". */
const toWhere = (where) => Object.fromEntries(Object.entries(where).map(([k, v]) => [k, Array.isArray(v) ? { [Op.in]: v } : v]));

/** Postgres bpm repository. Same interface as ./memory.js. */
export function createSequelizeRepo(sequelize) {
    const m = defineModels(sequelize);

    return {
        models: m,
        async sync() { await sequelize.sync(); },

        async createDefinition(d) { return plain(await m.Definition.create(d)); },
        async getDefinition(key, version) {
            return plain(await m.Definition.findOne({ where: version ? { key, version } : { key }, order: [['version', 'DESC']] }));
        },
        async getDefinitionById(id) { return plain(await m.Definition.findByPk(id)); },
        async listDefinitions() {
            const rows = (await m.Definition.findAll({ order: [['key', 'ASC'], ['version', 'DESC']] })).map(plain);
            return rows.filter((d, i) => i === 0 || rows[i - 1].key !== d.key);
        },

        async createInstance(i) { return plain(await m.Instance.create(i)); },
        async getInstance(id) { return plain(await m.Instance.findByPk(id)); },
        async updateInstance(id, patch) { await m.Instance.update(patch, { where: { id } }); },
        async findActiveInstance(definitionKey, businessKey) {
            return plain(await m.Instance.findOne({ where: { definitionKey, businessKey, status: { [Op.in]: ['active', 'error'] } } }));
        },
        async listInstances({ definitionKey, businessKey, status, startedById, limit = 50, offset = 0 } = {}) {
            const where = Object.fromEntries(Object.entries({ definitionKey, businessKey, status, startedById }).filter(([, v]) => v !== undefined));
            const { rows, count } = await m.Instance.findAndCountAll({ where, order: [['startedAt', 'DESC']], limit, offset });
            return { items: rows.map(plain), total: count };
        },

        async createToken(t) { return plain(await m.Token.create(t)); },
        async getToken(id) { return plain(await m.Token.findByPk(id)); },
        async updateToken(id, patch) { await m.Token.update(patch, { where: { id } }); },
        async updateTokenIf(id, expectedStatus, patch) {
            const [count] = await m.Token.update(patch, { where: { id, status: expectedStatus } });
            return count === 1;
        },
        async findTokens(where) { return (await m.Token.findAll({ where: toWhere(where), order: [['createdAt', 'ASC']] })).map(plain); },

        async createTask(t) { return plain(await m.Task.create(t)); },
        async getTask(id) { return plain(await m.Task.findByPk(id)); },
        async updateTaskIf(id, statuses, patch) {
            const [count] = await m.Task.update(patch, { where: { id, status: { [Op.in]: statuses } } });
            return count === 1 ? plain(await m.Task.findByPk(id)) : null;
        },
        async listTasks({ instanceId, statuses } = {}) {
            const where = {};
            if (instanceId) where.instanceId = instanceId;
            if (statuses) where.status = { [Op.in]: statuses };
            return (await m.Task.findAll({ where, order: [['createdAt', 'ASC']] })).map(plain);
        },
        async listInboxTasks({ userId, perms, roles }) {
            const rows = await m.Task.findAll({
                where: {
                    [Op.or]: [
                        { status: 'claimed', claimedById: userId },
                        { status: 'created', candidateType: 'perm', candidate: { [Op.in]: perms.length ? perms : [''] } },
                        { status: 'created', candidateType: 'role', candidate: { [Op.in]: roles.length ? roles : [''] } },
                        { status: 'created', candidateType: 'user', candidate: userId }
                    ]
                },
                order: [['createdAt', 'ASC']]
            });
            return rows.map(plain);
        },

        async addHistory(e) { await m.History.create(e); },
        async listHistory(instanceId) { return (await m.History.findAll({ where: { instanceId }, order: [['at', 'ASC']] })).map(plain); }
    };
}
