const clone = (v) => (v === undefined ? v : structuredClone(v));

/** `where` values match by equality; an array value means "one of". */
const matches = (row, where) => Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));

/** In-memory bpm repository (tests, BPM_STORE=memory). Same interface as ./sequelize.js. */
export function createMemoryRepo() {
    const definitions = [];
    const instances = new Map();
    const tokens = new Map();
    const tasks = new Map();
    const history = [];

    return {
        // definitions (immutable, versioned)
        async createDefinition(d) { definitions.push(clone(d)); return clone(d); },
        async getDefinition(key, version) {
            const all = definitions.filter(d => d.key === key && (!version || d.version === version)).sort((a, b) => b.version - a.version);
            return clone(all[0]) ?? null;
        },
        async getDefinitionById(id) { return clone(definitions.find(d => d.id === id)) ?? null; },
        async listDefinitions() {
            const latest = new Map();
            for (const d of definitions) if (!latest.has(d.key) || latest.get(d.key).version < d.version) latest.set(d.key, d);
            return [...latest.values()].map(clone);
        },

        // instances
        async createInstance(i) { instances.set(i.id, clone(i)); return clone(i); },
        async getInstance(id) { return clone(instances.get(id)) ?? null; },
        async updateInstance(id, patch) { Object.assign(instances.get(id), clone(patch)); },
        async findActiveInstance(definitionKey, businessKey) {
            return clone([...instances.values()].find(i => i.definitionKey === definitionKey && i.businessKey === businessKey && ['active', 'error'].includes(i.status))) ?? null;
        },
        async listInstances({ definitionKey, businessKey, status, startedById, limit = 50, offset = 0 } = {}) {
            const where = Object.fromEntries(Object.entries({ definitionKey, businessKey, status, startedById }).filter(([, v]) => v !== undefined));
            const all = [...instances.values()].filter(i => matches(i, where)).sort((a, b) => b.startedAt - a.startedAt);
            return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
        },

        // tokens
        async createToken(t) { tokens.set(t.id, clone(t)); return clone(t); },
        async getToken(id) { return clone(tokens.get(id)) ?? null; },
        async updateToken(id, patch) { Object.assign(tokens.get(id), clone(patch)); },
        async updateTokenIf(id, expectedStatus, patch) {
            const t = tokens.get(id);
            if (!t || t.status !== expectedStatus) return false;
            Object.assign(t, clone(patch));
            return true;
        },
        async findTokens(where) { return [...tokens.values()].filter(t => matches(t, where)).map(clone); },

        // tasks
        async createTask(t) { tasks.set(t.id, clone(t)); return clone(t); },
        async getTask(id) { return clone(tasks.get(id)) ?? null; },
        async updateTaskIf(id, statuses, patch) {
            const t = tasks.get(id);
            if (!t || !statuses.includes(t.status)) return null;
            Object.assign(t, clone(patch));
            return clone(t);
        },
        async listTasks({ instanceId, statuses } = {}) {
            return [...tasks.values()]
                .filter(t => (!instanceId || t.instanceId === instanceId) && (!statuses || statuses.includes(t.status)))
                .sort((a, b) => a.createdAt - b.createdAt).map(clone);
        },
        /** Open tasks the user could see in their inbox (eligibility, incl. exclusions, is checked by the engine). */
        async listInboxTasks({ userId, perms, roles }) {
            return [...tasks.values()].filter(t =>
                (t.status === 'claimed' && t.claimedById === userId) ||
                (t.status === 'created' && ((t.candidateType === 'perm' && perms.includes(t.candidate)) ||
                    (t.candidateType === 'role' && roles.includes(t.candidate)) ||
                    (t.candidateType === 'user' && t.candidate === userId)))
            ).sort((a, b) => a.createdAt - b.createdAt).map(clone);
        },

        // history (append-only)
        async addHistory(e) { history.push(clone(e)); },
        async listHistory(instanceId) { return history.filter(h => h.instanceId === instanceId).map(clone); }
    };
}
