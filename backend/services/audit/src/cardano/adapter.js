import { anchorMetadata, addressOf, buildAnchorTx, CardanoError, LABEL, lovelaceToAda } from './tx.js';
import { createBlockfrostDriver, createOgmiosDriver } from './drivers.js';
import { createTransitSigner } from './signer.js';

/**
 * Putting a root on Cardano and finding it again (README.md section 3), through the portal's own
 * node (Ogmios) or Blockfrost, with the wallet's key in OpenBao.
 *
 *   address()                        the anchoring wallet's address
 *   balance()                        { lovelace, ada, low }; low also logs a warning and publishes audit.wallet.low
 *   anchor({ root, size, batch, prev })  build, sign, submit: { txHash, fee, bytes, metadata, submittedAt }
 *   status(txHash)                   { onChain, blockHeight, tipHeight, depth }
 *   lookup(txHash)                   the anchoring metadata on chain (Blockfrost), or undefined (Ogmios)
 *
 * A failure is a CardanoError; `retryable` says whether trying again later can help (an outage, a
 * node still syncing, OpenBao unreachable) or not (refused, no funds, a wrong setting).
 */
export function createCardanoAdapter({ driver, signer, network = 'preview', minBalanceAda = 5, logger = console, events = null }) {
    let address = null;
    const self = {
        network,
        provider: driver.name,
        async address() {
            address ??= addressOf(await signer.publicKey(), network);
            return address;
        },

        async balance() {
            const utxos = await driver.utxos(await self.address());
            const lovelace = utxos.reduce((sum, u) => sum + BigInt(u.lovelace), 0n);
            const ada = lovelaceToAda(lovelace);
            const low = Number(lovelace) / 1e6 < minBalanceAda;
            if (low) {
                logger.warn?.({ address, ada, minimum: minBalanceAda }, 'audit: the anchoring wallet is low on funds');
                await events?.publish('audit.wallet.low', { network, address, ada, minimum: minBalanceAda }, { durable: false })?.catch?.(() => {});
            }
            return { lovelace: String(lovelace), ada, low };
        },

        async anchor({ root, size, batch, prev }) {
            const metadata = anchorMetadata({ root, size, batch, prev });
            if (!(await driver.synced())) throw new CardanoError(`The Cardano node is still catching up with the chain: anchoring waits until it is in sync`, 'EUNAVAILABLE');
            const [params, utxos, publicKey] = await Promise.all([driver.parameters(), driver.utxos(await self.address()), signer.publicKey()]);
            const tx = buildAnchorTx({ utxos, address, publicKey, params, metadata });
            const signed = tx.sign(await signer.sign(tx.bodyHash));
            const submitted = await driver.submit(signed.cbor);
            if (submitted && submitted !== signed.txHash) logger.warn?.({ submitted, built: signed.txHash }, 'audit: the provider reported another transaction id');
            return { txHash: signed.txHash, fee: String(tx.fee), bytes: signed.bytes, metadata, label: LABEL, cbor: signed.cbor, submittedAt: new Date().toISOString() };
        },

        async status(txHash) {
            const [out, tipHeight] = await Promise.all([driver.output(txHash, 0), driver.tipHeight()]);
            return { ...out, tipHeight, depth: out.blockHeight ? tipHeight - out.blockHeight + 1 : null };
        },

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
    const network = (env.CARDANO_NETWORK || 'preview').toLowerCase();
    if (network === 'mainnet') throw new CardanoError('CARDANO_NETWORK=mainnet is not enabled yet (README.md section 9)', 'ECONFIG');
    const driver = provider === 'ogmios' ? createOgmiosDriver({ url: env.OGMIOS_URL, fetch })
        : provider === 'blockfrost' ? createBlockfrostDriver({ network, projectIdFile: env.BLOCKFROST_PROJECT_ID_FILE, fetch })
            : null;
    if (!driver) throw new CardanoError(`CARDANO_PROVIDER must be ogmios or blockfrost, not "${provider}"`, 'ECONFIG');
    const signer = createTransitSigner({ addr: env.BAO_ADDR, roleId: env.BAO_ROLE_ID, secretIdFile: env.BAO_SECRET_ID_FILE, keyName: env.ANCHOR_BAO_KEY || 'audit-anchor', fetch });
    return createCardanoAdapter({ driver, signer, network, minBalanceAda: Number(env.ANCHOR_MIN_BALANCE_ADA ?? 5), logger, events });
}
