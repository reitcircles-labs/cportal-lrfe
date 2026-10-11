import { strict as assert } from 'node:assert';
import { AnchoringsService, explorerUrl } from '../src/anchorings.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { buildApp } from '../src/app.js';
import { audited, people } from './register.js';

const SECRET = 'anchorings-test-secret-at-least-32-chars';
const at = (time) => new Date(`2026-10-11T${time}:00Z`);
const hex = (c) => c.repeat(64);

/**
 * Five batches: two confirmed, then one that expired before reaching the blockchain (stored before
 * the reason was, so only its error text says why), its replacement, and one in a block, 4 deep.
 */
function seeded() {
    const repo = createMemoryRepo();
    const base = { network: 'preview', attempts: 1, cbor: 'cbor', ttl: 1 };
    repo.anchors.push(
        { ...base, batch: 1, root: hex('1'), size: 10, prevRoot: null, status: 'confirmed', txHash: hex('a'), blockHeight: 500, confirmations: 10, createdAt: at('04:00'), submittedAt: at('04:00'), onChainAt: at('04:01'), confirmedAt: at('04:06') },
        { ...base, batch: 2, root: hex('2'), size: 14, prevRoot: hex('1'), status: 'confirmed', txHash: hex('b'), blockHeight: 560, createdAt: at('05:00'), submittedAt: at('05:00'), confirmedAt: at('05:06') },
        { ...base, batch: 3, root: hex('3'), size: 20, prevRoot: hex('2'), status: 'failed', txHash: hex('c'), attempts: 12, error: 'expired before it reached the chain', createdAt: at('06:00'), submittedAt: at('06:00') },
        { ...base, batch: 4, root: hex('4'), size: 25, prevRoot: hex('2'), status: 'confirmed', txHash: hex('d'), blockHeight: 640, confirmations: 11, createdAt: at('07:05'), submittedAt: at('07:05'), onChainAt: at('07:06'), confirmedAt: at('07:11') },
        { ...base, batch: 5, root: hex('5'), size: 27, prevRoot: hex('4'), status: 'onChain', txHash: hex('e'), blockHeight: 700, confirmations: 4, createdAt: at('07:30'), submittedAt: at('07:30'), onChainAt: at('07:31') }
    );
    return repo;
}

function service(repo, { size = 30, anchoring = true } = {}) {
    return new AnchoringsService({ repo, tree: { size: async () => size }, clock: () => at('08:00'), anchoring, config: { periodMs: 3_600_000, retryMs: 300_000, confirmations: 10 } });
}

