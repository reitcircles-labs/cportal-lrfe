import { strict as assert } from 'node:assert';
import { AnchorLookupService, classify } from '../src/lookup.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { audited, people, rec } from './register.js';
import { erf1873 } from '../../land-records/tests/helpers.js';

// anyone signed in may search: here the records officer, given anchors.view as every role has it
const viewer = { ...people.rec, perms: [...people.rec.perms, 'anchors.view'] };

describe('"Is it on the blockchain?" (API-697)', () => {
    const search = async (a, q, user = viewer) => {
        const res = await a.api(user, 'GET', `/audit/anchors/lookup?q=${encodeURIComponent(q)}`);
        assert.equal(res.statusCode, 200, res.body);
        return res.json();
    };

    it('a land record by number or Erf: waiting for the next batch, then yes, with its versions and documents and their batch', async () => {
        const a = await audited();
        let r = await search(a, a.record.recordNo);
        assert.deepEqual([r.kind, r.record.id, r.record.currentVersion], ['record', a.record.id, 1]);
        assert.deepEqual([r.answer.status, r.answer.version], ['waiting', 1]);
        assert.ok(r.answer.nextDueAt);

        await a.anchor();
        r = await search(a, 'Erf 1873');
        assert.deepEqual(r.answer, { status: 'yes', version: 1, batch: 1 });
        const version = r.history.find(h => h.kind === 'version');
        assert.deepEqual([version.versionNumber, version.status, version.batch], [1, 'confirmed', 1]);
        const documents = r.history.filter(h => h.kind === 'document');
        assert.equal(documents.length, 5);                                  // the documents version 1 is made of
        const deed = documents.find(d => d.documentId === a.docs.t2008.id);
        assert.deepEqual([deed.edrmsNo, deed.docType, deed.status, deed.batch], [a.docs.t2008.edrmsNo, a.docs.t2008.docType, 'confirmed', 1]);
        // newest first
        const times = r.history.map(h => new Date(h.at).getTime());
        assert.deepEqual(times, [...times].sort((x, y) => y - x));
        assert.equal((await search(a, a.record.recordNo.toLowerCase())).record.id, a.record.id);
    });

    it('a document by number or deed number: its versions, and the land record versions made of it', async () => {
        const a = await audited();
        await a.anchor();
        const byNumber = await search(a, a.docs.t2008.edrmsNo);
        const byDeed = await search(a, a.docs.t2008.instrumentRef);
        for (const r of [byNumber, byDeed]) {
            assert.deepEqual([r.kind, r.document.id, r.document.edrmsNo, r.document.ref], ['document', a.docs.t2008.id, a.docs.t2008.edrmsNo, a.docs.t2008.instrumentRef]);
            assert.deepEqual(r.answer, { status: 'yes', version: 1, batch: 1 });
            assert.deepEqual(r.history.filter(h => h.kind === 'document').map(h => [h.version, h.status, h.batch]), [[1, 'confirmed', 1]]);
            const [used] = r.history.filter(h => h.kind === 'usedIn');
            assert.deepEqual([used.recordNo, used.label, used.versionNumber, used.documentVersion, used.batch], [a.record.recordNo, a.record.label, 1, 1, 1]);
        }
        // a document in no land record version yet
        const loose = await search(a, a.docs.olympia.edrmsNo);
        assert.deepEqual([loose.kind, loose.history.filter(h => h.kind === 'usedIn')], ['document', []]);
    });

    it('an audit sign-off is in the land record\'s history with the batch that put it on the blockchain', async () => {
        const a = await audited();
        await a.anchor();
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id })).statusCode, 201);
        let [signoff] = (await search(a, a.record.recordNo)).history.filter(h => h.kind === 'signoff');
        assert.deepEqual([signoff.from, signoff.to, signoff.status, signoff.batch], [1, 1, 'waiting', null]);
        await a.anchor();
        [signoff] = (await search(a, a.record.recordNo)).history.filter(h => h.kind === 'signoff');
        assert.deepEqual([signoff.status, signoff.batch], ['confirmed', 2]);
    });

    it('never finds a land record by an owner\'s name or ID number; a draft land record is not offered', async () => {
        const a = await audited();
        const [owner] = (await a.service.getRecord(a.record.id)).current.data.owners;
        assert.ok(owner.name && owner.idNo);
        for (const q of [owner.name, owner.idNo]) assert.equal((await search(a, q)).kind, 'none', q);
        // a second land record, still a draft: words matching both find only the committed one
        await a.service.createRecord({ parcel: { ...erf1873(), number: '1874' } }, rec);
        const r = await search(a, 'Erf');
        assert.deepEqual([r.kind, r.record?.id], ['record', a.record.id]);
    });

    it('nothing found; the query is required; only with anchors.view', async () => {
        const a = await audited();
        assert.deepEqual(await search(a, 'no such place'), { query: 'no such place', kind: 'none' });
        assert.deepEqual(await search(a, 'EDR-NA-2026-999999'), { query: 'EDR-NA-2026-999999', kind: 'none' });
        assert.deepEqual(await search(a, 'LR-NA-2026-999999'), { query: 'LR-NA-2026-999999', kind: 'none' });
        assert.equal((await a.api(viewer, 'GET', '/audit/anchors/lookup')).statusCode, 400);
        assert.equal((await a.api(people.rec, 'GET', '/audit/anchors/lookup?q=Erf')).statusCode, 403);
    });
});

