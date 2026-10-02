import { expect } from 'chai';
import { Sequelize } from 'sequelize';
import { defineModels } from '../src/repo/models.js';
import { makeService, deedMeta, pdfFile } from './helpers.js';

// Constructing Sequelize never connects; defining models needs no database.
const models = defineModels(new Sequelize('postgres://u:p@localhost:1/none', { logging: false }));
const attrs = (model) => Object.keys(model.getAttributes());

describe('edrms Postgres models', () => {
    it('every attribute maps to its own column', () => {
        for (const model of Object.values(models)) {
            for (const [name, attr] of Object.entries(model.getAttributes())) expect(attr.field, `${model.name}.${name}`).to.equal(name);
        }
    });

    it('every field the service writes exists in the model', async () => {
        const { service, repo } = makeService();
        const { document } = await service.fileDocument({ meta: deedMeta(), file: pdfFile() });
        await service.amendDocument({ id: document.id, reason: 'Model check', changes: [{ k: 'regDiv', v: 'L' }], actor: { id: 'a', name: 'A' }, approvedBy: { id: 'b', name: 'B' } });
        const doc = await repo.getDocument(document.id);
        expect(attrs(models.Document)).to.include.members(Object.keys(doc));
        for (const v of await repo.listVersions(document.id)) expect(attrs(models.Version)).to.include.members(Object.keys(v));
    });
});
