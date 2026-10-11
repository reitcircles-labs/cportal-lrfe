import { strict as assert } from 'node:assert';
import { people, audited } from './register.js';

describe('the land records list of the Audit screen (API-661)', () => {
    const list = async (a, query = '') => {
        const res = await a.api(people.aud, 'GET', `/audit/records${query}`);
        assert.equal(res.statusCode, 200, res.body);
        return res.json();
    };

    it('lists the records changed since their last audit, with what is known of each, and counts every filter', async () => {
        const a = await audited();
        let l = await list(a);
        assert.deepEqual(l.counts, { changed: 1, attention: 0, all: 1 });
        const [row] = l.items;
        assert.deepEqual([row.id, row.label, row.currentVersion, row.proof], [a.record.id, a.record.label, 1, 'waiting']);
        assert.ok(row.owners.length > 0);
        assert.deepEqual(row.audit, { range: { from: 1, to: 1 }, newDocuments: 5, check: 'notOnChain', openFindings: 0, lastSignoff: null });

        // on the blockchain and signed off: no longer changed since the last audit
        await a.anchor();
        assert.equal((await list(a)).items[0].audit.check, 'matches');
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id })).statusCode, 201);
        l = await list(a);
        assert.deepEqual([l.counts.changed, l.items.length, l.total], [0, 0, 0]);
        const [signed] = (await list(a, '?filter=all')).items;
        assert.deepEqual([signed.audit.range, signed.audit.lastSignoff.toVersion, signed.audit.lastSignoff.proof], [null, 1, 'waiting']);
        await a.anchor();
        assert.equal((await list(a, '?filter=all')).items[0].audit.lastSignoff.proof, 'confirmed');
    });

    it('needs attention: an open finding, or a changed item not re-reviewed; search narrows every filter', async () => {
        const a = await audited();
        await a.anchor();
        assert.equal((await a.api(people.aud, 'POST', '/audit/findings', { recordId: a.record.id, version: 1, description: 'Zoning differs from the town planning scheme' })).statusCode, 201);
        let l = await list(a, '?filter=attention');
        assert.deepEqual([l.counts.attention, l.items[0].id, l.items[0].audit.openFindings, l.items[0].needsAttention], [1, a.record.id, 1, true]);
        assert.deepEqual((await list(a, '?filter=all&q=no-such-erf')).counts, { changed: 0, attention: 0, all: 0 });

        // a changed version, found by the record's check: needs attention, and the list says so
        const v1 = await a.service.repo.getVersion(a.record.id, 1);
        await a.service.repo.updateVersion(a.record.id, 1, { data: { ...v1.data, attributes: { ...v1.data.attributes, zoning: 'Industrial' } } });
        await a.api(people.aud, 'GET', `/audit/records/${a.record.id}/check`);
        l = await list(a, '?filter=attention');
        assert.equal(l.items[0].audit.check, 'changed');
        // only auditors and others who may view the audit
        assert.equal((await a.api(people.rec, 'GET', '/audit/records')).statusCode, 403);
    });
});
