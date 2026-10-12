import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createEventBus } from '@lrfe/common';
import { AnchoringHealthService } from '../src/anchoring-health.service.js';
import { AnchoringsService } from '../src/anchorings.service.js';
import { TrailService } from '../src/trail.service.js';
import { createCardanoAdapter } from '../src/cardano/adapter.js';
import { createLocalSigner } from '../src/cardano/signer.js';
import { CardanoError } from '../src/cardano/tx.js';
import { createMemoryRepo } from '../src/repo/memory.js';
import { buildApp } from '../src/app.js';
import { fakeDriver } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date('2026-10-12T12:00:00Z');
const hours = (n) => new Date(NOW.getTime() - n * 3_600_000);

/** A health service on the test chain; `tree` says how many fingerprints are sealed. */
function world({ driver = fakeDriver(), signer = createLocalSigner(), size = 10, events = null } = {}) {
    const repo = createMemoryRepo();
    const cardano = createCardanoAdapter({ driver, signer, network: 'preview', minBalanceAda: 5, logger: quiet, events });
    const anchorings = new AnchoringsService({ repo, tree: { size: async () => size }, clock: () => NOW, cardano });
    const health = new AnchoringHealthService({ repo, cardano, anchorings, events, clock: () => NOW });
    return { repo, driver, cardano, health };
}

describe('anchoring health for administrators (API-674)', () => {
    it('healthy: the wallet and its funds, the blockchain in sync, the last anchoring and the next one, no warnings', async () => {
        const w = world();
        w.repo.anchors.push({ batch: 3, root: 'a'.repeat(64), size: 10, status: 'confirmed', createdAt: hours(0.5), network: 'preview' });
        const h = await w.health.health();
        assert.equal(h.configured, true);
        assert.equal(h.wallet.readable, true);
        assert.match(h.wallet.address, /^addr_test1/);
        assert.deepEqual(h.wallet.funds, { ada: '10000', low: false, minimumAda: 5 });
        assert.deepEqual(h.chain, { reachable: true, tipHeight: 100, synced: true });
        assert.deepEqual(h.lastAnchoring, { batch: 3, status: 'confirmed', createdAt: hours(0.5) });
        assert.equal(h.next.waiting, 0);
        assert.deepEqual([h.overdue, h.gaps.count, h.warnings], [false, 0, []]);
    });

    it('low funds, a node catching up, and anchoring overdue while fingerprints wait', async () => {
        const w = world({ driver: fakeDriver({ lovelace: '3000000', synced: false }), size: 15 });
        w.repo.anchors.push({ batch: 1, root: 'a'.repeat(64), size: 10, status: 'confirmed', createdAt: hours(3), network: 'preview' });
        const h = await w.health.health();
        assert.equal(h.wallet.funds.low, true);
        assert.equal(h.next.waiting, 5);
        assert.equal(h.overdue, true);
        assert.deepEqual(h.warnings, ['lowFunds', 'catchingUp', 'overdue']);
    });

    it('the blockchain cannot be reached: said so, and the rest still comes back', async () => {
        const driver = fakeDriver();
        driver.chain.fail = new CardanoError('Blockfrost is unreachable: timeout', 'EUNAVAILABLE');
        const h = await world({ driver }).health.health();
        assert.deepEqual(h.chain, { reachable: false, tipHeight: null, synced: null });
        assert.equal(h.wallet.readable, true);
        assert.equal(h.wallet.funds, null);
        assert.deepEqual(h.warnings, ['unreachable']);
        assert.ok(!JSON.stringify(h).includes('Blockfrost'));
    });

    it('the wallet\'s key cannot be read: no address, a warning, no internal reason', async () => {
        const signer = { publicKey: async () => { throw new Error('OpenBao cannot be reached'); }, sign: async () => { throw new Error('no'); } };
        const h = await world({ signer }).health.health();
        assert.deepEqual(h.wallet, { readable: false, address: null, funds: null });
        assert.ok(h.warnings.includes('walletUnreadable'));
        assert.ok(!JSON.stringify(h).includes('OpenBao'));
    });

    it('recorded trail gaps, and the broadcast warnings that arrive while the service runs', async () => {
        const events = createEventBus({ driver: 'memory', source: 'audit' });
        const w = world({ events });
        w.health.start();
        const trail = new TrailService({ repo: w.repo, logger: quiet });
        await trail.record({ id: randomUUID(), type: 'audit.trail.gap', source: 'audit', time: hours(1).toISOString(), actor: { id: null, name: 'System' }, data: { missing: 3 } });
        await events.publish('audit.trail.gap', { missing: 3 }, { durable: false });
        await w.cardano.balance();                                   // not low: nothing broadcast
        w.driver.chain.ledger = [{ txHash: 'f'.repeat(64), index: 0, lovelace: '1000000', assets: false }];
        await w.cardano.balance();                                   // low: broadcast
        await w.cardano.balance();                                   // again, as the job does each round: kept once
        await new Promise(r => setImmediate(r));
        const h = await w.health.health();
        assert.deepEqual([h.gaps.count, h.gaps.latest[0].missing], [1, 3]);
        assert.deepEqual(h.warnings, ['lowFunds', 'trailGap']);
        assert.deepEqual(h.live.map(l => l.kind), ['trailGap', 'lowFunds']);
    });

    it('without a blockchain: not configured, only trail gaps can warn', async () => {
        const repo = createMemoryRepo();
        const health = new AnchoringHealthService({ repo, anchorings: new AnchoringsService({ repo, tree: { size: async () => 0 }, anchoring: false }) });
        const h = await health.health();
        assert.deepEqual([h.configured, h.wallet.readable, h.chain.reachable, h.next, h.warnings], [false, false, false, null, []]);
    });

    it('the route is for administrators and auditors', async () => {
        const w = world();
        const app = await buildApp({ health: w.health, jwtSecret: 'health-test-secret-health-test-secret' });
        await app.ready();
        const as = (perms) => ({ authorization: `Bearer ${app.jwt.sign({ typ: 'access', sub: 'u1', name: 'A', perms, roles: [] })}` });
        const get = (perms) => app.inject({ url: '/audit/anchoring/health', headers: as(perms) });
        assert.equal((await get(['admin.policies'])).statusCode, 200);
        assert.equal((await get(['audit.view'])).statusCode, 200);
        assert.equal((await get(['record.view'])).statusCode, 403);
        await app.close();
    });
});
