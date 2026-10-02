import { randomUUID } from 'node:crypto';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@lrfe/common';
import { evaluate, evaluateCondition } from './condition.js';
import { validateDefinition, validateVariables } from './validator.js';
import { canonicalJson } from './canonical.js';

const OPEN_TASK = ['created', 'claimed'];
const LIVE_TOKEN = ['active', 'waiting', 'joined', 'failed'];

/** Can `user` ({ id, perms, roles }) work on this task? */
export function isEligible(task, user) {
    if (!user?.id || (task.excludedUserIds || []).includes(user.id)) return false;
    if (task.candidateType === 'perm') return (user.perms || []).includes(task.candidate);
    if (task.candidateType === 'role') return (user.roles || []).includes(task.candidate);
    if (task.candidateType === 'user') return task.candidate === user.id;
    return false;
}

/**
 * A lightweight, persisted, token-based process engine — ported from cportal-be/services/bpm and
 * extended with permission-based assignment, excluded users (four-eyes), outcomes, due dates,
 * start permissions, cancel and retry. Not BPMN 2.0.
 *
 * Every transition is persisted before the engine looks at what to do next, so an instance can
 * wait at a human task for days and resume exactly where it left off. There is no background
 * loop: the engine runs only when called (start, complete, retry).
 *
 * TODO: a transition that touches several rows (e.g. finishing a task and advancing its token)
 * is not one DB transaction. Conditional updates stop double completion, but a crash between
 * writes can leave a token needing `retry`.
 */
