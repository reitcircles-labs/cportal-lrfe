import { expect } from 'chai';
import { Sequelize } from 'sequelize';
import { defineModels } from '../src/repo/models.js';
import { makeIntake, actor, users, answer, withField } from './helpers.js';

// Constructing Sequelize never connects; defining models needs no database.
const models = defineModels(new Sequelize('postgres://u:p@localhost:1/none', { logging: false }));
const attrs = (model) => Object.keys(model.getAttributes());

describe('intake Postgres models', () => {
    it('every attribute maps to its own column', () => {
        for (const model of Object.values(models)) {
            for (const [name, attr] of Object.entries(model.getAttributes())) expect(attr.field, `${model.name}.${name}`).to.equal(name);
        }
    });

    it('every field the service and worker write exists in the model', async () => {
        const { captureAndExtract, service, repo, batch } = await makeIntake({ respond: () => withField(answer(), 'tee2Id', '123') });
        const doc = await captureAndExtract();
        await service.claim(doc.id, actor(users.rev));
        await service.updateField(doc.id, 'tee2Id', { value: '75060200418' }, actor(users.rev));
        await service.rejectDocument(doc.id, 'model test', actor(users.rev));

        expect(attrs(models.Batch)).to.include.members(Object.keys(await repo.getBatch(batch.id)));
        expect(attrs(models.Document)).to.include.members(Object.keys(await repo.getDocument(doc.id)));
        for (const e of await repo.listExtractions(doc.id)) expect(attrs(models.Extraction)).to.include.members(Object.keys(e));
        for (const j of await repo.listJobs(doc.id)) expect(attrs(models.Job)).to.include.members(Object.keys(j));
        for (const { id, ...e } of await repo.listEvents(doc.id)) expect(attrs(models.Event)).to.include.members(Object.keys(e));
    });
});