describe('the search on its own (API-697)', () => {
    /** The service with land records and documents given as plain lists. */
    function service(records, { batch = { status: 'waiting', batch: null } } = {}) {
        const sources = {
            async records({ q }) { return { items: records.filter(r => (r.recordNo + ' ' + r.label).toLowerCase().includes(q.toLowerCase())) }; },
            async versions() { return [{ versionNumber: 1, state: 'committed', committedAt: '2026-10-01T08:00:00Z' }]; },
            async lookup() { return { versions: [], records: [], pinnedBy: [] }; },
            async documentByNumber() { return null; },
            async document() { throw new Error('not here'); }
        };
        const proofs = { async batchOf(keys) { return Object.fromEntries(keys.map(k => [k, batch])); }, async entryBatch() { return batch; } };
        const anchorings = { async next() { return { dueAt: new Date('2026-10-11T09:00:00Z'), waiting: 3 }; } };
        let now = Date.parse('2026-10-11T08:00:00Z');
        const clock = () => new Date(now);
        clock.advance = (ms) => { now += ms; };
        return { s: new AnchorLookupService({ repo: createMemoryRepo(), proofs, anchorings, sources, clock }), clock };
    }
    const erf = (n, township, committed = true) => ({ id: `id-${n}`, recordNo: `LR-NA-2026-${String(n).padStart(6, '0')}`, label: `Erf ${n}, ${township}`, currentVersion: committed ? 1 : null });

    it('tells numbers from words', () => {
        assert.equal(classify('LR-NA-2026-000001'), 'recordNo');
        assert.equal(classify('edr-na-2026-000412'), 'edrmsNo');
        for (const q of ['T 2210/2008', 'T2210/2008', 'T 2210 / 2008', 'A 412/2007', 'B 3301/2015']) assert.equal(classify(q), 'instrument', q);
        for (const q of ['Erf 1873', 'Klein Windhoek', '1873']) assert.equal(classify(q), 'words', q);
    });

    it('words matching several land records offer them to choose from; one never committed is left out', async () => {
        const { s } = service([erf(1873, 'Klein Windhoek'), erf(406, 'Klein Windhoek'), erf(77, 'Klein Windhoek', false)]);
        const r = await s.search('  Klein   Windhoek ', 'u1');
        assert.deepEqual([r.kind, r.query, r.choices.map(c => c.label)], ['choices', 'Klein Windhoek', ['Erf 1873, Klein Windhoek', 'Erf 406, Klein Windhoek']]);
        assert.equal((await s.search('Erf 77', 'u1')).kind, 'none');
    });

    it('the answer for the current version: yes, on its way, or waiting with when the next batch is due', async () => {
        assert.deepEqual((await service([erf(1, 'Eros')], { batch: { status: 'confirmed', batch: 4 } }).s.search('Erf 1', 'u1')).answer, { status: 'yes', version: 1, batch: 4 });
        assert.deepEqual((await service([erf(1, 'Eros')], { batch: { status: 'onChain', batch: 5 } }).s.search('Erf 1', 'u1')).answer, { status: 'yes', version: 1, batch: 5 });
        assert.deepEqual((await service([erf(1, 'Eros')], { batch: { status: 'sent', batch: 6 } }).s.search('Erf 1', 'u1')).answer, { status: 'sent', version: 1, batch: 6 });
        assert.deepEqual((await service([erf(1, 'Eros')]).s.search('Erf 1', 'u1')).answer, { status: 'waiting', version: 1, nextDueAt: new Date('2026-10-11T09:00:00Z') });
        assert.deepEqual((await service([erf(1, 'Eros')], { batch: null }).s.search('Erf 1', 'u1')).answer, { status: 'notRecorded', version: 1 });
    });

    it('30 searches a minute per user; the next one is refused until the minute has passed', async () => {
        const { s, clock } = service([erf(1, 'Eros')]);
        for (let i = 0; i < 30; i++) await s.search('Erf 1', 'u1');
        await assert.rejects(s.search('Erf 1', 'u1'), { statusCode: 429 });
        await s.search('Erf 1', 'u2');                                       // another user is not affected
        clock.advance(60_000);
        await s.search('Erf 1', 'u1');
    });
});
