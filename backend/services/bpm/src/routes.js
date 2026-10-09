import { UnauthorizedError, describeGuard } from '@lrfe/common';

const userOf = (req) => ({ id: req.user.sub, name: req.user.name, perms: req.user.perms || [], roles: req.user.roles || [] });
const uuidParams = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } };
const reasonOf = (req) => (typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '');

/** Instance as shown to clients: the full variable bag is only in the detail view. */
const summary = ({ variables, ...rest }) => ({ ...rest, document: variables?.document ?? undefined });

export async function bpmRoutes(app, { engine }) {
    // Users and services may start processes; each definition says which.
    async function userOrService(req) {
        try {
            await req.jwtVerify();
        } catch {
            throw new UnauthorizedError('Invalid or expired token');
        }
        if (!['access', 'service'].includes(req.user.typ)) throw new UnauthorizedError('Invalid or expired token');
    }
    describeGuard(userOrService, { kind: 'user-or-service' });

    // ------------------------------------------------------------------ processes

    app.get('/processes', { onRequest: app.authenticate }, async () => ({
        processes: (await engine.repo.listDefinitions()).map(({ key, name, version, definition }) => ({
            key, name, version, description: definition.description ?? null, start: definition.start, variables: definition.variables ?? null
        }))
    }));

    app.post('/processes/:key/instances', {
        onRequest: userOrService,
        schema: {
            params: { type: 'object', properties: { key: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' } } },
            body: { type: 'object', required: ['variables'], properties: { variables: { type: 'object' } } }
        }
    }, async (req, reply) => {
        const starter = req.user.typ === 'service' ? { service: req.user.sub } : userOf(req);
        const instance = await engine.startInstance({ key: req.params.key, variables: req.body.variables, starter });
        return reply.status(201).send(instance);
    });

    // ------------------------------------------------------------------ instances

    app.get('/instances', {
        onRequest: app.authenticate,
        schema: {
            querystring: {
                type: 'object', additionalProperties: false,
                properties: {
                    definitionKey: { type: 'string' }, businessKey: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'error', 'completed', 'cancelled'] },
                    mine: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 }
                }
            }
        }
    }, async (req) => {
        const { mine, ...filter } = req.query;
        const res = await engine.repo.listInstances({ ...filter, ...(mine ? { startedById: req.user.sub } : {}) });
        return { ...res, items: res.items.map(summary) };
    });

    app.get('/instances/:id', { onRequest: app.authenticate, schema: uuidParams }, async (req) => {
        const instance = await engine.requireInstance(req.params.id);
        const [tasks, history] = await Promise.all([engine.repo.listTasks({ instanceId: instance.id }), engine.repo.listHistory(instance.id)]);
        return { ...instance, tasks: tasks.map(({ input, ...t }) => t), history };
    });

    // A service may withdraw an instance it started (land-records, when the officer withdraws).
    app.post('/instances/:id/cancel', { onRequest: userOrService, schema: uuidParams }, async (req) => {
        const user = req.user.typ === 'service' ? { id: `service:${req.user.sub}`, name: req.user.sub, perms: [] } : userOf(req);
        return summary(await engine.cancelInstance({ id: req.params.id, user, reason: reasonOf(req) }));
    });

    app.post('/instances/:id/retry', { onRequest: app.authenticate, schema: uuidParams },
        async (req) => summary(await engine.retryInstance({ id: req.params.id, user: userOf(req) })));

    // ------------------------------------------------------------------ tasks

    /** The signed-in user's inbox: open tasks they may do, and tasks they have claimed. */
    app.get('/tasks', { onRequest: app.authenticate }, async (req) => {
        const tasks = await engine.inbox(userOf(req));
        const now = Date.now();
        return { tasks: tasks.map(({ input, ...t }) => ({ ...t, overdue: !!t.dueAt && new Date(t.dueAt).getTime() < now, document: input?.document })) };
    });

    app.get('/tasks/:id', { onRequest: app.authenticate, schema: uuidParams }, async (req) => engine.viewTask(req.params.id, userOf(req)));

    app.post('/tasks/:id/claim', { onRequest: app.authenticate, schema: uuidParams }, async (req) => engine.claimTask({ id: req.params.id, user: userOf(req) }));

    app.post('/tasks/:id/release', { onRequest: app.authenticate, schema: uuidParams }, async (req) => engine.releaseTask({ id: req.params.id, user: userOf(req) }));

    app.post('/tasks/:id/complete', {
        onRequest: app.authenticate,
        schema: { ...uuidParams, body: { type: 'object', required: ['output'], properties: { output: { type: 'object' } } } }
    }, async (req) => {
        const { task, instance } = await engine.completeTask({ id: req.params.id, output: req.body.output, user: userOf(req) });
        return { task, instance: summary(instance) };
    });
}
