import { randomUUID } from 'node:crypto';

const IN_FLIGHT = ['prepared', 'submitted', 'onChain'];
const ON_CHAIN_OR_GOING = ['confirmed', ...IN_FLIGHT];

/** "1h", "15m", "90s" or milliseconds → milliseconds (ANCHOR_PERIOD). */
export function parsePeriod(value, fallback = 3_600_000) {
    if (value === undefined || value === null || value === '') return fallback;
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
    if (!m) throw new Error(`ANCHOR_PERIOD "${value}" is not a period (e.g. 1h, 15m)`);
    const ms = Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 'ms'];
    if (ms < 60_000) throw new Error(`ANCHOR_PERIOD "${value}" is shorter than a minute`);
    return ms;
}

/**
 * Hourly anchoring (README.md section 3). Every `checkMs` (a minute) the job:
 *
 *   1. follows the anchoring in flight, if any: sends its stored transaction (again) until it is on
 *      chain, counts its depth there and marks it confirmed at `confirmations` blocks. A transaction
 *      is invalid from slot `ttl` on (an hour after it was built); it is given up only once the chain
 *      is `confirmations` blocks past that point without it, and its replacement spends the same
 *      wallet output, so the same leaves can never be anchored twice. A rollback sends the same
 *      transaction again;
 *   2. otherwise, once a period (`periodMs`, an hour) has passed since the last anchoring, and if
 *      anything was recorded since the last one on chain (new leaves, or trail entries after its
 *      checkpoint): adds a trail checkpoint, takes the root and submits one anchoring.
 *
 * One anchoring is in flight at a time, and one instance runs the job (a lease). Its bookkeeping
 * events are broadcast-only, so anchoring never causes the next one.
 */
