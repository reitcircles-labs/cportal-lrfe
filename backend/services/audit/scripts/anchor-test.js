#!/usr/bin/env node
/**
 * The anchoring wallet and one test anchoring on the test network (API-656), with the audit
 * service's own settings (services/audit/.env, or this shell):
 *
 *   npm run anchor:test -w @lrfe/audit                  the provider, the wallet's address and balance
 *   npm run anchor:test -w @lrfe/audit -- --submit      anchor a random test root, follow it until it
 *                                                       is ANCHOR_CONFIRMATIONS blocks deep, read it back
 *
 * Needs CARDANO_PROVIDER (ogmios or blockfrost) and the OpenBao settings (BAO_ADDR, BAO_ROLE_ID,
 * BAO_SECRET_ID_FILE); see install.md step 4b. Fund the address from the preview faucet first.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { cardanoFromEnv } from '../src/cardano/adapter.js';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const env = { ...(existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {}), ...process.env };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const quiet = { warn: (o, m) => console.log(`  warning: ${m}`) };

/** Try again while the failure is one that waiting can fix (an outage, a node still syncing). */
async function retrying(what, fn, attempts = 10) {
    for (let i = 1; ; i++) {
        try { return await fn(); } catch (err) {
            if (!err.retryable || i >= attempts) throw err;
            console.log(`  ${what}: ${err.message}; trying again in 30 s (${i}/${attempts})`);
            await sleep(30_000);
        }
    }
}

try {
    const cardano = cardanoFromEnv(env, { logger: quiet });
    if (!cardano) throw new Error('CARDANO_PROVIDER is not set: anchoring is off (install.md step 4b)');
    const address = await cardano.address();
    console.log(`Cardano ${cardano.network} through ${cardano.provider}`);
    console.log(`  wallet:  ${address}`);
    const balance = await retrying('balance', () => cardano.balance());
    console.log(`  balance: ${balance.ada} ADA`);

    if (process.argv.includes('--submit')) {
        const confirmations = Number(env.ANCHOR_CONFIRMATIONS || 10);
        const root = randomBytes(32).toString('hex');
        const r = await retrying('anchoring', () => cardano.anchor({ root, size: 0, batch: 0 }));
        const started = Date.now();
        console.log(`\nSubmitted ${r.txHash}\n  ${r.bytes} bytes, fee ${r.fee} lovelace (${Number(r.fee) / 1e6} ADA), test root ${root}`);
        let firstSeen = null;
        for (;;) {
            await sleep(20_000);
            const s = await retrying('status', () => cardano.status(r.txHash));
            if (s.onChain) firstSeen ??= s.blockHeight ?? s.tipHeight;     // Ogmios: the height it was first seen at
            const depth = s.onChain ? s.tipHeight - (s.blockHeight ?? firstSeen) + 1 : 0;
            console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${s.onChain ? `on chain, ${depth} block(s) deep` : 'not on chain yet'}`);
            if (depth >= confirmations) break;
        }
        const found = await cardano.lookup(r.txHash);
        if (found === undefined) console.log(`Confirmed. Ogmios has no index of past transactions: the metadata can be read from a public source (e.g. https://preview.cardanoscan.io/transaction/${r.txHash}).`);
        else if (found?.root === root) console.log(`Confirmed, and read back from the chain: root ${found.root} under label 8890.`);
        else { console.log('Confirmed, but the metadata read back does not match:', found); process.exitCode = 1; }
    }
} catch (err) {
    console.error(`Could not: ${err.message}${err.code ? ` (${err.code})` : ''}`);
    process.exitCode = 1;
}
