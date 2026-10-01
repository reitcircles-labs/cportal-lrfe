import { expect } from 'chai';
import { makeEngine, def, users, rejects } from './helpers.js';
import { validateDefinition } from '../src/engine/validator.js';

const approval = def({
    start: { type: 'start', next: 'approve' },
    approve: {
        type: 'humanTask', title: { cat: ['Approve ', { var: 'subject' }] }, assignee: { perm: 'verify.file' },
        exclude: [{ var: 'startedBy.id' }], outcomes: ['approved', 'rejected'], requireCommentFor: ['rejected'],
        outputVar: 'approval', dueInHours: 48, next: 'decide'
    },
    decide: { type: 'exclusiveGateway', cases: [{ when: { '==': [{ var: 'approval.outcome' }, 'approved'] }, next: 'apply' }], default: 'no' },
    apply: { type: 'serviceTask', connector: 'test.apply', next: 'yes' },
    yes: { type: 'end', outcome: 'applied' },
    no: { type: 'end', outcome: 'rejected' }
}, {
    businessKey: { var: 'subject' },
    variables: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', minLength: 1 } } }
});

describe('definition validation', () => {
    const connectors = { 'test.apply': async () => ({}) };

    it('accepts a well-formed definition', () => {
        expect(validateDefinition(approval, { connectors })).to.equal(true);
    });

    it('rejects structural mistakes with a clear message', () => {
        const broken = (nodes, extra) => () => validateDefinition(def(nodes, extra), { connectors });
        expect(broken({ start: { type: 'start', next: 'nowhere' } })).to.throw(/unknown node "nowhere"/);
        expect(broken({ start: { type: 'start', next: 'a' }, a: { type: 'serviceTask', connector: 'x.y', next: 'e' }, e: { type: 'end' } })).to.throw(/unknown connector "x.y"/);
        expect(broken({ start: { type: 'start', next: 'a' }, a: { type: 'humanTask', assignee: { perm: 'p', role: 'r' }, next: 'e' }, e: { type: 'end' } })).to.throw(/exactly one of/);
        expect(broken({ start: { type: 'start', next: 'a' }, a: { type: 'humanTask', assignee: { perm: 'p' }, outcomes: ['ok'], requireCommentFor: ['no'], next: 'e' }, e: { type: 'end' } })).to.throw(/requireCommentFor/);
        expect(broken({ start: { type: 'start', next: 'e' }, e: { type: 'teleport' } })).to.throw(/unknown type/);
        expect(broken({ start: { type: 'start', next: 'e' }, e: { type: 'end' } }, { start: {} })).to.throw(/"start" needs/);
        expect(broken({ start: { type: 'start', next: 'e' }, e: { type: 'end' } }, { key: 'Bad Key' })).to.throw(/kebab-case/);
    });
});