export class AnchorService {
    constructor({ repo, tree, cardano, events = null, logger = console, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.tree = tree;
        this.cardano = cardano;
        this.events = events;
        this.logger = logger;
        this.clock = clock;
        this.holder = config.holder ?? randomUUID();
        this.config = {
            // resendMs: how often a transaction not yet on chain is sent again; retryMs: the wait after a refusal
            periodMs: 3_600_000, confirmations: 10, checkMs: 60_000, resendMs: 5 * 60_000, retryMs: 5 * 60_000,
            ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))
        };
        this.running = false;
    }

    start() {
        const run = () => this.tick().catch(err => this.logger.error?.({ err: err.message, code: err.code }, 'audit: anchoring job failed; it tries again'));
        this.first = setTimeout(run, 10_000);
        this.timer = setInterval(run, this.config.checkMs);
        this.first.unref?.();
        this.timer.unref?.();
    }

    stop() { clearTimeout(this.first); clearInterval(this.timer); }

    /** One round. Returns what it did (for the log and the tests). */
    async tick() {
        if (this.running) return { action: 'busy' };
        this.running = true;
        try {
            if (!(await this.repo.claimLease('anchoring', this.holder, Math.max(3 * this.config.checkMs, 300_000), this.clock()))) return { action: 'another instance anchors' };
            const flight = await this.repo.lastAnchorWhere(IN_FLIGHT);
            if (!flight) return await this.maybeAnchor();
            const followed = await this.follow(flight);
            if (followed.inFlight || followed.action === 'confirmed') return followed;   // the next one waits for its period
            // expired or refused: the same leaves are anchored again in this round
            return { ...(await this.maybeAnchor()), after: followed.action };
        } finally {
            this.running = false;
        }
    }

    /** The anchoring in flight: send, count depth, confirm; give it up only once it can never land. */
    async follow(a) {
        if (a.status === 'prepared') return this.send(a);
        const s = await this.cardano.status(a.txHash);
        if (s.onChain) {
            const firstSeen = a.firstSeenHeight ?? s.blockHeight ?? s.tipHeight;
            const depth = s.tipHeight - (s.blockHeight ?? firstSeen) + 1;
            const patch = { status: 'onChain', firstSeenHeight: firstSeen, blockHeight: s.blockHeight ?? null, expiredSeenHeight: null };
            if (depth >= this.config.confirmations) {
                await this.repo.updateAnchor(a.batch, { ...patch, status: 'confirmed', confirmedAt: this.clock() });
                this.logger.info?.({ batch: a.batch, txHash: a.txHash, depth }, 'audit: anchoring confirmed');
                await this.publish('audit.root.confirmed', { batch: a.batch, root: a.root, size: a.size, txHash: a.txHash, blockHeight: s.blockHeight ?? null, firstSeenHeight: firstSeen, depth });
                return { action: 'confirmed', batch: a.batch, inFlight: false };
            }
            await this.repo.updateAnchor(a.batch, patch);
            return { action: 'waiting for confirmations', batch: a.batch, depth, inFlight: true };
        }
        if (this.expired(a, s)) {
            // invalid from now on and not on chain. Before giving up, wait until the chain is as many
            // blocks past this point as a confirmation needs: a provider's backends can lag behind each
            // other, and a short fork could still hold it in a block from before its limit.
            if (!a.expiredSeenHeight) {
                await this.repo.updateAnchor(a.batch, { expiredSeenHeight: s.tipHeight });
                return { action: 'expired, making sure', batch: a.batch, inFlight: true };
            }
            if (s.tipHeight - a.expiredSeenHeight < this.config.confirmations) return { action: 'expired, making sure', batch: a.batch, inFlight: true };
            await this.repo.updateAnchor(a.batch, { status: 'failed', error: a.status === 'onChain' ? 'rolled back, and expired before it landed again' : 'expired before it reached the chain' });
            this.logger.warn?.({ batch: a.batch, txHash: a.txHash }, 'audit: an anchoring expired without reaching the chain; anchoring again');
            return { action: 'expired', batch: a.batch, inFlight: false };
        }
        if (a.status === 'onChain') {
            // it was on chain and is gone: a rollback. The same transaction is sent again (still valid).
            await this.repo.updateAnchor(a.batch, { status: 'submitted', firstSeenHeight: null, blockHeight: null, error: 'rolled back; sent again' });
            this.logger.warn?.({ batch: a.batch, txHash: a.txHash }, 'audit: an anchoring was rolled back; sending it again');
            return { ...(await this.send({ ...a, status: 'submitted' })), action: 'rolled back, sent again' };
        }
        if (this.clock() - new Date(a.lastSentAt ?? a.submittedAt) >= this.config.resendMs) return this.send(a);
        return { action: 'waiting for the chain', batch: a.batch, inFlight: true };
    }

    /** Invalid from slot `ttl` on (invalid_hereafter). A row without one (before API-657's fix) never expires. */
    expired(a, s) {
        return a.ttl !== null && a.ttl !== undefined && s.tipSlot >= a.ttl;
    }

    /**
     * Send the stored transaction (again). A send that fails is repeated later. A refusal after an
     * earlier send may only mean the node already has it (waiting to be included): it stays in
     * flight until it is on chain or expired. Only a first send refused outright gives way at once.
     */
    async send(a) {
        const now = this.clock();
        const attempts = a.attempts + 1;
        const firstSent = a.submittedAt ?? now;
        // recorded before it goes out: after a crash during the send, a refusal is not taken for a first one
        await this.repo.updateAnchor(a.batch, { attempts, submittedAt: firstSent, lastSentAt: now });
        try {
            await this.cardano.submit(a.cbor, a.txHash);
        } catch (err) {
            if (err.retryable) {
                await this.repo.updateAnchor(a.batch, { error: err.message });
                this.logger.warn?.({ batch: a.batch, err: err.message }, 'audit: anchoring not sent yet; it is sent again at the next round');
                return { action: 'send failed, retried later', batch: a.batch, inFlight: true };
            }
            const s = await this.cardano.status(a.txHash).catch(() => ({ onChain: false }));
            if (s.onChain || a.attempts > 0 || a.status !== 'prepared') {
                await this.repo.updateAnchor(a.batch, { status: 'submitted', attempts, submittedAt: firstSent, lastSentAt: now, error: s.onChain ? null : `sent again, refused (${err.message}): perhaps already waiting to be included` });
                if (a.status === 'prepared') await this.announce(a);
                return { action: s.onChain ? 'already on chain' : 'refused again, waiting', batch: a.batch, inFlight: true };
            }
            await this.repo.updateAnchor(a.batch, { status: 'failed', attempts, error: err.message });
            this.logger.error?.({ batch: a.batch, err: err.message, code: err.code }, 'audit: the chain refused an anchoring; anchoring again shortly');
            return { action: 'refused', batch: a.batch, inFlight: false };
        }
        await this.repo.updateAnchor(a.batch, { status: 'submitted', attempts, submittedAt: firstSent, lastSentAt: now, error: null });
        if (a.status === 'prepared') await this.announce(a);
        return { action: a.status === 'prepared' ? 'anchored' : 'sent again', batch: a.batch, txHash: a.txHash, inFlight: true };
    }

    /** Its first successful send: log, broadcast, and check the wallet (warns when low). */
    async announce(a) {
        this.logger.info?.({ batch: a.batch, txHash: a.txHash, size: a.size, fee: a.fee }, 'audit: root anchored');
        await this.publish('audit.root.anchored', { batch: a.batch, root: a.root, size: a.size, txHash: a.txHash, fee: a.fee, network: a.network });
        await this.cardano.balance().catch(() => {});
    }

    /** A new anchoring, if one is due and anything was recorded since the last one on chain. */
    async maybeAnchor() {
        const last = await this.repo.lastAnchor();
        const covered = await this.repo.lastAnchorWhere(ON_CHAIN_OR_GOING);
        // gave way: the last one failed and nothing newer is on chain (a revived one counts as newer)
        const gaveWay = last && last.status === 'failed' && !(covered?.confirmedAt && new Date(covered.confirmedAt) > new Date(last.createdAt));
        const since = gaveWay ? last : (covered && last?.status === 'failed' ? covered : last);
        const wait = gaveWay ? this.config.retryMs : this.config.periodMs;
        if (since && this.clock() - new Date(since.createdAt) < wait) return { action: gaveWay ? 'waiting before anchoring again' : 'waiting for the period' };
        const [size, head] = await Promise.all([this.tree.size(), this.repo.head()]);
        const newLeaves = size > (covered?.size ?? 0);
        const newEntries = !!head && head.seq > (covered?.checkpointSeq ?? 0);
        if (!newLeaves && !newEntries) return { action: 'nothing new' };

        if (newEntries) await this.tree.checkpoint({ seq: head.seq, hash: head.hash });
        const { root, size: n } = await this.tree.root();
        const batch = (last?.batch ?? 0) + 1;
        // a replacement spends the same wallet output as the one it replaces: never both on chain
        const spend = gaveWay && last.inputTxHash ? { txHash: last.inputTxHash, index: last.inputIndex } : undefined;
        let prepared;
        try {
            prepared = await this.cardano.prepare({ root, size: n, batch, prev: covered?.root ?? null, spend });
        } catch (err) {
            if (err.code === 'ESPENT') return this.replacedSpent(last, spend);
            if (err.code === 'EFUNDS') await this.cardano.balance().catch(() => {});
            this.logger[err.retryable ? 'warn' : 'error']?.({ batch, err: err.message, code: err.code }, 'audit: could not prepare the anchoring; it tries again');
            return { action: 'not prepared', error: err.code };
        }
        const row = await this.repo.createAnchor({
            batch, root, size: n, prevRoot: covered?.root ?? null, checkpointSeq: head?.seq ?? null, network: this.cardano.network,
            status: 'prepared', txHash: prepared.txHash, cbor: prepared.cbor, ttl: prepared.ttl,
            inputTxHash: prepared.input.txHash, inputIndex: prepared.input.index,
            fee: prepared.fee, bytes: prepared.bytes, attempts: 0, createdAt: this.clock()
        });
        return this.send(row);
    }

    /**
     * The output the given-up anchorings spent is gone. Normally one of them did land after all
     * (each of them, a replacement too, spent that same output): that one is followed again. If none
     * is found on chain, the job makes sure as for an expiry (`confirmations` blocks) before it
     * concludes that something else spent the wallet's output (README: one wallet per installation);
     * only then does the next anchoring use another output.
     */
    async replacedSpent(last, spend) {
        const candidates = await this.repo.anchorsSpending(spend.txHash, spend.index);
        let tipHeight = null;
        for (const c of candidates.reverse()) {
            const s = await this.cardano.status(c.txHash);
            tipHeight = s.tipHeight;
            if (s.onChain) {
                await this.repo.updateAnchor(c.batch, { status: 'onChain', firstSeenHeight: s.blockHeight ?? s.tipHeight, blockHeight: s.blockHeight ?? null, expiredSeenHeight: null, error: 'given up, then found on chain' });
                // the others that spent the same output can never land now: nothing more to replace
                for (const other of candidates.filter(o => o.batch !== c.batch)) await this.repo.updateAnchor(other.batch, { inputTxHash: null, inputIndex: null });
                this.logger.warn?.({ batch: c.batch, txHash: c.txHash }, 'audit: an anchoring given up landed after all; following it');
                return { action: 'landed after all', batch: c.batch };
            }
        }
        if (!last.spentSeenHeight) {
            await this.repo.updateAnchor(last.batch, { spentSeenHeight: tipHeight });
            return { action: 'output spent, making sure', batch: last.batch };
        }
        if (tipHeight - last.spentSeenHeight < this.config.confirmations) return { action: 'output spent, making sure', batch: last.batch };
        await this.repo.updateAnchor(last.batch, { inputTxHash: null, inputIndex: null });
        this.logger.error?.({ batch: last.batch, input: `${spend.txHash}#${spend.index}` }, 'audit: the wallet output of a given-up anchoring was spent by something else (is the wallet shared?)');
        return { action: 'its output was spent elsewhere', batch: last.batch };
    }

    /** The confirmed anchoring that proves leaf `index`, or null while none does yet. */
    anchorFor(index) { return this.repo.anchorCovering(index); }

    async publish(type, data) {
        try { await this.events?.publish(type, data, { durable: false }); } catch { /* the bus logs its own failures */ }
    }
}
