import { strict as assert } from 'node:assert';
import { AnchoringsService, explorerUrl } from '../src/anchorings.service.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { buildApp } from '../src/app.js';
import { TestAnchorings } from '../src/test-anchorings.js';
import { cardanoFromEnv } from '../src/cardano/adapter.js';
import { verifyProof } from '../verifier/lrfe-verify.mjs';
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
    const get = async (a, url) => {
        const res = await a.api(viewer, 'GET', url);
        assert.equal(res.statusCode, 200, res.body);
        return res.json();
    };

    it('counts the new fingerprints by kind; each land record version comes with the documents it is made of', async () => {
        const a = await audited();
        await a.anchor();
        const c = await get(a, '/audit/anchors/1/coverage');
        // the record's first version and the six documents filed, one of them in no land record
        assert.deepEqual(c.kinds, { recordVersions: 1, documentVersions: 6, signoffs: 0 });
        assert.ok(c.trailUpTo > 0);
        assert.equal(c.total, 1);
        assert.deepEqual(c.records, [{
            recordId: a.record.id, recordNo: a.record.recordNo, label: a.record.label,
            versions: [{ versionNumber: 1, documents: 5, documentsEarlier: 0, versionsBefore: 0 }], signoffs: []
        }]);
    });

    it('lists the batch\'s documents with number, type and deed number, and the version in the batch made of each', async () => {
        const a = await audited();
        await a.anchor();
        const d = await get(a, '/audit/anchors/1/documents');
        assert.equal(d.total, 6);
        const grant = d.items.find(i => i.documentId === a.docs.grant.id);
        assert.deepEqual([grant.version, grant.edrmsNo, grant.docType], [1, a.docs.grant.edrmsNo, a.docs.grant.docType]);
        assert.deepEqual(grant.usedIn, [{ recordId: a.record.id, versionNumber: 1, recordNo: a.record.recordNo, label: a.record.label }]);
        const olympia = d.items.find(i => i.documentId === a.docs.olympia.id);
        assert.deepEqual(olympia.usedIn, []);                              // in no land record version in this batch
        assert.deepEqual([olympia.edrmsNo, olympia.docType], [a.docs.olympia.edrmsNo, a.docs.olympia.docType]);
        assert.equal((await get(a, '/audit/anchors/1/documents?limit=2&offset=5')).items.length, 1);

        // a correction names no type: it comes from the document's filing
        const doc = a.docs.t2019;
        a.events.publish('edrms.document.amended', { documentId: doc.id, edrmsNo: doc.edrmsNo, version: 2, instrumentRef: 'T 4521/2019', seal: 'ab'.repeat(32) });
        await a.settle();
        await a.anchor();
        const [corrected] = (await get(a, '/audit/anchors/2/documents')).items;
        assert.deepEqual([corrected.documentId, corrected.version, corrected.edrmsNo, corrected.docType, corrected.ref, corrected.usedIn], [doc.id, 2, doc.edrmsNo, doc.docType, 'T 4521/2019', []]);
    });

    it('an audit sign-off is covered by the batch whose checkpoint comes after it, under its land record', async () => {
        const a = await audited();
        await a.anchor();
        assert.equal((await a.api(people.aud, 'POST', '/audit/signoffs', { recordId: a.record.id })).statusCode, 201);
        await a.anchor();
        const c = await get(a, '/audit/anchors/2/coverage');
        assert.deepEqual(c.kinds, { recordVersions: 0, documentVersions: 0, signoffs: 1 });
        assert.deepEqual(c.records.map(r => [r.recordNo, r.versions, r.signoffs]), [[a.record.recordNo, [], [{ from: 1, to: 1 }]]]);
        assert.deepEqual((await get(a, '/audit/anchors/2/documents')).items, []);
        // paged; an unknown batch is 404; without anchors.view it is refused
        assert.deepEqual((await get(a, '/audit/anchors/2/coverage?offset=1')).records, []);
        assert.equal((await a.api(viewer, 'GET', '/audit/anchors/9/coverage')).statusCode, 404);
        assert.equal((await a.api(viewer, 'GET', '/audit/anchors/9/documents')).statusCode, 404);
        assert.equal((await a.api(people.rec, 'GET', '/audit/anchors/1/coverage')).statusCode, 403);
        assert.equal((await a.api(people.rec, 'GET', '/audit/anchors/1/documents')).statusCode, 403);
    });

    it('a later version stands for documents already on the blockchain: counted as made of them, earlier', async () => {
        const repo = createMemoryRepo();
        const ids = { rec: 'bbbbbbbb-0000-4000-8000-000000000001', old: 'aaaaaaaa-0000-4000-8000-000000000001', fresh: 'aaaaaaaa-0000-4000-8000-000000000002' };
        // batch 1: a document; batch 2 failed; batch 3: a new document and version 3, made of both
        repo.leaves.push(...[`document-version:${ids.old}:1`, `document-version:${ids.fresh}:1`, `record-version:${ids.rec}:3`].map((key, leafIndex) => ({ leafIndex, key })));
        repo.anchors.push(
            { batch: 1, size: 1, status: 'confirmed', createdAt: at('05:00') },
            { batch: 2, size: 2, status: 'failed', createdAt: at('06:00') },
            { batch: 3, size: 3, status: 'confirmed', createdAt: at('07:05') }
        );
        const sources = {
            async lookup({ versions = [] }) {
                return {
                    records: versions.length ? [{ id: ids.rec, recordNo: 'LR-NA-2026-000007', label: 'Erf 77, Eros' }] : [],
                    versions: versions.map(v => ({ ...v, documents: [{ id: ids.old, version: 1 }, { id: ids.fresh, version: 1 }] }))
                };
            }
        };
        const s = new AnchoringsService({ repo, tree: { size: async () => 3 }, sources });
        const c = await s.coverage(3);
        assert.equal(c.kinds.documentVersions, 1);                       // batch 2 failed: batch 3 counts from batch 1
        assert.deepEqual(c.records[0].versions, [{ versionNumber: 3, documents: 2, documentsEarlier: 1, versionsBefore: 2 }]);
        const d = await s.documents(3);
        assert.deepEqual(d.items.map(i => [i.documentId, i.usedIn.map(u => u.versionNumber), i.edrmsNo]), [[ids.fresh, [3], null]]);   // no trail entry: sealed before the audit service
    });

    it('a failed batch covers nothing: its replacement does', async () => {
        const a = await audited();
        await a.anchor();
        a.repo.anchors[0].status = 'failed';
        const c = await get(a, '/audit/anchors/1/coverage');
        assert.deepEqual([c.kinds, c.records, c.total, c.trailUpTo], [{ recordVersions: 0, documentVersions: 0, signoffs: 0 }, [], 0, null]);
        assert.deepEqual(await get(a, '/audit/anchors/1/documents'), { batch: 1, items: [], total: 0 });
    });

    it('the land-records lookup answers only the audit service', async () => {
        const a = await audited();
        // a user's token is not a service token: refused as for the other service-only routes
        const res = await a.app.inject({ method: 'POST', url: '/records/lookup', headers: a.as(people.rec), payload: { recordIds: [a.record.id] } });
        assert.equal(res.statusCode, 401);
    });
});