describe('the Anchorings list and detail (API-671)', () => {
    it('lists every batch newest first: what it covers, its status, transaction and block, and what replaced a failed one', async () => {
        const l = await service(seeded()).list();
        assert.deepEqual(l.items.map(i => i.batch), [5, 4, 3, 2, 1]);
        assert.deepEqual(l.counts, { all: 5, progress: 1, failed: 1 });
        assert.equal(l.total, 5);
        // covered since the last batch that did not fail: the replacement counts from batch 2
        assert.deepEqual(l.items.map(i => i.covers), [2, 11, null, 4, 10]);
        const [onChain, replacement, failed, , first] = l.items;
        assert.deepEqual([onChain.status, onChain.block, onChain.confirmations], ['onChain', 700, 4]);
        assert.deepEqual([first.status, first.confirmations, first.txHash], ['confirmed', 10, hex('a')]);
        assert.equal(first.explorerUrl, `https://preview.cardanoscan.io/transaction/${hex('a')}`);
        assert.equal(l.items[3].confirmations, 10);                        // confirmed before depth was stored
        // the failed one: why (read from its old error text), what replaced it, no transaction to show
        assert.deepEqual([failed.status, failed.reason, failed.replacedBy, failed.txHash, failed.explorerUrl, failed.block], ['failed', 'expired', 4, null, null, null]);
        assert.deepEqual([replacement.replaces, replacement.reason, replacement.replacedBy], [3, null, null]);
        assert.equal(l.confirmationsNeeded, 10);
    });

    it('filters: on their way, or failed; pages newest first', async () => {
        const repo = seeded();
        const s = service(repo);
        assert.deepEqual((await s.list({ status: 'progress' })).items.map(i => i.batch), [5]);
        const failed = await s.list({ status: 'failed' });
        assert.deepEqual([failed.items.map(i => i.batch), failed.total], [[3], 1]);
        assert.deepEqual((await s.list({ limit: 2, offset: 1 })).items.map(i => i.batch), [4, 3]);
        // a transaction prepared but not yet sent is already on its way; a refusal has its own reason
        repo.anchors.push({ batch: 6, root: hex('6'), size: 29, prevRoot: hex('5'), network: 'preview', status: 'prepared', txHash: hex('f'), attempts: 0, createdAt: at('07:58') });
        repo.anchors[2].reason = 'refused';
        const l = await s.list();
        assert.deepEqual([l.items[0].status, l.items[0].covers, l.counts.progress], ['sent', 2, 2]);
        assert.equal(l.items.find(i => i.batch === 3).reason, 'refused');
    });

    it('one batch: what is on the blockchain, the batch its previous root belongs to, its steps and neighbours', async () => {
        const d = await service(seeded()).detail(4);
        assert.deepEqual([d.root, d.size, d.prev], [hex('4'), 25, { root: hex('2'), batch: 2 }]);
        assert.deepEqual(d.steps, { createdAt: at('07:05'), sentAt: at('07:05'), sends: 1, onChainAt: at('07:06'), confirmedAt: at('07:11'), failedAt: null });
        assert.deepEqual([d.replaces, d.previousBatch, d.nextBatch, d.replacement], [3, 3, 5, null]);
        assert.equal((await service(seeded()).detail(1)).prev, null);
    });

    it('a failed batch: why, what was prepared, and the batch that replaced it', async () => {
        const d = await service(seeded()).detail(3);
        assert.deepEqual([d.status, d.reason, d.txHash], ['failed', 'expired', null]);
        assert.deepEqual([d.root, d.size, d.prev], [hex('3'), 20, { root: hex('2'), batch: 2 }]);
        assert.deepEqual(d.replacement, { batch: 4, status: 'confirmed', createdAt: at('07:05') });
        assert.equal(d.steps.sends, 12);
        await assert.rejects(service(seeded()).detail(9), { statusCode: 404 });
    });

    it('the next batch: a period after the last one, shortly after a failed one, with the fingerprints waiting for it', async () => {
        const repo = seeded();
        assert.deepEqual(await service(repo).next(), { dueAt: at('08:30'), waiting: 3 });
        repo.anchors.push({ batch: 6, root: hex('6'), size: 29, prevRoot: hex('5'), network: 'preview', status: 'failed', reason: 'refused', createdAt: at('07:58') });
        assert.deepEqual(await service(repo).next(), { dueAt: at('08:03'), waiting: 3 });
        // a batch given up, then found on chain and confirmed after the failed one: the full period again
        repo.anchors[3].confirmedAt = at('08:00');
        repo.anchors[4].status = 'failed';
        assert.deepEqual(await service(repo).next(), { dueAt: at('08:05'), waiting: 5 });
        repo.anchors[4].status = 'onChain';
        repo.anchors[3].confirmedAt = at('07:11');
        // overdue (nothing new to anchor yet): due now
        repo.anchors.pop();
        repo.anchors[4].createdAt = at('06:30');
        assert.deepEqual(await service(repo, { size: 27 }).next(), { dueAt: at('08:00'), waiting: 0 });
        assert.equal(await service(repo, { anchoring: false }).next(), null);
        assert.equal((await service(createMemoryRepo()).list()).next.dueAt.getTime(), at('08:00').getTime());
    });

    it('the explorer link names the network only in its address; an unknown network has none', () => {
        assert.equal(explorerUrl('mainnet', hex('a')), `https://cardanoscan.io/transaction/${hex('a')}`);
        assert.equal(explorerUrl('preprod', hex('a')), `https://preprod.cardanoscan.io/transaction/${hex('a')}`);
        assert.equal(explorerUrl('elsewhere', hex('a')), null);
    });

    it('every signed-in user with anchors.view may look; others may not', async () => {
        const app = await buildApp({ anchorings: service(seeded()), jwtSecret: SECRET });
        await app.ready();
        const as = (perms) => ({ authorization: `Bearer ${app.jwt.sign({ typ: 'access', sub: 'u9', name: 'Someone', perms, roles: ['scan'] })}` });
        const get = (url, headers) => app.inject({ method: 'GET', url, headers });
        const scanOperator = as(['dashboard.view', 'capture.view', 'anchors.view']);
        const list = await get('/audit/anchors?status=failed', scanOperator);
        assert.equal(list.statusCode, 200, list.body);
        assert.deepEqual(list.json().items.map(i => i.batch), [3]);
        // field by field: the internal error, the signed transaction and the wallet output never leave the service
        const ROW = ['batch', 'block', 'confirmations', 'covers', 'createdAt', 'explorerUrl', 'reason', 'replacedBy', 'replaces', 'status', 'txHash'];
        assert.deepEqual(Object.keys(list.json().items[0]).sort(), ROW);
        const detail = (await get('/audit/anchors/3', scanOperator)).json();
        assert.deepEqual(Object.keys(detail).sort(), [...ROW, 'confirmationsNeeded', 'nextBatch', 'prev', 'previousBatch', 'replacement', 'root', 'size', 'steps'].sort());
        assert.equal((await get('/audit/anchors/4', scanOperator)).json().prev.batch, 2);
        assert.equal((await get('/audit/anchors/9', scanOperator)).statusCode, 404);
        assert.equal((await get('/audit/anchors/latest', scanOperator)).statusCode, 400);
        assert.equal((await get('/audit/anchors?status=pending', scanOperator)).statusCode, 400);
        assert.equal((await get('/audit/anchors', as(['dashboard.view']))).statusCode, 403);
        assert.equal((await get('/audit/anchors')).statusCode, 401);
        await app.close();
    });
});