describe('BpmEngine', () => {
    let calls;
    const setup = async (connectorImpl) => {
        calls = [];
        const ctx = makeEngine({ 'test.apply': connectorImpl || (async ({ variables }) => { calls.push(variables); return { appliedAt: 'now' }; }) });
        await ctx.engine.deployDefinition(approval);
        return ctx;
    };
    const start = (engine, starter = users.aina, subject = 'EDR-1') => engine.startInstance({ key: 'test-process', variables: { subject }, starter });

    describe('definitions', () => {
        it('re-deploying identical content is a no-op; a change is a new version; instances keep theirs', async () => {
            const { engine } = await setup();
            expect((await engine.deployDefinition(approval)).deployed).to.equal(false);
            const first = await start(engine);
            const changed = structuredClone(approval);
            changed.nodes.approve.dueInHours = 24;
            const { definition, deployed } = await engine.deployDefinition(changed);
            expect(deployed).to.equal(true);
            expect(definition.version).to.equal(2);
            expect(first.definitionVersion).to.equal(1);
            expect((await start(engine, users.aina, 'EDR-2')).definitionVersion).to.equal(2);
        });
    });

    describe('starting', () => {
        it('checks start permission, services and variables; stores who started it', async () => {
            const { engine } = await setup();
            await rejects(start(engine, users.kristofina), 403);
            await rejects(engine.startInstance({ key: 'test-process', variables: { subject: 'x' }, starter: { service: 'land-records' } }), 403);
            await rejects(engine.startInstance({ key: 'test-process', variables: {}, starter: users.aina }), 400, 'subject');
            await rejects(engine.startInstance({ key: 'nope', variables: {}, starter: users.aina }), 404);

            const byService = await engine.startInstance({ key: 'test-process', variables: { subject: 'S' }, starter: { service: 'intake' } });
            expect(byService.startedById).to.equal('service:intake');
            const inst = await start(engine);
            expect(inst).to.include({ status: 'active', businessKey: 'EDR-1', startedById: 'u3', startedByName: 'Aina Mwandingi' });
        });

        it('allows one open instance per business key', async () => {
            const { engine } = await setup();
            await start(engine);
            await rejects(start(engine, users.tangeni), 409, 'already open for EDR-1');
            await start(engine, users.aina, 'EDR-2');
        });
    });

    describe('human tasks & four-eyes', () => {
        it('creates a titled, due task that the requester cannot see, claim or complete', async () => {
            const { engine, repo, published } = await setup();
            const inst = await start(engine);
            const [task] = await repo.listTasks({ instanceId: inst.id });
            expect(task).to.include({ title: 'Approve EDR-1', candidateType: 'perm', candidate: 'verify.file', status: 'created' });
            expect(task.excludedUserIds).to.deep.equal(['u3']);
            expect(task.dueAt.toISOString()).to.equal('2026-09-30T09:00:00.000Z');
            expect(published.map(e => e.type)).to.include('bpm.task.created');

            expect(await engine.inbox(users.aina)).to.have.length(0);
            expect(await engine.inbox(users.tangeni)).to.have.length(1);
            expect(await engine.inbox(users.kristofina)).to.have.length(0);
            await rejects(engine.claimTask({ id: task.id, user: users.aina }), 403, 'four-eyes');
            await rejects(engine.completeTask({ id: task.id, output: { outcome: 'approved' }, user: users.aina }), 403, 'four-eyes');
            await rejects(engine.claimTask({ id: task.id, user: users.kristofina }), 403, 'not assigned');
        });

        it('approval runs the service task and completes with the end node outcome', async () => {
            const { engine, repo, published } = await setup();
            const inst = await start(engine);
            const [task] = await repo.listTasks({ instanceId: inst.id });
            const { instance } = await engine.completeTask({ id: task.id, output: { outcome: 'approved', comment: 'Checked against the original' }, user: users.tangeni });
            expect(instance).to.include({ status: 'completed', outcome: 'applied' });
            expect(instance.variables.appliedAt).to.equal('now');
            expect(calls[0].approval).to.include({ outcome: 'approved', comment: 'Checked against the original' });
            expect(calls[0].approval.by).to.deep.equal({ id: 'u8', name: 'Tangeni Iita' });
            expect(published.map(e => e.type)).to.include.members(['bpm.task.completed', 'bpm.instance.completed']);
            // the requester's approval-free path cannot be re-run
            await rejects(engine.completeTask({ id: task.id, output: { outcome: 'approved' }, user: users.tangeni }), 409);
        });

        it('validates outcomes and requires a comment to reject', async () => {
            const { engine, repo } = await setup();
            const inst = await start(engine);
            const [task] = await repo.listTasks({ instanceId: inst.id });
            await rejects(engine.completeTask({ id: task.id, output: { outcome: 'maybe' }, user: users.tangeni }), 400, 'approved, rejected');
            await rejects(engine.completeTask({ id: task.id, output: { outcome: 'rejected' }, user: users.tangeni }), 400, 'comment');
            const { instance } = await engine.completeTask({ id: task.id, output: { outcome: 'rejected', comment: 'Original shows 75060200418' }, user: users.tangeni });
            expect(instance).to.include({ status: 'completed', outcome: 'rejected' });
            expect(calls).to.have.length(0);
        });

        it('a claimed task belongs to its claimer until released', async () => {
            const { engine, repo } = await setup();
            const inst = await start(engine);
            const [task] = await repo.listTasks({ instanceId: inst.id });
            const other = { ...users.tangeni, id: 'u99', name: 'Other Reviewer' };
            await engine.claimTask({ id: task.id, user: users.tangeni });
            await rejects(engine.claimTask({ id: task.id, user: other }), 409, 'Tangeni Iita');
            await rejects(engine.completeTask({ id: task.id, output: { outcome: 'approved' }, user: other }), 403);
            expect(await engine.inbox(other)).to.have.length(0);
            expect(await engine.inbox(users.tangeni)).to.have.length(1);
            await engine.releaseTask({ id: task.id, user: users.tangeni });
            await engine.completeTask({ id: task.id, output: { outcome: 'approved' }, user: other });
        });

        it('task visibility: eligible users, the requester and managers — not bystanders', async () => {
            const { engine, repo } = await setup();
            const inst = await start(engine);
            const [task] = await repo.listTasks({ instanceId: inst.id });
            await engine.viewTask(task.id, users.tangeni);
            await engine.viewTask(task.id, users.aina);
            await rejects(engine.viewTask(task.id, users.kristofina), 403);
        });
    });

    describe('failures, retry & cancel', () => {
        it('a failing service task puts the instance in error; retry resumes from that step', async () => {
            let down = true;
            const { engine, repo } = await setup(async () => {
                if (down) throw new Error('edrms unreachable');
                return { ok: true };
            });
            const inst = await start(engine);
            const [task] = await repo.listTasks({ instanceId: inst.id });
            const { instance } = await engine.completeTask({ id: task.id, output: { outcome: 'approved' }, user: users.tangeni });
            expect(instance.status).to.equal('error');
            expect(instance.errorMessage).to.include('edrms unreachable');
            // still "open" for the business key, so no duplicate request can start meanwhile
            await rejects(start(engine, users.tangeni), 409);

            await rejects(engine.retryInstance({ id: inst.id, user: users.kristofina }), 403);
            down = false;
            const retried = await engine.retryInstance({ id: inst.id, user: users.tangeni });
            expect(retried).to.include({ status: 'completed', outcome: 'applied', errorMessage: null });
            await rejects(engine.retryInstance({ id: inst.id, user: users.tangeni }), 409);
        });

        it('the requester or a manager can cancel; open tasks are cancelled with it', async () => {
            const { engine, repo } = await setup();
            const inst = await start(engine);
            await rejects(engine.cancelInstance({ id: inst.id, user: users.kristofina }), 403);
            const cancelled = await engine.cancelInstance({ id: inst.id, user: users.aina, reason: 'Wrong document' });
            expect(cancelled).to.include({ status: 'cancelled', outcome: 'cancelled' });
            const [task] = await repo.listTasks({ instanceId: inst.id });
            expect(task.status).to.equal('cancelled');
            expect(await engine.inbox(users.tangeni)).to.have.length(0);
            await rejects(engine.cancelInstance({ id: inst.id, user: users.aina }), 409);
            await start(engine); // business key free again
        });
    });

    describe('parallel and multi-instance flows', () => {
        it('fork → two tasks → join → end, merging both outputs', async () => {
            const { engine, repo } = makeEngine({});
            await engine.deployDefinition(def({
                start: { type: 'start', next: 'fork' },
                fork: { type: 'parallelGateway', next: ['legal', 'survey'] },
                legal: { type: 'humanTask', assignee: { perm: 'verify.file' }, outputVar: 'legal', next: 'join' },
                survey: { type: 'humanTask', assignee: { role: 'sup' }, outputVar: 'survey', next: 'join' },
                join: { type: 'join', next: 'end' },
                end: { type: 'end' }
            }));
            const inst = await engine.startInstance({ key: 'test-process', variables: {}, starter: users.aina });
            const tasks = await repo.listTasks({ instanceId: inst.id });
            expect(tasks.map(t => t.nodeId).sort()).to.deep.equal(['legal', 'survey']);
            await engine.completeTask({ id: tasks.find(t => t.nodeId === 'survey').id, output: { ok: 1 }, user: users.elina });
            expect((await repo.getInstance(inst.id)).status).to.equal('active');
            const { instance } = await engine.completeTask({ id: tasks.find(t => t.nodeId === 'legal').id, output: { ok: 2 }, user: users.tangeni });
            expect(instance).to.include({ status: 'completed', outcome: 'end' });
        });

        it('multi-instance: one task per item; completes when the condition holds', async () => {
            const { engine, repo } = makeEngine({ 'test.docs': async () => ['a', 'b', 'c'] });
            await engine.deployDefinition(def({
                start: { type: 'start', next: 'each' },
                each: { type: 'multiInstanceTask', collection: 'test.docs', elementVar: 'doc', start: 'check', completionCondition: { '==': [{ var: 'completed' }, { var: 'total' }] }, next: 'end' },
                check: { type: 'humanTask', title: { cat: ['Check ', { var: 'doc' }] }, assignee: { perm: 'verify.file' }, outcomes: ['ok', 'bad'], next: 'done' },
                done: { type: 'miEnd', outcome: { var: 'outcome' } },
                end: { type: 'end' }
            }));
            const inst = await engine.startInstance({ key: 'test-process', variables: {}, starter: users.aina });
            const tasks = await repo.listTasks({ instanceId: inst.id });
            expect(tasks.map(t => t.title)).to.deep.equal(['Check a', 'Check b', 'Check c']);
            for (const [i, t] of tasks.entries()) await engine.completeTask({ id: t.id, output: { outcome: i === 1 ? 'bad' : 'ok' }, user: users.tangeni });
            const done = await repo.getInstance(inst.id);
            expect(done.status).to.equal('completed');
            expect(done.variables.eachResults.map(r => r.outcome)).to.deep.equal(['ok', 'bad', 'ok']);
        });
    });
});
