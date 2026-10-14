/** How many recorded trail gaps the health report lists. */
const GAPS_LISTED = 5;

/** Live warnings older than this are dropped from the report (a day). */
const WARNING_KEEP_MS = 24 * 3_600_000;

/** An anchoring is overdue when fingerprints wait and the last one is this many periods old. */
const OVERDUE_PERIODS = 2;

/** The status the screens show: a prepared transaction is already on its way. */
function publicStatus(status) {
    return status === 'prepared' || status === 'submitted' ? 'sent' : status;
}

/**
 * Whether anchoring is working, for administrators (API-674): the published wallet and its funds,
 * whether the blockchain can be reached (and the own node is in sync), the last anchoring and when
 * the next one is due, and recorded trail gaps, with warnings for what needs attention. The
 * broadcast warnings `audit.wallet.low` and `audit.trail.gap` are kept for a day as they arrive, so
 * a screen that reads the report again shows them while it is open.
 *
 * Each part is read on its own: when one cannot be read (the blockchain, the wallet's key), the
 * report says so and the others still come back. Internal tool names are left out.
 */
export class AnchoringHealthService {
    constructor({ repo, cardano = null, anchorings, events = null, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.cardano = cardano;
        this.anchorings = anchorings;
        this.events = events;
        this.clock = clock;
        this.config = { periodMs: 3_600_000, ...config };
        this.live = [];                                   // { kind, at, data }, newest last
    }

    /** Listens for the broadcast warnings (they are not durable: only those that arrive while the service runs). */
    start() {
        this.events?.subscribe('audit.wallet.low', (event) => this.remember('lowFunds', event));
        this.events?.subscribe('audit.trail.gap', (event) => this.remember('trailGap', event));
    }

    /** Keeps the latest warning of each kind (a wallet out of funds repeats its warning every round of the job). */
    remember(kind, event) {
        this.live = this.live.filter(w => w.kind !== kind || kind === 'trailGap');
        this.live.push({ kind, at: event.time ?? this.clock().toISOString(), data: event.data ?? {} });
        if (this.live.length > 50) this.live.shift();
    }

    async health() {
        const now = this.clock();
        const [wallet, chain, last, next, gaps] = await Promise.all([this.wallet(), this.chain(), this.repo.lastAnchor(), this.anchorings.next(), this.gaps()]);
        const anchoring = last ? { batch: last.batch, status: publicStatus(last.status), createdAt: last.createdAt } : null;
        const overdue = !!this.cardano && !!last && (next?.waiting ?? 0) > 0
            && now - new Date(last.createdAt) > OVERDUE_PERIODS * this.config.periodMs;
        const warnings = [];
        if (this.cardano) {
            if (!wallet.readable) warnings.push('walletUnreadable');
            if (wallet.funds?.low) warnings.push('lowFunds');
            if (!chain.reachable) warnings.push('unreachable');
            else if (chain.synced === false) warnings.push('catchingUp');
            if (overdue) warnings.push('overdue');
        }
        if (gaps.count) warnings.push('trailGap');
        const since = now.getTime() - WARNING_KEEP_MS;
        return {
            configured: !!this.cardano,
            network: this.cardano?.network ?? null,
            wallet,
            chain,
            lastAnchoring: anchoring,
            next,
            overdue,
            gaps,
            warnings,
            live: this.live.filter(w => new Date(w.at).getTime() >= since).map(w => ({ kind: w.kind, at: w.at, missing: w.data.missing ?? null }))
        };
    }

    /** The wallet's address and funds; `readable` false when its key cannot be read now. */
    async wallet() {
        if (!this.cardano) return { readable: false, address: null, funds: null };
        let address;
        try {
            address = await this.cardano.address();
        } catch {
            return { readable: false, address: null, funds: null };
        }
        try {
            const { ada, low, minimumAda } = await this.cardano.funds();
            return { readable: true, address, funds: { ada, low, minimumAda } };
        } catch {
            return { readable: true, address, funds: null };
        }
    }

    /** Whether the blockchain answers, its height, and whether the node or provider is at its tip. */
    async chain() {
        if (!this.cardano) return { reachable: false, tipHeight: null, synced: null };
        try {
            const [tipHeight, synced] = await Promise.all([this.cardano.tipHeight(), this.cardano.synced()]);
            return { reachable: true, tipHeight, synced };
        } catch {
            return { reachable: false, tipHeight: null, synced: null };
        }
    }

    /** The recorded trail gaps: how many, and the latest few. */
    async gaps() {
        const filter = { type: 'audit.trail.gap' };
        const { total } = await this.repo.list(filter, { limit: 1, offset: 0 });
        const { entries } = total ? await this.repo.list(filter, { limit: GAPS_LISTED, offset: Math.max(0, total - GAPS_LISTED) }) : { entries: [] };
        const latest = entries.reverse().map(e => ({ seq: e.seq, at: e.time, missing: e.data?.missing ?? null }));
        return { count: total, latest };
    }
}
