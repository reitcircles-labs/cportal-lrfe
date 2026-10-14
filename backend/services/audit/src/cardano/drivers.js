import { readFileSync, statSync } from 'node:fs';
import { CardanoError } from './tx.js';

/**
 * Chain access (README.md section 3): one interface, two drivers.
 *
 *   parameters()          { minFeeA, minFeeB, coinsPerUtxoByte, maxTxSize }
 *   utxos(address)        [{ txHash, index, lovelace, assets }]   (assets: true when it holds other tokens)
 *   submit(cbor)          the transaction id
 *   output(txHash, index) { onChain, blockHeight }   (blockHeight: Blockfrost only; Ogmios answers null)
 *   tipHeight()           the chain's block height
 *   tipSlot()             the chain's current slot (a transaction's validity ends at a slot)
 *   synced()              whether the provider is at the chain's tip
 *   metadata(txHash)      the transaction's metadata by label (Blockfrost only: Ogmios has no index of
 *                         past transactions; the offline verifier reads it from a public source)
 *
 * Errors are CardanoError: EUNAVAILABLE (unreachable, slow, failing: retry later), EREJECTED (the
 * chain refused the transaction), ECONFIG (a wrong key or address).
 */

const lovelaceOf = (value) => String(value?.ada?.lovelace ?? 0);

/** The portal's own node, through Ogmios (JSON-RPC over HTTP, 127.0.0.1 only: API-662). */
export function createOgmiosDriver({ url = 'http://127.0.0.1:1337', fetch: fetchFn = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    const base = url.replace(/\/+$/, '');
    let id = 0;
    async function rpc(method, params = {}) {
        let res, json;
        try {
            res = await fetchFn(base, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }), signal: AbortSignal.timeout(timeoutMs)
            });
            json = await res.json();
        } catch (err) {
            throw new CardanoError(`The Cardano node (Ogmios at ${base}) is unreachable: ${err.message}`, 'EUNAVAILABLE', { cause: err });
        }
        if (json.error) {
            const { code, message, data } = json.error;
            // 3000-3999: the ledger refused the transaction; -32602: it is not a valid transaction
            if (method === 'submitTransaction' && ((code >= 3000 && code < 4000) || code === -32602)) {
                throw new CardanoError(`The chain refused the transaction: ${message}`, 'EREJECTED', { details: { code, data } });
            }
            throw new CardanoError(`The Cardano node (Ogmios) failed ${method}: ${message}`, 'EUNAVAILABLE', { details: { code } });
        }
        return json.result;
    }
    return {
        name: 'ogmios',
        async parameters() {
            const p = await rpc('queryLedgerState/protocolParameters');
            return { minFeeA: p.minFeeCoefficient, minFeeB: p.minFeeConstant.ada.lovelace, coinsPerUtxoByte: p.minUtxoDepositCoefficient, maxTxSize: p.maxTransactionSize.bytes };
        },
        async utxos(address) {
            return (await rpc('queryLedgerState/utxo', { addresses: [address] })).map(u => ({
                txHash: u.transaction.id, index: u.index, lovelace: lovelaceOf(u.value), assets: Object.keys(u.value || {}).some(k => k !== 'ada')
            }));
        },
        async submit(cbor) { return (await rpc('submitTransaction', { transaction: { cbor } })).transaction.id; },
        // whether the output is still unspent: right for the one anchoring in flight (README.md section 3);
        // once the next anchoring spends it, an older one reads as not on chain
        async output(txHash, index) {
            const found = await rpc('queryLedgerState/utxo', { outputReferences: [{ transaction: { id: txHash }, index }] });
            return { onChain: found.length > 0, blockHeight: null };
        },
        async tipHeight() { return rpc('queryNetwork/blockHeight'); },
        async tipSlot() { return (await rpc('queryNetwork/tip')).slot; },
        async synced() {
            try {
                const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
                return ((await res.json()).networkSynchronization ?? 0) >= 0.9999;
            } catch (err) {
                throw new CardanoError(`The Cardano node (Ogmios at ${base}) is unreachable: ${err.message}`, 'EUNAVAILABLE', { cause: err });
            }
        },
        metadata: null
    };
}