describe('what a batch covers (API-696)', () => {
    // anyone signed in may look: here the records officer, given anchors.view as every role has it
    const viewer = { ...people.rec, perms: [...people.rec.perms, 'anchors.view'] };
    const coverage = async (a, batch, query = '') => {
        const res = await a.api(viewer, 'GET', `/audit/anchors/${batch}/coverage${query}`);
        assert.equal(res.statusCode, 200, res.body);
        return res.json();
    };

    it('counts the new fingerprints by kind and groups them by land record; a document no committed version pins is only counted', async () => {
        const a = await audited();
        await a.anchor();
        const c = await coverage(a, 1);
        // the record's first version and the six documents filed, one of them in no land record
        assert.deepEqual(c.kinds, { recordVersions: 1, documentVersions: 6, signoffs: 0 });
        assert.equal(c.documentsWithoutRecord, 1);
        assert.ok(c.trailUpTo > 0);
        assert.equal(c.total, 1);
        assert.deepEqual(c.records, [{ recordId: a.record.id, recordNo: a.record.recordNo, label: a.record.label, versions: [1], documents: 5, signoffs: [] }]);
    });

    it('an audit sign-off is covered by the batch whose checkpoint comes after it, under its land record', async () => {
        const a = await audited();
        await a.anchor();
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id })).statusCode, 201);
        await a.anchor();
        const c = await coverage(a, 2);
        assert.deepEqual(c.kinds, { recordVersions: 0, documentVersions: 0, signoffs: 1 });
        assert.deepEqual(c.records.map(r => [r.recordNo, r.versions, r.documents, r.signoffs]), [[a.record.recordNo, [], 0, [{ from: 1, to: 1 }]]]);
        // paged; an unknown batch is 404; without anchors.view it is refused
        assert.deepEqual((await coverage(a, 2, '?offset=1')).records, []);
        assert.equal((await a.api(viewer, 'GET', '/audit/anchors/9/coverage')).statusCode, 404);
        assert.equal((await a.api(people.rec, 'GET', '/audit/anchors/1/coverage')).statusCode, 403);
    });

    it('a failed batch covers nothing: its replacement does', async () => {
        const a = await audited();
        await a.anchor();
        a.repo.anchors[0].status = 'failed';
        const c = await coverage(a, 1);
        assert.deepEqual([c.kinds, c.records, c.total, c.trailUpTo], [{ recordVersions: 0, documentVersions: 0, signoffs: 0 }, [], 0, null]);
    });

    it('counts from the last batch before it that did not fail, and lists a record known only through a pin, by its label', async () => {
        const repo = createMemoryRepo();
        const ids = { kept: 'aaaaaaaa-0000-4000-8000-000000000001', loose: 'aaaaaaaa-0000-4000-8000-000000000002', rec: 'bbbbbbbb-0000-4000-8000-000000000001' };
        repo.leaves.push(...['document-version:x:1', `document-version:${ids.kept}:1`, `document-version:${ids.loose}:1`].map((key, leafIndex) => ({ leafIndex, key })));
        repo.anchors.push(
            { batch: 1, size: 1, status: 'confirmed', createdAt: at('05:00') },
            { batch: 2, size: 2, status: 'failed', createdAt: at('06:00') },
            { batch: 3, size: 3, status: 'confirmed', createdAt: at('07:05') }
        );
        const sources = {
            async lookup({ documents = [] }) {
                return {
                    records: documents.some(d => d.id === ids.kept) ? [{ id: ids.rec, recordNo: 'LR-NA-2026-000007', label: 'Erf 77, Eros' }] : [],
                    documents: documents.map(d => ({ ...d, pinnedBy: d.id === ids.kept ? [{ recordId: ids.rec, versionNumber: 4 }] : [] }))
                };
            }
        };
        const c = await new AnchoringsService({ repo, tree: { size: async () => 3 }, sources }).coverage(3);
        assert.deepEqual([c.kinds.documentVersions, c.documentsWithoutRecord], [2, 1]);   // batch 2 failed: both its leaf and batch 3's
        assert.deepEqual(c.records, [{ recordId: ids.rec, recordNo: 'LR-NA-2026-000007', label: 'Erf 77, Eros', versions: [], documents: 1, signoffs: [] }]);
    });

    it('the land-records lookup answers only the audit service', async () => {
        const a = await audited();
        // a user's token is not a service token: refused as for the other service-only routes
        const res = await a.app.inject({ method: 'POST', url: '/records/lookup', headers: a.as(people.rec), payload: { recordIds: [a.record.id] } });
        assert.equal(res.statusCode, 401);
    });
});
