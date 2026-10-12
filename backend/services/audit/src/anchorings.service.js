import { AppError, NotFoundError } from '@lrfe/common';
import { nextAnchoring } from './anchor.service.js';
import { createServiceClient } from './service-client.js';

/** The filters of the Anchorings list (API-671): every batch, those on their way, those that failed. */
export const ANCHOR_FILTERS = ['all', 'progress', 'failed'];

const IN_PROGRESS = ['prepared', 'submitted', 'onChain'];
const NOT_FAILED = ['prepared', 'submitted', 'onChain', 'confirmed'];
const FILTER_STATUSES = { all: null, progress: IN_PROGRESS, failed: ['failed'] };

/** How many items one lookup in land-records takes (its limit). */
const LOOKUP_CHUNK = 1000;

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

/** The wallet's page on the same explorer: every anchoring it paid for. Null for an unknown network. */
export function addressExplorerUrl(network, address) {
    return EXPLORERS[network] && address ? EXPLORERS[network].replace(/transaction\/$/, 'address/') + address : null;
}

/** By record number; a record land-records no longer knows (no number) last. */
function byRecordNo(x, y) {
    if (x.recordNo === null || y.recordNo === null) return (x.recordNo === null) - (y.recordNo === null);
    return x.recordNo.localeCompare(y.recordNo);
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
 * blockchain is configured (no next batch is due then); `cardano`: the blockchain adapter, for the
 * published wallet address. `sources`: { lookup({ recordIds, versions }) }
 * from land-records, for what a batch covers.
 */
export class AnchoringsService {
    constructor({ repo, tree, sources = null, clock = () => new Date(), anchoring = true, cardano = null, config = {} }) {
        this.repo = repo;
        this.cardano = cardano;
        this.tree = tree;
        this.sources = sources;
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
     * The anchoring wallet the installation publishes, for checking proofs outside the portal (the
     * offline verifier's --address; API-672, API-676): `{ address, explorerUrl, transactionUrl }`:
     * the wallet's explorer page, and the explorer's address for a transaction (its id appended). All
     * null when no blockchain is configured. 503 while the wallet's key cannot be read.
     */
    async wallet() {
        if (!this.cardano) return { address: null, explorerUrl: null, transactionUrl: null };
        let address;
        try {
            address = await this.cardano.address();
        } catch {
            throw new AppError(503, 'The anchoring wallet cannot be read now. Try again in a minute.');
        }
        return { address, explorerUrl: addressExplorerUrl(this.cardano.network, address), transactionUrl: EXPLORERS[this.cardano.network] ?? null };
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

    /**
     * What batch `batch` covers (API-696): the fingerprints it put on the blockchain for the first
     * time, counted by kind, and the land records with a version or an audit sign-off in it, by record
     * number, paged. Each version comes with what its fingerprint stands for: the documents it is
     * made of (how many of them reached the blockchain in earlier batches) and, through the previous
     * version's seal, the versions before it. A failed batch covers nothing: its replacement does.
     */
    async coverage(batch, { limit = 25, offset = 0 } = {}) {
        const c = await this.contents(batch);
        if (!c) {
            const kinds = { recordVersions: 0, documentVersions: 0, signoffs: 0 };
            return { batch, kinds, trailUpTo: null, records: [], total: 0 };
        }
        const inBatch = new Set(c.documents.map(d => `${d.id}:${d.version}`));
        const byRecord = new Map();
        const entryOf = (recordId) => {
            if (!byRecord.has(recordId)) byRecord.set(recordId, { recordId, versions: [], signoffs: [] });
            return byRecord.get(recordId);
        };
        for (const v of c.versions) {
            const madeOf = c.versionDocuments.get(`${v.recordId}:${v.versionNumber}`) ?? [];
            entryOf(v.recordId).versions.push({
                versionNumber: v.versionNumber,
                documents: madeOf.length,
                documentsEarlier: madeOf.filter(d => !inBatch.has(`${d.id}:${d.version}`)).length,
                versionsBefore: v.versionNumber - 1
            });
        }
        for (const e of c.signoffs) {
            const from = e.data.fromVersion ?? e.data.versionNumber, to = e.data.toVersion ?? e.data.versionNumber;
            entryOf(e.data.recordId).signoffs.push({ from, to });
        }
        const records = [...byRecord.values()].map(r => ({ ...r, ...this.labelOf(c, r.recordId) })).sort(byRecordNo);
        return {
            batch,
            kinds: { recordVersions: c.versions.length, documentVersions: c.documents.length, signoffs: c.signoffs.length },
            trailUpTo: c.anchor.checkpointSeq ?? null,
            records: records.slice(offset, offset + limit),
            total: records.length
        };
    }

    /**
     * The document versions batch `batch` put on the blockchain for the first time (API-696), in the
     * order they were sealed, paged: number, type and deed number from their filing in the trail, and
     * the land record versions in the same batch that are made of them. A failed batch has none.
     */
    async documents(batch, { limit = 25, offset = 0 } = {}) {
        const c = await this.contents(batch);
        if (!c) return { batch, items: [], total: 0 };
        const page = c.documents.slice(offset, offset + limit);
        const usedIn = new Map();
        for (const [key, madeOf] of c.versionDocuments) {
            const [recordId, versionNumber] = key.split(':');
            const version = { recordId, versionNumber: Number(versionNumber), ...this.labelOf(c, recordId) };
            for (const d of madeOf) {
                const k = `${d.id}:${d.version}`;
                if (!usedIn.has(k)) usedIn.set(k, []);
                usedIn.get(k).push(version);
            }
        }
        const described = await this.describeDocuments(page);
        const items = page.map((d, i) => ({
            documentId: d.id,
            version: d.version,
            ...described[i],
            usedIn: usedIn.get(`${d.id}:${d.version}`) ?? []
        }));
        return { batch, items, total: c.documents.length };
    }

    /**
     * What a batch holds, read once for both views: its new leaves (versions and documents), the
     * audit sign-offs in the trail up to its checkpoint, and from land-records the labels of the land
     * records and the documents each version is made of. Null for a failed batch.
     */
    async contents(batch) {
        const anchor = await this.repo.anchorByBatch(batch);
        if (!anchor) throw new NotFoundError(`There is no batch ${batch}`);
        if (anchor.status === 'failed') return null;
        const base = await this.repo.anchorBefore(batch, NOT_FAILED);
        const hasCheckpoint = anchor.checkpointSeq !== null && anchor.checkpointSeq !== undefined;
        const [leaves, signoffs] = await Promise.all([
            this.repo.leavesInRange(base?.size ?? 0, anchor.size),
            hasCheckpoint ? this.repo.entriesOfType('audit.signoff.recorded', base?.checkpointSeq ?? 0, anchor.checkpointSeq) : []
        ]);
        const versions = [], documents = [];
        for (const leaf of leaves) {
            const [kind, id, n] = leaf.key.split(':');
            if (kind === 'record-version') versions.push({ recordId: id, versionNumber: Number(n) });
            else if (kind === 'document-version') documents.push({ id, version: Number(n), eventId: leaf.eventId ?? null });
        }
        const recordIds = [...new Set(signoffs.map(e => e.data.recordId))];
        const { labels, versionDocuments } = await this.lookup(recordIds, versions);
        return { anchor, versions, documents, signoffs, labels, versionDocuments };
    }

    /** From land-records, in chunks: labels of the land records, and the documents each version is made of. */
    async lookup(recordIds, versions) {
        const labels = new Map(), versionDocuments = new Map();
        const take = (answer) => {
            for (const r of answer.records) labels.set(r.id, r);
            for (const v of answer.versions) versionDocuments.set(`${v.recordId}:${v.versionNumber}`, v.documents);
        };
        for (let i = 0; i < versions.length; i += LOOKUP_CHUNK) take(await this.sources.lookup({ versions: versions.slice(i, i + LOOKUP_CHUNK) }));
        for (let i = 0; i < recordIds.length; i += LOOKUP_CHUNK) take(await this.sources.lookup({ recordIds: recordIds.slice(i, i + LOOKUP_CHUNK) }));
        return { labels, versionDocuments };
    }

    /** A land record's number and label, as land-records gave them (null when it no longer knows it). */
    labelOf(contents, recordId) {
        const known = contents.labels.get(recordId);
        return { recordNo: known?.recordNo ?? null, label: known?.label ?? null };
    }

    /**
     * Number, type and deed number of each document version, from its filing or correction in the
     * trail (a correction names no type: that comes from the filing). Null fields for a document
     * sealed before the audit service (the backfill has no trail entry for it).
     */
    async describeDocuments(page) {
        const entries = await this.repo.entriesByEventIds(page.map(d => d.eventId).filter(Boolean));
        const byEvent = new Map(entries.map(e => [e.eventId, e]));
        return Promise.all(page.map(async (d) => {
            const entry = byEvent.get(d.eventId);
            let docType = entry?.data.docType ?? null;
            if (entry && !docType) {
                const { entries: filed } = await this.repo.list({ subjects: [`document:${d.id}`], type: 'edrms.document.filed' }, { limit: 1, offset: 0 });
                docType = filed[0]?.data.docType ?? null;
            }
            return { edrmsNo: entry?.data.edrmsNo ?? null, docType, ref: entry?.data.instrumentRef ?? null };
        }));
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

/** The land-records lookup for what a batch covers (`POST /records/lookup`, service only). */
export function createCoverageSources({ recordsUrl, serviceToken, fetchImpl, timeoutMs }) {
    const request = createServiceClient({ serviceToken, fetchImpl, timeoutMs });
    return {
        lookup: (body) => request(`${recordsUrl}/records/lookup`, { name: 'land records service', method: 'POST', body })
    };
}
