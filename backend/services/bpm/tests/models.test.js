import { expect } from 'chai';
import { Sequelize } from 'sequelize';
import { defineModels } from '../src/repo/models.js';
import { makeEngine, def, users } from './helpers.js';

// Constructing Sequelize never connects; defining models needs no database.
const models = defineModels(new Sequelize('postgres://u:p@localhost:1/none', { logging: false }));
const attrs = (model) => Object.keys(model.getAttributes());

describe('bpm Postgres models', () => {
    it('every attribute maps to its own column (no shared definition objects)', () => {
        for (const model of Object.values(models)) {
            for (const [name, attr] of Object.entries(model.getAttributes())) {
                expect(attr.field, `${model.name}.${name}`).to.equal(name);
            }
        }
    });

    it('every field the engine writes exists in the model (unknown fields would be silently dropped)', async () => {
        const { engine, repo } = makeEngine({ 'test.apply': async () => ({ ok: true }) });
        await engine.deployDefinition(def({
            start: { type: 'start', next: 'fork' },
            fork: { type: 'parallelGateway', next: ['a', 'b'] },
            a: { type: 'humanTask', assignee: { perm: 'verify.file' }, exclude: [{ var: 'startedBy.id' }], outcomes: ['ok'], dueInHours: 1, next: 'join' },
            b: { type: 'serviceTask', connector: 'test.apply', next: 'join' },
            join: { type: 'join', next: 'end' },
            end: { type: 'end', outcome: 'done' }
        }));
        const inst = await engine.startInstance({ key: 'test-process', variables: {}, starter: users.aina });
        const [task] = await repo.listTasks({ instanceId: inst.id });
        await engine.claimTask({ id: task.id, user: users.tangeni });
        await engine.completeTask({ id: task.id, output: { outcome: 'ok' }, user: users.tangeni });

        const written = {
            Definition: await repo.getDefinition('test-process'),
            Instance: await repo.getInstance(inst.id),
            Task: (await repo.listTasks({ instanceId: inst.id }))[0],
            History: (await repo.listHistory(inst.id))[0]
        };
        const tokens = await repo.findTokens({ instanceId: inst.id });
        for (const [name, row] of Object.entries(written)) {
            expect(Object.keys(row), name).to.satisfy(keys => keys.every(k => attrs(models[name]).includes(k)), `${name}: ${Object.keys(row).filter(k => !attrs(models[name]).includes(k))}`);
        }
        for (const t of tokens) expect(attrs(models.Token)).to.include.members(Object.keys(t));
        expect(written.Task.claimedAt).to.be.instanceOf(Date);
        expect(written.Task.completedAt).to.be.instanceOf(Date);
    });
});
