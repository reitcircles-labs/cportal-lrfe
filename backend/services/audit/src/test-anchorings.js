import { createHash } from 'node:crypto';

const NOT_FAILED = ['prepared', 'submitted', 'onChain', 'confirmed'];

/**
 * Anchorings made up for the end-to-end tests (API-698), with no blockchain: the test stack runs no
 * anchoring job, so the Anchorings screens would have nothing to show. `anchor('confirmed')` writes
 * a confirmed batch of everything sealed so far, as the job would (a trail checkpoint, the tree's
 * root, prev from the last batch that did not fail); `anchor('failed')` a batch that expired, which
 * the next one replaces. The transaction id is made up, so an explorer won't find it.
 *
 * Only with AUDIT_TEST_ANCHORINGS=true, NODE_ENV=test and no CARDANO_PROVIDER (index.js refuses to
 * start otherwise): never on a system that anchors for real.
 */
export class TestAnchorings {
    constructor({ repo, tree, clock = () => new Date() }) {
        this.repo = repo;
        this.tree = tree;
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
            Object.assign(row, { status: 'confirmed', blockHeight: 1000 + batch, firstSeenHeight: 1000 + batch, confirmations: 10, onChainAt: now, confirmedAt: now });
        }
        await this.repo.createAnchor(row);
        return { batch, status: row.status, size };
    }
}