export class BpmEngine {
    constructor({ repo, connectors = {}, events, clock = () => new Date() }) {
        this.repo = repo;
        this.connectors = connectors;
        this.events = events;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ definitions

    /** Deploy a definition. Re-deploying identical content is a no-op; any change is a new version. */
    async deployDefinition(definition, { deployedBy = 'system' } = {}) {
        validateDefinition(definition, { connectors: this.connectors });
        const latest = await this.repo.getDefinition(definition.key);
        if (latest && canonicalJson(latest.definition) === canonicalJson(definition)) return { definition: latest, deployed: false };
        const row = await this.repo.createDefinition({
            id: randomUUID(), key: definition.key, name: definition.name, version: latest ? latest.version + 1 : 1,
            definition, deployedBy, deployedAt: this.clock()
        });
        return { definition: row, deployed: true };
    }

    async requireDefinition(key, version) {
        const def = await this.repo.getDefinition(key, version);
        if (!def) throw new NotFoundError(`No process "${key}"${version ? ` version ${version}` : ''}`);
        return def;
    }

    // ------------------------------------------------------------------ instances

    /**
     * starter: { id, name, perms, roles } for a user, or { service: 'intake' } for a service.
     */
    async startInstance({ key, variables, starter }) {
        const defRow = await this.requireDefinition(key);
        const def = defRow.definition;
        const byService = !!starter?.service;
        if (byService ? !(def.start.services || []).includes(starter.service) : !(def.start.perm && (starter?.perms || []).includes(def.start.perm))) {
            throw new ForbiddenError(`Not permitted to start "${def.name}"`, { perm: def.start.perm });
        }
        const vars = validateVariables(def, variables);
        const startedBy = byService ? { id: `service:${starter.service}`, name: starter.service } : { id: starter.id, name: starter.name };
        vars.startedBy = startedBy;
        const businessKey = def.businessKey ? String(evaluate(def.businessKey, vars) ?? '') || null : null;
        if (businessKey && await this.repo.findActiveInstance(key, businessKey)) {
            throw new ConflictError(`"${def.name}" is already open for ${businessKey}`, { businessKey });
        }
        // A precheck runs before anything is created; its errors go straight back to the caller
        // and its result (e.g. a preview for the approver) joins the variables.
        if (def.precheck) {
            const result = await this.connectors[def.precheck.connector]({ instance: null, token: null, variables: vars, input: def.precheck.input || {} });
            if (result && typeof result === 'object') Object.assign(vars, result);
        }

        const instance = await this.repo.createInstance({
            id: randomUUID(), definitionId: defRow.id, definitionKey: key, definitionVersion: defRow.version, name: def.name,
            businessKey, variables: vars, status: 'active', outcome: null, errorMessage: null,
            startedById: startedBy.id, startedByName: startedBy.name, startedAt: this.clock(), endedAt: null
        });
        await this.history(instance, null, 'instance_started', { businessKey, definitionVersion: defRow.version }, startedBy);
        await this.publish('bpm.instance.started', instance, {}, startedBy);
        const token = await this.newToken(instance, { currentNode: def.startAt });
        await this.advance(instance, def, token);
        return this.repo.getInstance(instance.id);
    }

    async requireInstance(id) {
        const instance = await this.repo.getInstance(id);
        if (!instance) throw new NotFoundError('Process instance not found');
        return instance;
    }

    async definitionOf(instance) {
        return (await this.repo.getDefinitionById(instance.definitionId)).definition;
    }

    /** Withdraw an open instance. Allowed for whoever started it and for holders of the definition's managePerm. */
    async cancelInstance({ id, user, reason }) {
        const instance = await this.requireInstance(id);
        const def = await this.definitionOf(instance);
        if (instance.startedById !== user.id && !(user.perms || []).includes(def.managePerm)) throw new ForbiddenError('Not permitted to cancel this process');
        if (!['active', 'error'].includes(instance.status)) throw new ConflictError(`The process is already ${instance.status}`);
        for (const task of await this.repo.listTasks({ instanceId: id, statuses: OPEN_TASK })) {
            await this.repo.updateTaskIf(task.id, OPEN_TASK, { status: 'cancelled', completedAt: this.clock() });
        }
        for (const token of await this.repo.findTokens({ instanceId: id, status: LIVE_TOKEN })) {
            await this.repo.updateToken(token.id, { status: 'cancelled' });
        }
        await this.saveInstance(instance, { status: 'cancelled', outcome: 'cancelled', endedAt: this.clock() });
        await this.history(instance, null, 'instance_cancelled', { reason: reason || null }, user);
        await this.publish('bpm.instance.cancelled', instance, { reason: reason || null }, user);
        return instance;
    }

    /** Re-run the service task that failed (e.g. edrms was unreachable). managePerm only. */
    async retryInstance({ id, user }) {
        const instance = await this.requireInstance(id);
        const def = await this.definitionOf(instance);
        if (!(user.perms || []).includes(def.managePerm)) throw new ForbiddenError('Not permitted to retry this process');
        if (instance.status !== 'error') throw new ConflictError('Only a process in error can be retried');
        const failed = await this.repo.findTokens({ instanceId: id, status: ['failed'] });
        await this.saveInstance(instance, { status: 'active', errorMessage: null, endedAt: null });
        await this.history(instance, null, 'instance_retried', {}, user);
        for (const token of failed) {
            await this.saveToken(token, { status: 'active' });
            await this.advance(instance, def, token);
        }
        return this.repo.getInstance(id);
    }

    // ------------------------------------------------------------------ tasks

    async requireTask(id) {
        const task = await this.repo.getTask(id);
        if (!task) throw new NotFoundError('Task not found');
        return task;
    }

    /** Tasks the user can act on: claimed by them, or open and matching their permissions/roles. */
    async inbox(user) {
        const tasks = await this.repo.listInboxTasks({ userId: user.id, perms: user.perms || [], roles: user.roles || [] });
        return tasks.filter(t => t.claimedById === user.id || (t.status === 'created' && isEligible(t, user)));
    }

    /** Visible to the eligible, the claimer, whoever started the instance, and managePerm holders. */
    async viewTask(id, user) {
        const task = await this.requireTask(id);
        const instance = await this.requireInstance(task.instanceId);
        const def = await this.definitionOf(instance);
        const involved = isEligible(task, user) || task.claimedById === user.id || task.completedById === user.id
            || instance.startedById === user.id || (user.perms || []).includes(def.managePerm);
        if (!involved) throw new ForbiddenError('Not permitted to see this task');
        return task;
    }

    async claimTask({ id, user }) {
        const task = await this.requireTask(id);
        if (task.status !== 'created') throw new ConflictError(task.status === 'claimed' ? `Already claimed by ${task.claimedByName}` : `Task is ${task.status}`);
        if (!isEligible(task, user)) throw new ForbiddenError(this.ineligibleMessage(task, user));
        const updated = await this.repo.updateTaskIf(id, ['created'], { status: 'claimed', claimedById: user.id, claimedByName: user.name, claimedAt: this.clock() });
        if (!updated) throw new ConflictError('Someone else claimed this task first');
        return updated;
    }

    async releaseTask({ id, user }) {
        const task = await this.requireTask(id);
        if (task.status !== 'claimed' || task.claimedById !== user.id) throw new ConflictError('You have not claimed this task');
        return this.repo.updateTaskIf(id, ['claimed'], { status: 'created', claimedById: null, claimedByName: null, claimedAt: null });
    }

    ineligibleMessage(task, user) {
        if ((task.excludedUserIds || []).includes(user.id)) return 'You cannot act on this task: a different person must do it (four-eyes)';
        return 'This task is not assigned to you';
    }

    /**
     * Complete a human task. An open task is claimed implicitly by an eligible user; a claimed
     * task can only be completed by its claimer. `output.outcome` must be one of the node's
     * outcomes; a comment is required for outcomes listed in requireCommentFor.
     */
    async completeTask({ id, output = {}, user }) {
        const task = await this.requireTask(id);
        if (!OPEN_TASK.includes(task.status)) throw new ConflictError(`Task is ${task.status}`);
        if (task.status === 'claimed' && task.claimedById !== user.id) throw new ForbiddenError(`Claimed by ${task.claimedByName}`);
        if (task.status === 'created' && !isEligible(task, user)) throw new ForbiddenError(this.ineligibleMessage(task, user));
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw new BadRequestError('output must be an object');

        const instance = await this.requireInstance(task.instanceId);
        const def = await this.definitionOf(instance);
        const node = def.nodes[task.nodeId];
        if (node.outcomes && !node.outcomes.includes(output.outcome)) throw new BadRequestError(`outcome must be one of ${node.outcomes.join(', ')}`);
        if ((node.requireCommentFor || []).includes(output.outcome) && !String(output.comment || '').trim()) {
            throw new BadRequestError(`A comment is required when the outcome is "${output.outcome}"`);
        }

        const now = this.clock();
        const by = { id: user.id, name: user.name };
        const updated = await this.repo.updateTaskIf(id, [task.status], {
            status: 'completed', output, completedById: by.id, completedByName: by.name, completedAt: now,
            ...(task.status === 'created' ? { claimedById: by.id, claimedByName: by.name, claimedAt: now } : {})
        });
        if (!updated) throw new ConflictError('The task was changed by someone else');
        await this.history(instance, { id: task.tokenId }, 'task_completed', { taskId: id, nodeId: task.nodeId, output }, by);
        await this.publish('bpm.task.completed', instance, { taskId: id, nodeId: task.nodeId, outcome: output.outcome ?? null }, by);

        const token = await this.repo.getToken(task.tokenId);
        const result = { ...output, by, at: now.toISOString() };
        const scope = node.outputVar ? { ...token.scope, [node.outputVar]: result } : { ...token.scope, ...output };
        await this.saveToken(token, { scope, currentNode: node.next, status: 'active' });
        await this.advance(instance, def, token);
        return { task: updated, instance: await this.repo.getInstance(instance.id) };
    }

    // ------------------------------------------------------------------ execution core

    vars(instance, token) {
        return { ...instance.variables, ...(token?.scope || {}) };
    }

    async newToken(instance, fields) {
        return this.repo.createToken({
            id: randomUUID(), instanceId: instance.id, parentTokenId: null, forkGroup: null, forkSize: null,
            scope: {}, status: 'active', createdAt: this.clock(), ...fields
        });
    }

    async saveToken(token, patch) {
        Object.assign(token, patch);
        await this.repo.updateToken(token.id, patch);
    }

    async saveInstance(instance, patch) {
        Object.assign(instance, patch);
        await this.repo.updateInstance(instance.id, patch);
    }

    async history(instance, token, type, payload = {}, actor = null) {
        await this.repo.addHistory({
            id: randomUUID(), instanceId: instance.id, tokenId: token?.id ?? null, type, payload,
            actorId: actor?.id ?? null, actorName: actor?.name ?? null, at: this.clock()
        });
    }

    async publish(type, instance, data, actor) {
        await this.events?.publish(type, { instanceId: instance.id, definitionKey: instance.definitionKey, businessKey: instance.businessKey, ...data }, { actor: actor || undefined });
    }

    node(def, id) {
        const node = def.nodes[id];
        if (!node) throw new Error(`Node "${id}" not found in definition`);
        return node;
    }

    /**
     * Move a token through as many steps as it can. Stops when it parks at a human task, hands
     * off to children (fork / multi-instance), is consumed by a join, fails, or ends.
     */
    async advance(instance, def, token) {
        for (;;) {
            if (token.status !== 'active' || instance.status !== 'active') return;
            const node = this.node(def, token.currentNode);
            switch (node.type) {
                case 'start':
                    await this.saveToken(token, { currentNode: node.next });
                    continue;
                case 'humanTask':
                    await this.createTask(instance, token, node);
                    await this.saveToken(token, { status: 'waiting' });
                    return;
                case 'serviceTask':
                    if (!(await this.runServiceTask(instance, token, node))) return;
                    continue;
                case 'exclusiveGateway': {
                    const data = this.vars(instance, token);
                    const next = node.cases.find(c => evaluateCondition(c.when, data))?.next ?? node.default;
                    if (!next) {
                        await this.fail(instance, token, `No case of gateway "${token.currentNode}" matched`);
                        return;
                    }
                    await this.history(instance, token, 'gateway_evaluated', { node: token.currentNode, to: next });
                    await this.saveToken(token, { currentNode: next });
                    continue;
                }
                case 'parallelGateway':
                    await this.fork(instance, def, token, node);
                    return;
                case 'join':
                    await this.arriveAtJoin(instance, def, token, node);
                    return;
                case 'multiInstanceTask':
                    await this.spawnMultiInstance(instance, def, token, node);
                    return;
                case 'miEnd':
                    await this.completeMultiInstanceChild(instance, def, token, node);
                    return;
                case 'end':
                    await this.completeToken(instance, token, node);
                    return;
                default:
                    await this.fail(instance, token, `Unhandled node type "${node.type}"`);
                    return;
            }
        }
    }

    async createTask(instance, token, node) {
        const data = this.vars(instance, token);
        const kind = ['perm', 'role', 'user'].find(k => node.assignee[k] !== undefined);
        const candidate = kind === 'user' ? evaluate(node.assignee.user, data) : node.assignee[kind];
        const excludedUserIds = (node.exclude || []).map(rule => evaluate(rule, data)).filter(Boolean).map(String);
        const title = typeof node.title === 'object' ? evaluate(node.title, data) : node.title || token.currentNode;
        const now = this.clock();
        const task = await this.repo.createTask({
            id: randomUUID(), instanceId: instance.id, tokenId: token.id, nodeId: token.currentNode,
            definitionKey: instance.definitionKey, businessKey: instance.businessKey, title: String(title),
            candidateType: kind, candidate: String(candidate ?? ''), excludedUserIds, outcomes: node.outcomes || null,
            input: data, output: null, status: 'created', createdAt: now,
            dueAt: node.dueInHours ? new Date(now.getTime() + node.dueInHours * 3_600_000) : null,
            claimedById: null, claimedByName: null, claimedAt: null, completedById: null, completedByName: null, completedAt: null
        });
        await this.history(instance, token, 'task_created', { taskId: task.id, nodeId: task.nodeId, candidate: `${kind}:${task.candidate}` });
        await this.publish('bpm.task.created', instance, { taskId: task.id, nodeId: task.nodeId, title: task.title, candidateType: kind, candidate: task.candidate });
        return task;
    }

    async runServiceTask(instance, token, node) {
        try {
            const input = node.input ? evaluate(node.input, this.vars(instance, token)) : {};
            const result = await this.connectors[node.connector]({ instance, token, variables: this.vars(instance, token), input });
            if (node.outputVar) await this.saveInstance(instance, { variables: { ...instance.variables, [node.outputVar]: result } });
            else if (result && typeof result === 'object' && !Array.isArray(result)) await this.saveInstance(instance, { variables: { ...instance.variables, ...result } });
            await this.history(instance, token, 'service_task_completed', { node: token.currentNode, connector: node.connector });
            await this.saveToken(token, { currentNode: node.next });
            return true;
        } catch (err) {
            await this.fail(instance, token, `Step "${token.currentNode}" (${node.connector}) failed: ${err.message}`, { connector: node.connector, statusCode: err.statusCode ?? null });
            return false;
        }
    }

    /** Park the token as failed and put the instance in error; `retry` resumes from this step. */
    async fail(instance, token, message, extra = {}) {
        await this.saveToken(token, { status: 'failed' });
        await this.saveInstance(instance, { status: 'error', errorMessage: message });
        await this.history(instance, token, 'step_failed', { node: token.currentNode, error: message, ...extra });
        await this.publish('bpm.instance.failed', instance, { node: token.currentNode, error: message });
    }

    async fork(instance, def, token, node) {
        const forkGroup = randomUUID();
        await this.saveToken(token, { status: 'completed' });
        await this.history(instance, token, 'parallel_forked', { into: node.next, forkGroup });
        for (const next of node.next) {
            const child = await this.newToken(instance, { parentTokenId: token.parentTokenId, forkGroup, forkSize: node.next.length, currentNode: next, scope: token.scope });
            await this.advance(instance, def, child);
        }
    }

    async arriveAtJoin(instance, def, token, node) {
        await this.saveToken(token, { status: 'joined' });
        const arrived = await this.repo.findTokens({ instanceId: instance.id, forkGroup: token.forkGroup, currentNode: token.currentNode, status: ['joined'] });
        if (arrived.length < (token.forkSize || 1)) return;
        // Only the arrival whose update wins continues; a concurrent last arrival sees 0 rows.
        let won = false;
        for (const t of arrived) won = (await this.repo.updateTokenIf(t.id, 'joined', { status: 'completed' })) || won;
        if (!won) return;
        const scope = Object.assign({}, ...arrived.map(t => t.scope));
        const next = await this.newToken(instance, { parentTokenId: token.parentTokenId, currentNode: node.next, scope });
        await this.history(instance, next, 'join_completed', { node: token.currentNode });
        await this.advance(instance, def, next);
    }

    async spawnMultiInstance(instance, def, token, node) {
        let items;
        try {
            items = await this.connectors[node.collection]({ instance, token, variables: this.vars(instance, token), input: node.input || {} });
            if (!Array.isArray(items)) throw new Error(`collection "${node.collection}" must return a list`);
        } catch (err) {
            await this.fail(instance, token, `Step "${token.currentNode}" (${node.collection}) failed: ${err.message}`);
            return;
        }
        await this.saveToken(token, { status: 'waiting' });
        await this.history(instance, token, 'multi_instance_spawned', { node: token.currentNode, count: items.length });
        if (!items.length) {
            await this.completeMultiInstanceParent(instance, def, token, node, []);
            return;
        }
        for (const item of items) {
            const child = await this.newToken(instance, { parentTokenId: token.id, currentNode: node.start, scope: { ...token.scope, [node.elementVar]: item } });
            await this.advance(instance, def, child);
        }
    }

    async completeMultiInstanceChild(instance, def, token, node) {
        const outcome = evaluate(node.outcome, this.vars(instance, token));
        await this.saveToken(token, { scope: { ...token.scope, outcome }, status: 'completed' });
        if (!token.parentTokenId) return;
        const parent = await this.repo.getToken(token.parentTokenId);
        const parentNode = this.node(def, parent.currentNode);
        const siblings = await this.repo.findTokens({ instanceId: instance.id, parentTokenId: parent.id });
        const finished = siblings.filter(s => s.status === 'completed');
        const summaries = finished.map(s => s.scope);
        if (evaluateCondition(parentNode.completionCondition, { children: summaries, total: siblings.length, completed: finished.length })) {
            await this.completeMultiInstanceParent(instance, def, parent, parentNode, summaries);
        }
    }

    async completeMultiInstanceParent(instance, def, parent, parentNode, summaries) {
        // Optimistic guard: of two children finishing together, only one continues the flow.
        if (!(await this.repo.updateTokenIf(parent.id, 'waiting', { status: 'completed' }))) return;
        // Siblings still open when the completion condition was met are no longer needed.
        for (const t of await this.repo.findTokens({ instanceId: instance.id, parentTokenId: parent.id, status: ['active', 'waiting'] })) {
            await this.repo.updateToken(t.id, { status: 'cancelled' });
            for (const task of await this.repo.listTasks({ instanceId: instance.id, statuses: OPEN_TASK })) {
                if (task.tokenId === t.id) await this.repo.updateTaskIf(task.id, OPEN_TASK, { status: 'cancelled', completedAt: this.clock() });
            }
        }
        await this.saveInstance(instance, { variables: { ...instance.variables, [`${parent.currentNode}Results`]: summaries } });
        await this.history(instance, parent, 'multi_instance_completed', { node: parent.currentNode, count: summaries.length });
        const next = await this.newToken(instance, { parentTokenId: parent.parentTokenId, currentNode: parentNode.next, scope: parent.scope });
        await this.advance(instance, def, next);
    }

    async completeToken(instance, token, node) {
        await this.saveToken(token, { status: 'completed' });
        await this.history(instance, token, 'token_completed', { node: token.currentNode });
        const remaining = await this.repo.findTokens({ instanceId: instance.id, status: LIVE_TOKEN });
        if (remaining.length) return;
        const outcome = node.outcome ?? token.currentNode;
        await this.saveInstance(instance, { status: 'completed', outcome, endedAt: this.clock() });
        await this.history(instance, null, 'instance_completed', { outcome });
        await this.publish('bpm.instance.completed', instance, { outcome });
    }
}
