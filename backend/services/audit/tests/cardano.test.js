import { strict as assert } from 'node:assert';
import { createHash, verify as edVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import C from '@emurgo/cardano-serialization-lib-nodejs';
import { createCardanoAdapter, cardanoFromEnv } from '../src/cardano/adapter.js';
import { createBlockfrostDriver, createOgmiosDriver } from '../src/cardano/drivers.js';
import { createLocalSigner, createTransitSigner } from '../src/cardano/signer.js';
import { addressOf, buildAnchorTx, readAnchorMetadata } from '../src/cardano/tx.js';
import { fakeDriver, PARAMS, txid } from './helpers.js';

const root = (n = 1) => createHash('sha256').update(`root ${n}`).digest('hex');

function makeAdapter(opts = {}) {
    const driver = fakeDriver(opts);
    const signer = createLocalSigner();
    const warnings = [], published = [];
    const adapter = createCardanoAdapter({
        driver, signer, network: 'preview', minBalanceAda: opts.minBalanceAda ?? 5,
        logger: { warn: (o, m) => warnings.push([o, m]) },
        events: { publish: async (type, data, o) => { published.push({ type, data, o }); } }
    });
    return { driver, signer, adapter, warnings, published };
}

describe('Cardano: the anchoring transaction (API-656)', () => {
    it('one input, one change output, the root under label 8890, fee from the parameters, a valid signature', async () => {
        const { adapter, driver, signer } = makeAdapter();
        const r = await adapter.anchor({ root: root(1), size: 41300, batch: 7, prev: root(0) });
        const tx = C.Transaction.from_hex(r.cbor);
        const body = tx.body();
        assert.equal(body.inputs().len(), 1);
        assert.equal(body.inputs().get(0).transaction_id().to_hex(), txid(0));
        assert.equal(body.outputs().len(), 1);
        assert.equal(body.outputs().get(0).address().to_bech32('addr_test'), await adapter.address());
        assert.ok(body.outputs().get(0).amount().multiasset() === undefined || body.outputs().get(0).amount().multiasset().len() === 0);
        // fee = 44 × size + 155,381, for the transaction as sent (signature included)
        assert.equal(r.bytes, Buffer.from(r.cbor, 'hex').length);
        assert.ok(BigInt(r.fee) >= BigInt(44 * r.bytes + 155381) && BigInt(r.fee) <= BigInt(44 * (r.bytes + 2) + 155381), `fee ${r.fee} for ${r.bytes} bytes`);
        assert.equal(BigInt(body.outputs().get(0).amount().coin().to_str()) + BigInt(r.fee), 10_000_000_000n);
        // the metadata: what the design says, readable back
        assert.deepEqual(readAnchorMetadata(r.cbor), { v: 1, sys: 'lrfe-audit', root: root(1), size: 41300, batch: 7, prev: root(0) });
        assert.deepEqual(await adapter.lookup(r.txHash), r.metadata);
        // the witness: our key, a valid Ed25519 signature over the body hash (the transaction id)
        const w = tx.witness_set().vkeys().get(0);
        assert.deepEqual(Buffer.from(w.vkey().public_key().as_bytes()), await signer.publicKey());
        assert.ok(edVerify(null, Buffer.from(r.txHash, 'hex'), signer.nodePublicKey, Buffer.from(w.signature().to_bytes())));
        assert.equal(driver.chain.submitted[0].id, r.txHash);
        console.log(`      anchoring transaction: ${r.bytes} bytes, fee ${r.fee} lovelace`);
    });

    it('the next anchoring spends the change of the previous one', async () => {
        const { adapter } = makeAdapter();
        const a = await adapter.anchor({ root: root(1), size: 1, batch: 1 });
        const b = await adapter.anchor({ root: root(2), size: 2, batch: 2, prev: root(1) });
        assert.equal(C.Transaction.from_hex(b.cbor).body().inputs().get(0).transaction_id().to_hex(), a.txHash);
    });

    it('outputs holding other tokens are not spent; without enough ADA it says so', async () => {
        const address = addressOf(Buffer.alloc(32, 1), 'preview');
        const base = { address, publicKey: Buffer.alloc(32, 1), params: PARAMS, metadata: { v: 1, root: root() } };
        const tokens = [{ txHash: txid(1), index: 0, lovelace: '50000000', assets: true }, { txHash: txid(2), index: 1, lovelace: '3000000', assets: false }];
        assert.equal(buildAnchorTx({ ...base, utxos: tokens }).input.txHash, txid(2));
        assert.throws(() => buildAnchorTx({ ...base, utxos: [tokens[0]] }), e => e.code === 'EFUNDS' && !e.retryable);
        assert.throws(() => buildAnchorTx({ ...base, utxos: [{ txHash: txid(3), index: 0, lovelace: '900000', assets: false }] }), e => e.code === 'EFUNDS' && /needs/.test(e.message));
        assert.throws(() => buildAnchorTx({ ...base, utxos: [{ txHash: txid(4), index: 0, lovelace: '100000', assets: false }] }), e => e.code === 'EFUNDS' && /does not pay/.test(e.message));
    });

    it('refuses a root that is not 32 bytes of hex', async () => {
        const { adapter } = makeAdapter();
        await assert.rejects(adapter.anchor({ root: 'abc', size: 1, batch: 1 }), e => e.code === 'ECONFIG');
    });

    it('preview and mainnet addresses differ by their network id', () => {
        const key = Buffer.alloc(32, 9);
        assert.match(addressOf(key, 'preview'), /^addr_test1v/);
        assert.match(addressOf(key, 'mainnet'), /^addr1v/);
        assert.throws(() => addressOf(key, 'testnet'), e => e.code === 'ECONFIG');
    });
});

describe('Cardano: outages, refusals and the wallet (API-656)', () => {
    it('an outage is reported as retryable; a refused transaction is not', async () => {
        const { adapter, driver } = makeAdapter();
        const { CardanoError } = await import('../src/cardano/tx.js');
        driver.chain.fail = new CardanoError('Blockfrost is unreachable: timeout', 'EUNAVAILABLE');
        await assert.rejects(adapter.anchor({ root: root(), size: 1, batch: 1 }), e => e.code === 'EUNAVAILABLE' && e.retryable);
        driver.chain.fail = null;
        driver.chain.reject = new CardanoError('The chain refused the transaction: BadInputsUTxO', 'EREJECTED');
        await assert.rejects(adapter.anchor({ root: root(), size: 1, batch: 1 }), e => e.code === 'EREJECTED' && !e.retryable);
        driver.chain.reject = null;
        assert.ok((await adapter.anchor({ root: root(), size: 1, batch: 1 })).txHash);      // later: it goes through
    });

    it('a node still syncing does not anchor yet (retryable)', async () => {
        const { adapter, driver } = makeAdapter({ synced: false });
        await assert.rejects(adapter.anchor({ root: root(), size: 1, batch: 1 }), e => e.code === 'EUNAVAILABLE' && /catching up/.test(e.message));
        assert.equal(driver.chain.submitted.length, 0);
    });

    it('status: on chain, how deep', async () => {
        const { adapter, driver } = makeAdapter();
        const r = await adapter.anchor({ root: root(), size: 1, batch: 1 });
        driver.chain.height = 109;
        assert.deepEqual(await adapter.status(r.txHash), { onChain: true, blockHeight: 100, tipHeight: 109, tipSlot: 2000, depth: 10 });
        assert.deepEqual(await adapter.status(txid(77)), { onChain: false, blockHeight: null, tipHeight: 109, tipSlot: 2000, depth: null });
    });

    it('the balance; below the minimum a warning in the log and a broadcast-only event', async () => {
        const rich = makeAdapter();
        assert.deepEqual(await rich.adapter.balance(), { lovelace: '10000000000', ada: '10000', low: false });
        assert.equal(rich.published.length, 0);
        const poor = makeAdapter({ lovelace: '4200000' });
        assert.equal((await poor.adapter.balance()).low, true);
        assert.match(poor.warnings[0][1], /low on funds/);
        assert.equal(poor.published[0].type, 'audit.wallet.low');
        assert.equal(poor.published[0].data.ada, '4.2');
        assert.deepEqual(poor.published[0].o, { durable: false });
    });

    it('settings: no provider means no anchoring; an unknown one, mainnet or missing OpenBao settings are refused', () => {
        assert.equal(cardanoFromEnv({}), null);
        assert.throws(() => cardanoFromEnv({ CARDANO_PROVIDER: 'koios' }), e => e.code === 'ECONFIG');
        assert.throws(() => cardanoFromEnv({ CARDANO_PROVIDER: 'ogmios', CARDANO_NETWORK: 'mainnet' }), e => e.code === 'ECONFIG');
        assert.throws(() => cardanoFromEnv({ CARDANO_PROVIDER: 'ogmios' }), e => e.code === 'ECONFIG' && /BAO_ADDR/.test(e.message));
        assert.throws(() => cardanoFromEnv({ CARDANO_PROVIDER: 'blockfrost', BAO_ADDR: 'x' }), e => e.code === 'ECONFIG' && /project key/.test(e.message));
    });
});

// ---------------------------------------------------------------- the drivers, against recorded answers

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('Cardano: the Ogmios driver (API-656)', () => {
    function ogmios(answers) {
        const calls = [];
        const fetch = async (url, init) => {
            if (url.endsWith('/health')) return reply(200, answers.health);
            const { method, params } = JSON.parse(init.body);
            calls.push({ method, params });
            const a = answers[method];
            if (a instanceof Error) throw a;
            return reply(200, a.error ? { jsonrpc: '2.0', error: a.error } : { jsonrpc: '2.0', result: a });
        };
        return { driver: createOgmiosDriver({ url: 'http://127.0.0.1:1337', fetch }), calls };
    }

    it('reads parameters, outputs, height and sync state in Ogmios v6 shapes (as the local node answers)', async () => {
        const { driver, calls } = ogmios({
            'queryLedgerState/protocolParameters': { minFeeCoefficient: 44, minFeeConstant: { ada: { lovelace: 155381 } }, minUtxoDepositCoefficient: 4310, maxTransactionSize: { bytes: 16384 } },
            'queryLedgerState/utxo': [{ transaction: { id: txid(1) }, index: 0, address: 'addr_test1…', value: { ada: { lovelace: 9000000 } } },
                { transaction: { id: txid(2) }, index: 1, value: { ada: { lovelace: 2000000 }, abcd: { '74': 1 } } }],
            'queryNetwork/blockHeight': 635536,
            'queryNetwork/tip': { slot: 14330226, id: 'd2a7c9f6' },
            health: { networkSynchronization: 0.04661 }
        });
        assert.deepEqual(await driver.parameters(), PARAMS);
        assert.deepEqual(await driver.utxos('addr_test1x'), [{ txHash: txid(1), index: 0, lovelace: '9000000', assets: false }, { txHash: txid(2), index: 1, lovelace: '2000000', assets: true }]);
        assert.deepEqual(calls.at(-1).params, { addresses: ['addr_test1x'] });
        assert.deepEqual(await driver.output(txid(1), 0), { onChain: true, blockHeight: null });
        assert.deepEqual(calls.at(-1).params, { outputReferences: [{ transaction: { id: txid(1) }, index: 0 }] });
        assert.equal(await driver.tipHeight(), 635536);
        assert.equal(await driver.tipSlot(), 14330226);
        assert.equal(await driver.synced(), false);
        assert.equal(driver.metadata, null);
    });

    it('a refused transaction, an unreachable node and other failures', async () => {
        const refused = ogmios({ submitTransaction: { error: { code: 3117, message: 'Some inputs are unknown', data: {} } } });
        await assert.rejects(refused.driver.submit('84a3'), e => e.code === 'EREJECTED' && /inputs are unknown/.test(e.message));
        const malformed = ogmios({ submitTransaction: { error: { code: -32602, message: 'Invalid transaction' } } });
        await assert.rejects(malformed.driver.submit('00'), e => e.code === 'EREJECTED');
        const down = ogmios({ 'queryNetwork/blockHeight': new TypeError('fetch failed') });
        await assert.rejects(down.driver.tipHeight(), e => e.code === 'EUNAVAILABLE' && e.retryable);
        const busy = ogmios({ 'queryLedgerState/utxo': { error: { code: 2001, message: 'era mismatch' } } });
        await assert.rejects(busy.driver.utxos('a'), e => e.code === 'EUNAVAILABLE');
        const ok = ogmios({ submitTransaction: { transaction: { id: txid(5) } } });
        assert.equal(await ok.driver.submit('84a3'), txid(5));
    });
});

describe('Cardano: the Blockfrost driver (API-656)', () => {
    function blockfrost(routes) {
        const calls = [];
        const fetch = async (url, init) => {
            const path = url.replace('https://cardano-preview.blockfrost.io/api/v0', '');
            calls.push({ path, init });
            const r = routes[path.split('?')[0]] ?? routes[init.method] ?? [404, { message: 'Not found' }];
            if (r instanceof Error) throw r;
            return reply(r[0], r[1]);
        };
        return { driver: createBlockfrostDriver({ network: 'preview', projectId: 'previewSECRET', fetch }), calls };
    }

    it('reads parameters, outputs, transactions and metadata; the key goes in a header only', async () => {
        const { driver, calls } = blockfrost({
            '/epochs/latest/parameters': [200, { min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: '4310', max_tx_size: 16384 }],
            '/addresses/addr_test1x/utxos': [200, [{ tx_hash: txid(1), output_index: 0, amount: [{ unit: 'lovelace', quantity: '9000000' }] }]],
            [`/txs/${txid(1)}`]: [200, { hash: txid(1), block_height: 3000000 }],
            [`/txs/${txid(1)}/metadata`]: [200, [{ label: '8890', json_metadata: { v: 1, root: root() } }]],
            '/blocks/latest': [200, { height: 3000009, slot: 99000000 }],
            POST: [200, txid(1)]
        });
        assert.deepEqual(await driver.parameters(), PARAMS);
        assert.deepEqual(await driver.utxos('addr_test1x'), [{ txHash: txid(1), index: 0, lovelace: '9000000', assets: false }]);
        assert.deepEqual(await driver.output(txid(1), 0), { onChain: true, blockHeight: 3000000 });
        assert.deepEqual(await driver.output(txid(9), 0), { onChain: false, blockHeight: null });     // 404: not yet
        assert.deepEqual((await driver.metadata(txid(1)))['8890'], { v: 1, root: root() });
        assert.equal(await driver.tipHeight(), 3000009);
        assert.equal(await driver.tipSlot(), 99000000);
        assert.equal(await driver.submit('84a3'), txid(1));
        const submit = calls.find(c => c.init.method === 'POST');
        assert.equal(submit.init.headers['Content-Type'], 'application/cbor');
        assert.deepEqual([...submit.init.body], [0x84, 0xa3]);
        assert.ok(calls.every(c => c.init.headers.project_id === 'previewSECRET' && !c.path.includes('SECRET')));
    });

    it('an unused address has no outputs (404); refused, wrong key, rate limit and outage', async () => {
        assert.deepEqual(await blockfrost({}).driver.utxos('addr_test1new'), []);
        await assert.rejects(blockfrost({ POST: [400, { message: 'BadInputsUTxO' }] }).driver.submit('84'), e => e.code === 'EREJECTED' && /BadInputs/.test(e.message));
        await assert.rejects(blockfrost({ '/blocks/latest': [403, { message: 'Invalid project token.' }] }).driver.tipHeight(), e => e.code === 'ECONFIG' && /preview key/.test(e.message) && !/SECRET/.test(e.message));
        await assert.rejects(blockfrost({ '/blocks/latest': [429, { message: 'Usage limit' }] }).driver.tipHeight(), e => e.code === 'EUNAVAILABLE');
        await assert.rejects(blockfrost({ '/blocks/latest': new TypeError('fetch failed') }).driver.tipHeight(), e => e.code === 'EUNAVAILABLE' && e.retryable);
    });

    it('the project key is read from its file, which only the service\'s user may read', () => {
        const dir = mkdtempSync(join(tmpdir(), 'bf-'));
        writeFileSync(join(dir, 'key'), 'previewFROMFILE\n', { mode: 0o600 });
        assert.equal(createBlockfrostDriver({ projectIdFile: join(dir, 'key'), fetch: async () => reply(200, {}) }).name, 'blockfrost');
        writeFileSync(join(dir, 'open'), 'previewOPEN\n', { mode: 0o644 });
        assert.throws(() => createBlockfrostDriver({ projectIdFile: join(dir, 'open') }), e => e.code === 'ECONFIG' && /chmod 600/.test(e.message) && !/OPEN/.test(e.message));
    });
});

describe('Cardano: the wallet key in OpenBao (API-656)', () => {
    it('logs in with its AppRole, reads the ed25519 public key, has the hash signed (vault:v1:…)', async () => {
        const local = createLocalSigner();
        const pub = await local.publicKey();
        const dir = mkdtempSync(join(tmpdir(), 'bao-'));
        writeFileSync(join(dir, 'secret'), 'the-secret-id\n');
        const calls = [];
        const fetch = async (url, init) => {
            const path = url.replace('http://127.0.0.1:8200/v1/', '');
            calls.push({ path, token: init.headers['X-Vault-Token'], body: init.body && JSON.parse(init.body) });
            if (path === 'auth/approle/login') return reply(200, { auth: { client_token: 't1', lease_duration: 3600 } });
            if (path === 'transit/keys/audit-anchor') return reply(200, { data: { type: 'ed25519', latest_version: 1, keys: { 1: { public_key: pub.toString('base64') } } } });
            if (path === 'transit/sign/audit-anchor') {
                const sig = await local.sign(Buffer.from(JSON.parse(init.body).input, 'base64'));
                return reply(200, { data: { signature: `vault:v1:${sig.toString('base64')}` } });
            }
            return reply(404, {});
        };
        const signer = createTransitSigner({ addr: 'http://127.0.0.1:8200', roleId: 'role', secretIdFile: join(dir, 'secret'), fetch });
        assert.deepEqual(await signer.publicKey(), pub);
        const hash = createHash('sha256').update('body').digest();
        const sig = await signer.sign(hash);
        assert.ok(edVerify(null, hash, local.nodePublicKey, sig));
        assert.deepEqual(calls[0].body, { role_id: 'role', secret_id: 'the-secret-id' });
        assert.ok(calls.slice(1).every(c => c.token === 't1'));
    });

    it('a key of the wrong type or OpenBao unreachable is reported', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'bao-'));
        writeFileSync(join(dir, 'secret'), 's');
        const wrong = createTransitSigner({
            addr: 'http://b', roleId: 'r', secretIdFile: join(dir, 'secret'),
            fetch: async (url) => (url.endsWith('login') ? reply(200, { auth: { client_token: 't', lease_duration: 60 } }) : reply(200, { data: { type: 'aes256-gcm96' } }))
        });
        await assert.rejects(wrong.publicKey(), e => e.code === 'ECONFIG' && /not ed25519/.test(e.message));
        const down = createTransitSigner({ addr: 'http://b', roleId: 'r', secretIdFile: join(dir, 'secret'), fetch: async () => { throw new TypeError('fetch failed'); } });
        await assert.rejects(down.sign(Buffer.alloc(32)), e => e.code === 'ESIGN' && e.retryable);
        const refused = createTransitSigner({ addr: 'http://b', roleId: 'r', secretIdFile: join(dir, 'secret'), fetch: async () => reply(400, { errors: ['invalid role or secret ID'] }) });
        await assert.rejects(refused.publicKey(), e => e.code === 'ECONFIG' && !e.retryable && /BAO_ROLE_ID/.test(e.message));
        const noFile = createTransitSigner({ addr: 'http://b', roleId: 'r', secretIdFile: join(dir, 'missing') });
        await assert.rejects(noFile.publicKey(), e => e.code === 'ECONFIG' && /ENOENT/.test(e.message));
        assert.throws(() => createBlockfrostDriver({ projectIdFile: join(dir, 'missing-key') }), e => e.code === 'ECONFIG' && /ENOENT/.test(e.message));
    });
});

