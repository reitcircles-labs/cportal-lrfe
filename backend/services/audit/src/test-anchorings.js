import { createHash } from 'node:crypto';
import { testChainKoiosAnswer } from './cardano/test-chain.js';

const NOT_FAILED = ['prepared', 'submitted', 'onChain', 'confirmed'];

/** Blocks on top of a test batch: as many as a confirmation needs. */
const CONFIRMATIONS = 10;

/**
 * Anchorings for the end-to-end tests (API-698, API-672): the test stack runs no anchoring job, so
 * the tests make batches when they need them. `anchor('confirmed')` makes a confirmed batch of
 * everything sealed so far, as the job would (a trail checkpoint, the tree's root, prev from the last
 * batch that did not fail). With the test blockchain (CARDANO_PROVIDER=test) it is a real signed
 * transaction on that chain, so its proofs verify, in the portal and with the offline verifier;
 * without it the transaction id is made up. `anchor('failed')` makes a batch that expired, which the
 * next one replaces.
 *
 * Only with AUDIT_TEST_ANCHORINGS=true, NODE_ENV=test and no blockchain but the test one (index.js
 * refuses to start otherwise): never on a system that anchors for real.
 */
export class TestAnchorings {
    constructor({ repo, tree, cardano = null, clock = () => new Date() }) {
        this.repo = repo;
        this.tree = tree;
        this.cardano = cardano;
        this.clock = clock;
    }

    async anchor(outcome) {
        const [last, covered, head] = await Promise.all([this.repo.lastAnchor(), this.repo.lastAnchorWhere(NOT_FAILED), this.repo.head()]);
        if (head && head.seq > (covered?.checkpointSeq ?? 0)) await this.tree.checkpoint({ seq: head.seq, hash: head.hash });
        const { root, size } = await this.tree.root();
        const batch = (last?.batch ?? 0) + 1;
        const now = this.clock();
        const row = {
            batch, root, size, prevRoot: covered?.root ?? null, checkpointSeq: head?.seq ?? null, network: 'preview',
            txHash: createHash('sha256').update(`test-anchoring:${batch}:${root}`).digest('hex'),
            attempts: 1, createdAt: now, submittedAt: now
        };
        if (outcome === 'failed') {
            Object.assign(row, { status: 'failed', reason: 'expired', error: 'expired before it reached the chain', failedAt: now });
        } else {
            Object.assign(row, { status: 'confirmed', blockHeight: 1000 + batch, firstSeenHeight: 1000 + batch, confirmations: CONFIRMATIONS, onChainAt: now, confirmedAt: now });
            if (this.cardano) Object.assign(row, await this.onTestChain({ root, size, batch, prev: covered?.root ?? null }));
        }
        await this.repo.createAnchor(row);
        return { batch, status: row.status, size };
    }

    /** The batch as a signed transaction on the test blockchain, in a block with enough blocks on top to be confirmed. */
    async onTestChain({ root, size, batch, prev }) {
        const prepared = await this.cardano.prepare({ root, size, batch, prev });
        await this.cardano.submit(prepared.cbor, prepared.txHash);
        const chain = this.cardano.testDriver.chain;
        const block = chain.blocks.find(b => b.id === prepared.txHash);
        chain.height += CONFIRMATIONS;
        chain.slot += CONFIRMATIONS * 20;
        return {
            txHash: prepared.txHash, cbor: prepared.cbor, ttl: prepared.ttl, fee: prepared.fee, bytes: prepared.bytes,
            inputTxHash: prepared.input.txHash, inputIndex: prepared.input.index,
            blockHeight: block.height, firstSeenHeight: block.height
        };
    }

    /** What a public blockchain API answers about the test chain, for the offline verifier (null without the test chain). */
    publicAnswer(path, txHashes) {
        return this.cardano ? testChainKoiosAnswer(this.cardano.testDriver, path, txHashes) : null;
    }
}