describe('made-up anchorings for the end-to-end tests (API-698)', () => {
    it('a failed batch, then a confirmed one that replaces it and covers what was sealed, as the job would', async () => {
        const a = await audited();
        const made = new TestAnchorings({ repo: a.repo, tree: a.tree, clock: a.clock });
        assert.deepEqual(await made.anchor('failed'), { batch: 1, status: 'failed', size: (await a.tree.size()) });
        const confirmed = await made.anchor('confirmed');
        assert.equal(confirmed.batch, 2);
        const { items, counts } = await a.anchorings.list();
        assert.deepEqual(counts, { all: 2, progress: 0, failed: 1 });
        assert.deepEqual(items.map(i => [i.batch, i.status, i.reason, i.replacedBy, i.replaces]), [[2, 'confirmed', null, null, 1], [1, 'failed', 'expired', 2, null]]);
        // the replacement starts from nothing on the blockchain: no prev, and it covers the record
        assert.equal((await a.anchorings.detail(2)).prev, null);
        const coverage = await a.anchorings.coverage(2);
        assert.deepEqual(coverage.records.map(r => [r.recordNo, r.versions.map(v => v.versionNumber)]), [[a.record.recordNo, [1]]]);
        assert.equal((await a.lookup.search(a.record.recordNo, 'u1')).answer.status, 'yes');
    });

    it('on the test blockchain a confirmed batch is a real transaction: its proofs verify in the portal and with the offline verifier (API-672)', async () => {
        const a = await audited();
        a.cardano.testDriver = a.driver;
        const made = new TestAnchorings({ repo: a.repo, tree: a.tree, cardano: a.cardano, clock: a.clock });
        await made.anchor('confirmed');
        const row = await a.repo.anchorByBatch(1);
        assert.ok(a.driver.chain.blocks.some(b => b.id === row.txHash));
        assert.equal((await a.proofs.verify('record-version', a.record.id, 1)).valid, true);
        // the offline verifier, reading the chain from the test chain's public API answers
        const fetchImpl = async (url, init) => ({
            ok: true, status: 200,
            json: async () => made.publicAnswer(new URL(url).pathname.replace(/^.*(\/tx_\w+)$/, '$1'), JSON.parse(init.body)._tx_hashes)
        });
        const proof = JSON.parse(JSON.stringify(await a.proofs.proof('record-version', a.record.id, 1)));
        const result = await verifyProof(proof, { address: await a.cardano.address(), fetchImpl });
        assert.equal(result.valid, true, JSON.stringify(result));
        assert.equal(new TestAnchorings({ repo: a.repo, tree: a.tree }).publicAnswer('/tx_info', [row.txHash]), null);
    });

    it('the published wallet: its address and explorer page, nulls without a blockchain, 503 while the key cannot be read', async () => {
        const wallet = (cardano) => new AnchoringsService({ repo: createMemoryRepo(), tree: { size: async () => 0 }, cardano }).wallet();
        assert.deepEqual(await wallet(null), { address: null, explorerUrl: null });
        assert.deepEqual(await wallet({ network: 'preview', address: async () => 'addr_test1abc' }), { address: 'addr_test1abc', explorerUrl: 'https://preview.cardanoscan.io/address/addr_test1abc' });
        await assert.rejects(wallet({ network: 'preview', address: async () => { throw new Error('OpenBao down'); } }), e => e.statusCode === 503 && !/OpenBao/.test(e.message));
    });

    it('the test blockchain is refused outside the tests', () => {
        assert.throws(() => cardanoFromEnv({ CARDANO_PROVIDER: 'test', NODE_ENV: 'production' }), /only for the end-to-end tests/);
        assert.ok(cardanoFromEnv({ CARDANO_PROVIDER: 'test', NODE_ENV: 'test' }, { logger: { warn() {}, info() {} } }).testDriver);
    });

    it('the route exists only when the service is started with them, and only for an administrator', async () => {
        const testAnchorings = { anchor: async (outcome) => ({ batch: 1, status: outcome, size: 0 }) };
        const app = await buildApp({ anchorings: service(seeded()), testAnchorings, jwtSecret: SECRET });
        const without = await buildApp({ anchorings: service(seeded()), jwtSecret: SECRET });
        await Promise.all([app.ready(), without.ready()]);
        const as = (target, perms) => ({ authorization: `Bearer ${target.jwt.sign({ typ: 'access', sub: 'u1', name: 'Admin', perms, roles: ['admin'] })}` });
        const post = (target, perms, outcome = 'failed') => target.inject({ method: 'POST', url: '/audit/test/anchorings', headers: as(target, perms), payload: { outcome } });
        assert.equal((await post(app, ['admin.users'])).statusCode, 201);
        assert.equal((await post(app, ['anchors.view'])).statusCode, 403);
        assert.equal((await post(app, ['admin.users'], 'onChain')).statusCode, 400);
        assert.equal((await post(without, ['admin.users'])).statusCode, 404);
        await Promise.all([app.close(), without.close()]);
    });
});
