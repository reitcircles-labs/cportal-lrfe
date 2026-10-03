import { hostname } from 'node:os';
import { runExtraction } from './extraction/pipeline.js';

async function toBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/**
 * The extraction worker: takes queued jobs, sends the document to the model (via the pipeline),
 * and hands the result to IntakeService. Runs inside the intake service for local work
 * (INTAKE_RUN_WORKER=true) or as its own process (npm run worker) — several workers can share
 * the queue (Postgres SKIP LOCKED).
 * `jev` (optional, see ./extraction/jev.js) judges what the model read; null means no Jev.
 *
 * Failures are retried with backoff (1 min, 4 min, …) up to the job's maxAttempts; a model error
 * that retrying cannot fix (bad request) fails at once. When this month's spend reaches
 * `monthlyBudgetUsd`, the worker stops taking jobs until the next month (or a higher budget).
 */
export class ExtractionWorker {
    constructor({ repo, service, store, primary, escalation = null, checker, jev = null, jevConfig = null, monthlyBudgetUsd = null, maxEscalationPages = 10, pollMs = 2000, staleMs = 10 * 60_000, clock = () => new Date(), logger = console }) {
        Object.assign(this, { repo, service, store, primary, escalation, checker, jev, jevConfig, monthlyBudgetUsd, maxEscalationPages, pollMs, staleMs, clock, logger });
        this.workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
        this.running = false;
        this.budgetWarned = false;
    }

    async overBudget() {
        if (this.monthlyBudgetUsd == null) return false;
        const { costUsd } = await this.service.usage();
        const over = costUsd >= this.monthlyBudgetUsd;
        if (over && !this.budgetWarned) this.logger.warn({ costUsd, budget: this.monthlyBudgetUsd }, 'extraction paused: monthly budget reached');
        this.budgetWarned = over;
        return over;
    }

    /** Process at most one job. Returns true if a job was taken. */
    async tick() {
        if (await this.overBudget()) return false;
        const now = this.clock();
        const job = await this.repo.claimJob({ workerId: this.workerId, now, staleMs: this.staleMs });
        if (!job) return false;
        try {
            const doc = await this.service.markExtracting(job.documentId);
            const buffer = await toBuffer(await this.store.getStream(doc.fileKey));
            const result = await runExtraction({
                file: { buffer, mimeType: doc.mimeType, fileName: doc.fileName },
                primary: this.primary, escalation: this.escalation, checker: this.checker, jev: this.jev, jevConfig: this.jevConfig,
                forceEscalation: !!job.options?.escalate, pages: doc.pages ?? null, maxEscalationPages: this.maxEscalationPages, clock: this.clock
            });
            await this.service.applyExtraction(job.documentId, result);
            await this.repo.updateJob(job.id, { status: 'done', lastError: null, updatedAt: this.clock() });
        } catch (err) {
            const final = err.retryable === false || job.attempts >= job.maxAttempts;
            const delay = 60_000 * 4 ** (job.attempts - 1);
            this.logger.error({ err: err.message, documentId: job.documentId, attempt: job.attempts, final }, 'extraction failed');
            await this.repo.updateJob(job.id, final
                ? { status: 'failed', lastError: err.message, updatedAt: this.clock() }
                : { status: 'queued', lastError: err.message, runAfter: new Date(this.clock().getTime() + delay), updatedAt: this.clock() });
            await this.service.markExtractionFailed(job.documentId, { attempts: err.attempts || [], error: err.message, final }).catch(e => this.logger.error({ err: e.message }, 'could not record the failure'));
        }
        return true;
    }

    /** Drain the queue now (tests, and "run once" scripts). */
    async drain(limit = 100) {
        let n = 0;
        while (n < limit && await this.tick()) n++;
        return n;
    }

    start() {
        if (this.running) return;
        this.running = true;
        const loop = async () => {
            if (!this.running) return;
            let worked = false;
            try { worked = await this.tick(); } catch (err) { this.logger.error({ err: err.message }, 'worker tick failed'); }
            if (this.running) this.timer = setTimeout(loop, worked ? 0 : this.pollMs);
        };
        loop();
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
    }
}