const BLOCKFROST = { preview: 'https://cardano-preview.blockfrost.io/api/v0', preprod: 'https://cardano-preprod.blockfrost.io/api/v0', mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0' };

/**
 * Blockfrost: a project key (a secret, read from a file only the service's user can read; never on
 * screen or in logs). The key is for one network.
 */
export function createBlockfrostDriver({ network = 'preview', projectId, projectIdFile, url, fetch: fetchFn = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    const mode = projectIdFile ? (() => {
        try { return statSync(projectIdFile).mode; } catch (err) { throw new CardanoError(`The Blockfrost key file cannot be read (${err.code}): ${projectIdFile}`, 'ECONFIG'); }
    })() : 0;
    if (projectIdFile && (mode & 0o077)) {
        // like ssh with a private key: a secret others can read is refused, not used
        throw new CardanoError(`${projectIdFile} can be read by other users: chmod 600 it (only the service's user may read the Blockfrost key)`, 'ECONFIG');
    }
    const key = projectId ?? (projectIdFile ? readFileSync(projectIdFile, 'utf8').trim() : null);
    if (!key) throw new CardanoError('Blockfrost needs a project key: BLOCKFROST_PROJECT_ID_FILE', 'ECONFIG');
    const base = (url || BLOCKFROST[network] || '').replace(/\/+$/, '');
    if (!base) throw new CardanoError(`No Blockfrost address for network "${network}"`, 'ECONFIG');

    async function call(path, { method = 'GET', body, notFound } = {}) {
        let res;
        try {
            res = await fetchFn(`${base}${path}`, {
                method, headers: { project_id: key, ...(body ? { 'Content-Type': 'application/cbor' } : {}) },
                ...(body ? { body } : {}), signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (err) {
            throw new CardanoError(`Blockfrost is unreachable: ${err.message}`, 'EUNAVAILABLE', { cause: err });
        }
        if (res.status === 404 && notFound !== undefined) return notFound;
        const json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const detail = json.message || json.error || `HTTP ${res.status}`;
        if (res.status === 400 && method === 'POST') throw new CardanoError(`The chain refused the transaction: ${detail}`, 'EREJECTED', { details: { status: 400 } });
        if (res.status === 401 || res.status === 403) throw new CardanoError(`Blockfrost refused the project key (${res.status}): check it is a ${network} key`, 'ECONFIG');
        throw new CardanoError(`Blockfrost failed ${path.split('/')[1]}: ${detail}`, 'EUNAVAILABLE', { details: { status: res.status } });
    }
    return {
        name: 'blockfrost',
        async parameters() {
            const p = await call('/epochs/latest/parameters');
            return { minFeeA: Number(p.min_fee_a), minFeeB: Number(p.min_fee_b), coinsPerUtxoByte: Number(p.coins_per_utxo_size ?? p.coins_per_utxo_word), maxTxSize: Number(p.max_tx_size) };
        },
        async utxos(address) {
            const out = [];
            for (let page = 1; ; page++) {
                const rows = await call(`/addresses/${address}/utxos?page=${page}`, { notFound: [] });
                out.push(...rows.map(u => ({
                    txHash: u.tx_hash, index: u.output_index,
                    lovelace: u.amount.find(a => a.unit === 'lovelace')?.quantity ?? '0', assets: u.amount.some(a => a.unit !== 'lovelace')
                })));
                if (rows.length < 100) return out;
            }
        },
        async submit(cbor) { return call('/tx/submit', { method: 'POST', body: Buffer.from(cbor, 'hex') }); },
        async output(txHash) {
            const tx = await call(`/txs/${txHash}`, { notFound: null });
            return tx ? { onChain: true, blockHeight: tx.block_height } : { onChain: false, blockHeight: null };
        },
        async tipHeight() { return (await call('/blocks/latest')).height; },
        async tipSlot() { return (await call('/blocks/latest')).slot; },
        async synced() { return true; },
        async metadata(txHash) {
            const rows = await call(`/txs/${txHash}/metadata`, { notFound: null });
            return rows && Object.fromEntries(rows.map(r => [r.label, r.json_metadata]));
        }
    };
}
