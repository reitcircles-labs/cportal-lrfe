import { anchorMetadata, addressOf, buildAnchorTx, CardanoError, LABEL, lovelaceToAda } from './tx.js';
import { createBlockfrostDriver, createOgmiosDriver } from './drivers.js';
import { createLocalSigner, createTransitSigner } from './signer.js';
import { createTestChainDriver } from './test-chain.js';

/**
 * Putting a root on Cardano and finding it again (README.md section 3), through the portal's own
 * node (Ogmios) or Blockfrost, with the wallet's key in OpenBao.
 *
 *   address()                        the anchoring wallet's address
 *   balance()                        { lovelace, ada, low }; low also logs a warning and publishes audit.wallet.low
 *   funds()                          the same, without the warning (the health panel reads it often)
 *   synced()                         whether the node or provider is at the chain's tip
 *   prepare({ root, size, batch, prev, spend })  build and sign: { txHash, cbor, fee, bytes, metadata, ttl, input }
 *                                    (valid for `ttlSlots`, an hour: from slot `ttl` on it can never land;
 *                                    `spend`: { txHash, index } of the output it must spend)
 *   submit(cbor)                     send it; sending the same transaction again is harmless
 *   anchor({ root, size, batch, prev })  both: { txHash, fee, bytes, metadata, submittedAt }
 *   status(txHash)                   { onChain, blockHeight, tipHeight, tipSlot, depth }
 *   tipHeight()                      the chain's block height
 *   lookup(txHash)                   the anchoring metadata on chain (Blockfrost), or undefined (Ogmios)
 *
 * A failure is a CardanoError; `retryable` says whether trying again later can help (an outage, a
 * node still syncing, OpenBao unreachable) or not (refused, no funds, a wrong setting).
 */
export function createCardanoAdapter({ driver, signer, network = 'preview', minBalanceAda = 5, ttlSlots = 3600, logger = console, events = null }) {
    let address = null;
    const self = {
        network,
        provider: driver.name,
        async address() {
            address ??= addressOf(await signer.publicKey(), network);
            return address;
        },

        async funds() {
            const utxos = await driver.utxos(await self.address());
            const lovelace = utxos.reduce((sum, u) => sum + BigInt(u.lovelace), 0n);
            return { lovelace: String(lovelace), ada: lovelaceToAda(lovelace), low: Number(lovelace) / 1e6 < minBalanceAda, minimumAda: minBalanceAda };
        },

        async synced() { return driver.synced(); },

        async balance() {
            const { lovelace, ada, low } = await self.funds();
            if (low) {
                logger.warn?.({ address, ada, minimum: minBalanceAda }, 'audit: the anchoring wallet is low on funds');
                await events?.publish('audit.wallet.low', { network, address, ada, minimum: minBalanceAda }, { durable: false })?.catch?.(() => {});
            }
            return { lovelace, ada, low };
        },

        async prepare({ root, size, batch, prev, spend }) {
            const metadata = anchorMetadata({ root, size, batch, prev });
            if (!(await driver.synced())) throw new CardanoError(`The Cardano node is still catching up with the chain: anchoring waits until it is in sync`, 'EUNAVAILABLE');
            const [params, utxos, publicKey, slot] = await Promise.all([driver.parameters(), driver.utxos(await self.address()), signer.publicKey(), driver.tipSlot()]);
            const ttl = slot + ttlSlots;
            const tx = buildAnchorTx({ utxos, address, publicKey, params, metadata, ttl, input: spend });
            const signed = tx.sign(await signer.sign(tx.bodyHash));
            return { txHash: signed.txHash, cbor: signed.cbor, fee: String(tx.fee), bytes: signed.bytes, metadata, label: LABEL, ttl, input: { txHash: tx.input.txHash, index: tx.input.index } };
        },

        async submit(cbor, txHash) {
            const submitted = await driver.submit(cbor);
            if (txHash && submitted && submitted !== txHash) logger.warn?.({ submitted, built: txHash }, 'audit: the provider reported another transaction id');
            return submitted;
        },

        async anchor(batch) {
            const prepared = await self.prepare(batch);
            await self.submit(prepared.cbor, prepared.txHash);
            return { ...prepared, submittedAt: new Date().toISOString() };
        },

        async status(txHash) {
            const [out, tipHeight, tipSlot] = await Promise.all([driver.output(txHash, 0), driver.tipHeight(), driver.tipSlot()]);
            return { ...out, tipHeight, tipSlot, depth: out.blockHeight ? tipHeight - out.blockHeight + 1 : null };
        },

        async tipHeight() { return driver.tipHeight(); },

        async lookup(txHash) {
            if (!driver.metadata) return undefined;
            return (await driver.metadata(txHash))?.[String(LABEL)] ?? null;
        }
    };
    return self;
}

/** The adapter as the settings say (README.md section 10), or null when anchoring is off (no CARDANO_PROVIDER). */
export function cardanoFromEnv(env, { logger, events, fetch } = {}) {
    const provider = (env.CARDANO_PROVIDER || '').toLowerCase();
    if (!provider) return null;
    if (provider === 'test') return testChainAdapter(env, { logger, events });
    const network = (env.CARDANO_NETWORK || 'preview').toLowerCase();
    if (network === 'mainnet') throw new CardanoError('CARDANO_NETWORK=mainnet is not enabled yet (README.md section 9)', 'ECONFIG');
    const driver = provider === 'ogmios' ? createOgmiosDriver({ url: env.OGMIOS_URL, fetch })
        : provider === 'blockfrost' ? createBlockfrostDriver({ network, projectIdFile: env.BLOCKFROST_PROJECT_ID_FILE, fetch })
            : null;
    if (!driver) throw new CardanoError(`CARDANO_PROVIDER must be ogmios or blockfrost, not "${provider}"`, 'ECONFIG');
    const signer = createTransitSigner({ addr: env.BAO_ADDR, roleId: env.BAO_ROLE_ID, secretIdFile: env.BAO_SECRET_ID_FILE, keyName: env.ANCHOR_BAO_KEY || 'audit-anchor', fetch });
    return createCardanoAdapter({ driver, signer, network, minBalanceAda: Number(env.ANCHOR_MIN_BALANCE_ADA ?? 5), logger, events });
}

/**
 * The end-to-end test stack's blockchain (CARDANO_PROVIDER=test): the in-memory chain of the unit
 * tests and a key held in memory, on "preview". Refused unless NODE_ENV=test, so it can never stand
 * in for a real blockchain. `testDriver` lets the test-only routes act on the chain.
 */
function testChainAdapter(env, { logger, events }) {
    if (env.NODE_ENV !== 'test') throw new CardanoError('CARDANO_PROVIDER=test is only for the end-to-end tests (NODE_ENV=test)', 'ECONFIG');
    const driver = createTestChainDriver();
    const adapter = createCardanoAdapter({ driver, signer: createLocalSigner(), network: 'preview', logger, events });
    adapter.testDriver = driver;
    return adapter;
}
