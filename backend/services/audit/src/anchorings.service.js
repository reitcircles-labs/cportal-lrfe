import { NotFoundError } from '@lrfe/common';
import { nextAnchoring } from './anchor.service.js';

/** The filters of the Anchorings list (API-671): every batch, those on their way, those that failed. */
export const ANCHOR_FILTERS = ['all', 'progress', 'failed'];

const IN_PROGRESS = ['prepared', 'submitted', 'onChain'];
const NOT_FAILED = ['prepared', 'submitted', 'onChain', 'confirmed'];
const FILTER_STATUSES = { all: null, progress: IN_PROGRESS, failed: ['failed'] };

/** Where anyone can read a transaction, per network. The only place the screens get the network from. */
const EXPLORERS = {
    mainnet: 'https://cardanoscan.io/transaction/',
    preprod: 'https://preprod.cardanoscan.io/transaction/',
    preview: 'https://preview.cardanoscan.io/transaction/'
};

/** The transaction's page on a public blockchain explorer, or null for an unknown network. */
export function explorerUrl(network, txHash) {
    return EXPLORERS[network] && txHash ? EXPLORERS[network] + txHash : null;
}

/** The status the screens show: a prepared transaction is already on its way. */
function publicStatus(status) {
    return status === 'prepared' || status === 'submitted' ? 'sent' : status;
}

/**
 * Why an anchoring failed, as a code the screens put into words. The stored error is internal (it
 * can name the provider); rows from before the reason was stored are read from it, as the sync()
 * upgrade of the sequelize repo does once (the memory repo has no upgrade).
 */
export function reasonOf(a) {
    if (a.status !== 'failed') return null;
    if (a.reason) return a.reason;
    if (a.error?.startsWith('rolled back, and expired')) return 'rolledBackExpired';
    if (a.error?.startsWith('expired')) return 'expired';
    return 'refused';
}

/**
 * The Anchorings screens (API-671, design API-688): every batch the portal has put on the
 * blockchain, newest first, and one batch in detail. Seen by every signed-in user (`anchors.view`):
 * a batch holds only fingerprints (README.md section 7), in a transaction anyone can read on the
 * blockchain (section 3).
 *
 * A failed batch never reached the blockchain; the next batch replaced it and covers its
 * fingerprints. What a batch covers is counted from the last batch before it that did not fail.
 *
 * `config`: { periodMs, retryMs, confirmations } of the anchoring job; `anchoring`: false when no
 * blockchain is configured (no next batch is due then).
 */
export class AnchoringsService {
    constructor({ repo, tree, clock = () => new Date(), anchoring = true, config = {} }) {
        this.repo = repo;
        this.tree = tree;
        this.clock = clock;
        this.anchoring = anchoring;
        this.config = { periodMs: 3_600_000, retryMs: 5 * 60_000, confirmations: 10, ...config };
    }

    async list({ status = 'all', limit = 25, offset = 0 } = {}) {
        const [rows, byStatus] = await Promise.all([
            this.repo.listAnchors({ statuses: FILTER_STATUSES[status], limit, offset }),
            this.repo.countAnchors()
        ]);
        const sum = (statuses) => statuses.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
        const counts = { all: sum([...NOT_FAILED, 'failed']), progress: sum(IN_PROGRESS), failed: byStatus.failed ?? 0 };
        const neighbours = new Map(rows.map(a => [a.batch, a]));
        return {
            items: await Promise.all(rows.map(a => this.row(a, neighbours))),
            total: counts[status],
            counts,
            confirmationsNeeded: this.config.confirmations,
            next: await this.next()
        };
    }

    async detail(batch) {
        const a = await this.repo.anchorByBatch(batch);
        if (!a) throw new NotFoundError(`There is no batch ${batch}`);
        const neighbours = new Map([[a.batch, a]]);
        const [row, before, previous, next] = await Promise.all([
            this.row(a, neighbours),
            a.prevRoot ? this.repo.anchorBefore(a.batch, NOT_FAILED) : null,
            this.neighbour(a.batch - 1, neighbours),
            this.neighbour(a.batch + 1, neighbours)
        ]);
        const replacement = row.replacedBy ? await neighbours.get(row.replacedBy) : null;
        return {
            ...row,
            root: a.root,
            size: a.size,
            prev: a.prevRoot ? { root: a.prevRoot, batch: before?.root === a.prevRoot ? before.batch : null } : null,
            steps: {
                createdAt: a.createdAt,
                sentAt: a.submittedAt ?? null,
                sends: a.attempts ?? 0,
                onChainAt: a.onChainAt ?? null,
                confirmedAt: a.confirmedAt ?? null,
                failedAt: a.failedAt ?? null
            },
            replacement: replacement ? { batch: replacement.batch, status: publicStatus(replacement.status), createdAt: replacement.createdAt } : null,
            previousBatch: previous?.batch ?? null,
            nextBatch: next?.batch ?? null,
            confirmationsNeeded: this.config.confirmations
        };
    }

    /**
     * When the next batch is due and how many fingerprints wait for it, by the job's own rule. `dueAt`
     * is the earliest time: never in the past, and with nothing waiting (`waiting: 0`, no new trail
     * entries) or a batch still in flight, the job waits longer.
     */
    async next() {
        if (!this.anchoring) return null;
        const [last, covered, size] = await Promise.all([
            this.repo.lastAnchor(),
            this.repo.lastAnchorWhere(NOT_FAILED),
            this.tree.size()
        ]);
        const now = this.clock();
        const { at } = nextAnchoring(last, covered, this.config);
        const dueAt = at && at > now ? at : now;
        return { dueAt, waiting: Math.max(0, size - (covered?.size ?? 0)) };
    }

    /** One batch as the list shows it. `neighbours`: batches already read, by number (filled in). */
    async row(a, neighbours) {
        const failed = a.status === 'failed';
        const onChain = a.status === 'onChain' || a.status === 'confirmed';
        let base = null, after = null, before = null;
        if (failed) {
            after = await this.neighbour(a.batch + 1, neighbours);           // its replacement
        } else {
            [base, before] = await Promise.all([this.repo.anchorBefore(a.batch, NOT_FAILED), this.neighbour(a.batch - 1, neighbours)]);
        }
        let confirmations = null;
        if (a.status === 'confirmed') confirmations = Math.max(a.confirmations ?? 0, this.config.confirmations);
        else if (a.status === 'onChain') confirmations = a.confirmations ?? null;
        return {
            batch: a.batch,
            createdAt: a.createdAt,
            status: publicStatus(a.status),
            covers: failed ? null : a.size - (base?.size ?? 0),
            txHash: failed ? null : a.txHash ?? null,
            explorerUrl: failed ? null : explorerUrl(a.network, a.txHash),
            block: onChain ? a.blockHeight ?? a.firstSeenHeight ?? null : null,
            confirmations,
            reason: reasonOf(a),
            replacedBy: after?.batch ?? null,
            replaces: before?.status === 'failed' ? before.batch : null
        };
    }

    /** Batch `n`, read once per request (the promise is kept, so reads at the same time share it). */
    neighbour(n, neighbours) {
        if (n < 1) return null;
        if (!neighbours.has(n)) neighbours.set(n, this.repo.anchorByBatch(n));
        return neighbours.get(n);
    }
}
