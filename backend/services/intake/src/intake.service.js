import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@lrfe/common';
import { storageKey } from '@lrfe/storage';
import { docType } from './doc-types.js';
import { normalize } from './extraction/normalize.js';
import { countPages } from './pages.js';
import { flagOf } from './extraction/pipeline.js';
import { XCHECK_CODES } from './extraction/crosscheck.js';

export const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const SYSTEM = { id: null, name: 'System' };

async function toBuffer(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

/**
 * Intake: batches, captured documents, extraction results as *proposals*, the review of every
 * field against its evidence and checks, and filing the verified values into the EDRMS.
 *
 * Document status: queued → extracting → ready (in review) → filed
 *                                     ↘ failed (retry)     ↘ rejected
 * Extracted values never go to the EDRMS directly: only what a reviewer accepted or corrected
 * is filed, with the extraction's provenance attached.
 */

/**
 * The encrypting store's key service (OpenBao) failed: sealed, unreachable, or this service's login
 * or key refused. Screens get a neutral message (no tool names); the cause stays on the error.
 */
export const STORE_UNAVAILABLE = 'The document store is temporarily unavailable. Try again shortly.';
export function storeError(err) {
    if (err?.name !== 'KeyringError') return err;
    return Object.assign(new AppError(503, STORE_UNAVAILABLE), { cause: err, code: err.code });
}

export class IntakeService {
    constructor({ repo, store, events, edrms, checker, clock = () => new Date(), config = {} }) {
        this.repo = repo;
        this.store = store;
        this.events = events;
        this.edrms = edrms;
        this.checker = checker;
        this.clock = clock;
        this.config = { registry: 'WDH', claimMinutes: 30, maxAttempts: 3, ...config };
    }

    // ---------------------------------------------------------------- helpers

    async requireDocument(id) {
        const d = await this.repo.getDocument(id);
        if (!d) throw new NotFoundError('Document not found');
        return d;
    }

    async event(documentId, action, actor = SYSTEM, extra = {}) {
        await this.repo.addEvent({ documentId, action, k: extra.k ?? null, from: extra.from ?? null, to: extra.to ?? null, detail: extra.detail ?? null, byId: actor.id ?? null, byName: actor.name ?? null, at: this.clock() });
    }

    summary(d) {
        const fields = d.fields || [];
        const count = (flag) => fields.filter(f => f.flag === flag).length;
        const t = docType(d.docType);
        const ref = t?.refField ? fields.find(f => f.k === t.refField)?.value : null;
        return {
            id: d.id, batchId: d.batchId, status: d.status, fileName: d.fileName, mimeType: d.mimeType, size: d.size, pages: d.pages,
            docType: d.docType, docTypeLabel: t?.label ?? null, ref: ref || null,
            property: fields.find(f => f.k === 'property')?.value || null,
            flags: { ok: count('ok'), check: count('check'), conflict: count('conflict'), missing: count('missing') },
            reviewed: fields.filter(f => f.status !== 'pending').length, total: fields.length,
            escalated: !!d.escalated, extractionCostUsd: d.extractionCostUsd || 0, extractionError: d.extractionError || null,
            capturedAt: d.capturedAt, capturedByName: d.capturedByName,
            claimedById: this.claimActive(d) ? d.claimedById : null, claimedByName: this.claimActive(d) ? d.claimedByName : null,
            edrmsNo: d.edrmsNo || null, filedDocumentId: d.filedDocumentId || null, rejectedReason: d.rejectedReason || null
        };
    }

    claimActive(d) {
        return !!d.claimedById && this.clock() - new Date(d.claimedAt) < this.config.claimMinutes * 60_000;
    }

    /** Save with optimistic concurrency; a concurrent change → 409 (reload and retry). */
    async save(d, patch) {
        const updated = await this.repo.updateDocument(d.id, { ...patch, updatedAt: this.clock() }, d.version);
        if (!updated) throw new ConflictError('The document was changed by someone else. Reload and try again.');
        return updated;
    }

    // ---------------------------------------------------------------- batches

    async createBatch({ source = '' }, actor) {
        const n = await this.repo.nextBatchNumber(this.config.registry);
        const batch = { id: `${this.config.registry}-B${String(n).padStart(3, '0')}`, registry: this.config.registry, source: String(source).slice(0, 200), createdById: actor.id, createdByName: actor.name, createdAt: this.clock() };
        return this.repo.createBatch(batch);
    }

    async listBatches() {
        const [batches, counts] = await Promise.all([this.repo.listBatches(), this.repo.countByBatch()]);
        return batches.map(b => {
            const c = counts[b.id] || {};
            return { ...b, counts: { total: Object.values(c).reduce((a, n) => a + n, 0), ...c } };
        });
    }

    // ---------------------------------------------------------------- capture

    /** Store an uploaded file in staging and queue it for extraction. */
    async captureDocument({ batchId, file }, actor) {
        let key = null;
        try {
            if (!(await this.repo.getBatch(batchId))) throw new NotFoundError(`Batch ${batchId} not found`);
            if (!file?.stream) throw new BadRequestError('A file is required');
            if (!ACCEPTED_TYPES.includes(file.mimeType)) throw new BadRequestError(`Upload a PDF, PNG or JPEG (got ${file.mimeType}). TIFF needs converting first.`);
            const id = randomUUID();
            key = storageKey('intake', id, 1, file.fileName);
            const { sha256, size, encryption } = await this.store.put({ key, body: file.stream, contentType: file.mimeType }).catch(err => { throw storeError(err); });
            if (file.stream.truncated) throw new AppError(413, 'The file is larger than the allowed upload size');
            if (!size) throw new BadRequestError('The file is empty');
            const existing = await this.repo.findBySha(sha256);
            if (existing) throw new ConflictError(`This file was already captured (${existing.fileName}, batch ${existing.batchId})`, { documentId: existing.id });

            const pages = await countPages(await toBuffer(await this.readFile(key, encryption)), file.mimeType);
            const now = this.clock();
            const doc = await this.repo.createDocument({
                id, batchId, status: 'queued', fileKey: key, fileName: key.split('/').pop(), mimeType: file.mimeType, size, sha256, pages,
                ...(encryption ? { encryption } : {}),
                capturedById: actor.id, capturedByName: actor.name, capturedAt: now, fields: [], notes: [], languages: [],
                escalated: false, extractionCostUsd: 0, updatedAt: now
            });
            key = null;
            await this.enqueue(doc.id, {});
            await this.event(doc.id, 'captured', actor, { detail: `${doc.fileName} · ${pages ?? '?'} page(s) · ${size} bytes` });
            await this.events.publish('intake.document.captured', { documentId: doc.id, batchId, sha256 }, { actor });
            return this.summary(doc);
        } catch (err) {
            if (file?.stream) for await (const _ of file.stream) { /* drain */ }
            if (key) await this.store.delete(key).catch(() => {});
            throw err;
        }
    }

    async enqueue(documentId, options) {
        const now = this.clock();
        await this.repo.enqueueJob({ id: randomUUID(), documentId, type: 'extract', options, status: 'queued', attempts: 0, maxAttempts: this.config.maxAttempts, runAfter: now, createdAt: now, updatedAt: now });
    }

    /** Read the document again (e.g. after a rescan, or with the stronger model). */
    async requestExtraction(id, { escalate = false } = {}, actor) {
        const d = await this.requireDocument(id);
        if (['filed', 'rejected'].includes(d.status)) throw new ConflictError(`The document is ${d.status}`);
        if (await this.repo.hasOpenJob(id)) throw new ConflictError('An extraction is already queued for this document');
        const updated = await this.save(d, { status: 'queued', extractionError: null });
        await this.enqueue(id, { escalate: !!escalate });
        await this.event(id, 'extraction_requested', actor, { detail: escalate ? 'with the escalation model' : null });
        return this.summary(updated);
    }

    // ---------------------------------------------------------------- results from the worker

    async markExtracting(id) {
        const d = await this.requireDocument(id);
        return this.save(d, { status: 'extracting' });
    }

    /** Store a finished extraction (all model calls, the review rows) and put the document in review. */
    async applyExtraction(id, { attempts, answer, rows, notes, escalated }) {
        const d = await this.requireDocument(id);
        let cost = d.extractionCostUsd || 0, latest = null;
        const checks = attempts.filter(a => a.role === 'crosscheck' && a.ok);
        const last = checks[checks.length - 1];
        const crosscheck = last ? { provider: last.provider, model: last.model, version: last.promptVersion, calls: checks.length, at: last.at } : null;
        for (const a of attempts) {
            const extractionId = randomUUID();
            await this.repo.addExtraction({ id: extractionId, documentId: id, role: a.role, ok: a.ok, provider: a.provider, model: a.model, promptVersion: a.promptVersion, answer: a.answer ?? null, usage: a.usage, costUsd: a.costUsd, durationMs: a.durationMs, error: a.error ?? null, createdAt: a.at });
            cost += a.costUsd || 0;
            // the reading the fields come from (the cross-check call judges it, it does not read)
            if (a.ok && a.role !== 'crosscheck') latest = extractionId;
        }
        const updated = await this.save(d, {
            status: 'ready', docType: answer.docType, docTypeReason: answer.docTypeReason, languages: answer.languages, handwritingPresent: answer.handwritingPresent,
            // pages counted at capture; the transcription's count if that is larger (or the file could not be parsed)
            pages: Math.max(d.pages || 0, answer.pages.length) || null, fields: rows, notes, latestExtractionId: latest, crosscheck, escalated: !!escalated,
            extractionCostUsd: Math.round(cost * 1e6) / 1e6, extractionError: null, claimedById: null, claimedByName: null, claimedAt: null
        });
        const flags = this.summary(updated).flags;
        await this.event(id, 'extracted', SYSTEM, { detail: `${answer.docType} · ${rows.length} fields · ${flags.conflict} conflict, ${flags.check + flags.missing} to check${escalated ? ' · escalated' : ''}` });
        await this.events.publish('intake.document.extracted', { documentId: id, docType: answer.docType, flags, escalated: !!escalated });
        return updated;
    }

    /** `error` is shown on screen (neutral); `detail` (the raw error) only goes to the trail. */
    async markExtractionFailed(id, { attempts = [], error, detail = error, final }) {
        const d = await this.requireDocument(id);
        for (const a of attempts) {
            await this.repo.addExtraction({ id: randomUUID(), documentId: id, role: a.role, ok: false, provider: a.provider, model: a.model, promptVersion: a.promptVersion, answer: null, usage: null, costUsd: null, durationMs: null, error: a.error, createdAt: a.at });
        }
        await this.save(d, { status: final ? 'failed' : 'queued', extractionError: error });
        await this.event(id, final ? 'extraction_failed' : 'extraction_retry', SYSTEM, { detail });
    }

    // ---------------------------------------------------------------- reading

    async listDocuments(query) {
        const res = await this.repo.listDocuments(query);
        return { ...res, items: res.items.map(d => this.summary(d)) };
    }

    async getDocument(id) {
        const d = await this.requireDocument(id);
        const extractions = await this.repo.listExtractions(id);
        const latest = extractions.find(e => e.id === d.latestExtractionId);
        return {
            ...this.summary(d),
            docTypeReason: d.docTypeReason, languages: d.languages, handwritingPresent: d.handwritingPresent,
            fields: d.fields, notes: d.notes, version: d.version,
            transcription: latest?.answer?.pages ?? [],
            extractions: extractions.map(({ answer, ...e }) => e)
        };
    }

    async listEvents(id) {
        await this.requireDocument(id);
        return this.repo.listEvents(id);
    }

    /** The staged scan as a stream, decrypted when it was stored encrypted. */
    async readFile(key, encryption) {
        return this.store.getStream(key, { encryption }).catch(err => { throw storeError(err); });
    }

    async openFile(id) {
        const d = await this.requireDocument(id);
        return { stream: await this.readFile(d.fileKey, d.encryption), mimeType: d.mimeType, fileName: d.fileName };
    }

    // ---------------------------------------------------------------- review

    /** Take (or keep) the review lock; expires after claimMinutes without activity. */
    async claim(id, actor) {
        const d = await this.requireDocument(id);
        if (d.status !== 'ready') throw new ConflictError(`The document is ${d.status}, not ready for review`);
        if (this.claimActive(d) && d.claimedById !== actor.id) throw new ConflictError(`${d.claimedByName} is reviewing this document`);
        return this.save(d, { claimedById: actor.id, claimedByName: actor.name, claimedAt: this.clock() });
    }

    async release(id, actor) {
        const d = await this.requireDocument(id);
        if (d.claimedById !== actor.id) return this.summary(d);
        return this.summary(await this.save(d, { claimedById: null, claimedByName: null, claimedAt: null }));
    }

    /**
     * Accept a field, reset it to pending, or correct its value. A correction is normalised and
     * re-checked (format and cross-document checks) like an extracted value.
     *   { status: 'accepted' | 'pending' }   or   { value: '…' }
     */
    async updateField(id, k, { value, status }, actor) {
        let d = await this.claim(id, actor);
        const t = docType(d.docType);
        const def = t?.fields.find(x => x.k === k);
        if (!def) throw new BadRequestError(`"${k}" is not a field of ${t?.label || 'this document'}`);
        const rows = structuredClone(d.fields);
        let row = rows.find(r => r.k === k);
        if (!row) {
            // The reviewer adds an optional field the model did not find.
            row = { k, label: def.label, type: def.type, required: def.required, extracted: null, evidence: null, model: null, value: '', normalized: null, status: 'pending', checks: [], flag: 'ok', alt: null };
            rows.push(row);
            rows.sort((a, b) => t.fields.findIndex(x => x.k === a.k) - t.fields.findIndex(x => x.k === b.k));
        }
        if (value !== undefined) {
            const before = row.value;
            const n = normalize(def.type, value);
            if (n.value === before) {
                row.status = 'accepted';
            } else {
                Object.assign(row, { value: n.value, normalized: n.normalized, status: 'edited' });
                row.checks = [...n.checks];
                if (!n.value && def.required) row.checks.push({ level: 'warn', code: 'missing', message: 'Required field is empty' });
                // the evidence, "models disagree" and cross-check notes were about the old value
                row.alt = null;
                delete row.xcheck;
            }
            await this.recheck(d.docType, rows);
            d = await this.save(d, { fields: rows });
            await this.event(id, n.value === before ? 'field_accepted' : 'field_edited', actor, { k, from: before, to: n.value });
        } else if (status === 'accepted' || status === 'pending') {
            if (status === 'pending') row.status = 'pending';
            else if (row.status === 'pending') row.status = 'accepted';
            d = await this.save(d, { fields: rows });
            await this.event(id, status === 'accepted' ? 'field_accepted' : 'field_reset', actor, { k, to: row.value });
        } else throw new BadRequestError('Send a value, or status "accepted" / "pending"');
        return this.getDocument(id);
    }

    /** Re-run cross-document checks for all rows (a corrected deed number changes the duplicate check, etc.). */
    async recheck(typeId, rows) {
        for (const r of rows) r.checks = r.checks.filter(c => !['duplicate', 'prior_missing', 'prior_found', 'prior_property', 'chain', 'chain_ok', 'sg_missing', 'sg_found', 'extent_mismatch', 'crosscheck_unavailable'].includes(c.code));
        await this.checker.check(typeId, rows);
        rows.forEach(r => { r.flag = flagOf(r); });
    }

    /** Accept every field that passed all checks and is still pending. */
    async acceptClean(id, actor) {
        let d = await this.claim(id, actor);
        const rows = structuredClone(d.fields);
        const accepted = rows.filter(r => r.status === 'pending' && r.flag === 'ok' && r.value);
        accepted.forEach(r => { r.status = 'accepted'; });
        d = await this.save(d, { fields: rows });
        if (accepted.length) await this.event(id, 'fields_accepted', actor, { detail: accepted.map(r => r.k).join(', ') });
        return this.getDocument(id);
    }

    /** Why this document cannot be filed yet (empty = it can). */
    blockers(d) {
        const out = [];
        if (d.status !== 'ready') out.push(`The document is ${d.status}`);
        if (!docType(d.docType)) out.push('The document type is not recognised');
        const pending = d.fields.filter(f => f.status === 'pending');
        if (pending.length) out.push(`${pending.length} field(s) not reviewed: ${pending.map(f => f.label).join(', ')}`);
        const errors = d.fields.filter(f => f.checks.some(c => c.level === 'error'));
        if (errors.length) out.push(`Fix before filing: ${errors.map(f => `${f.label} (${f.checks.find(c => c.level === 'error').message})`).join('; ')}`);
        const missing = d.fields.filter(f => f.required && !f.value);
        if (missing.length) out.push(`Required: ${missing.map(f => f.label).join(', ')}`);
        return out;
    }

    /** File the verified values into the EDRMS (as a sealed v1.0), with the extraction's provenance. */
    async fileDocument(id, actor) {
        let d = await this.claim(id, actor);
        const blockers = this.blockers(d);
        if (blockers.length) throw new ConflictError('Not ready to file', { blockers });
        const t = docType(d.docType);
        const extraction = d.latestExtractionId ? await this.repo.getExtraction(d.latestExtractionId) : null;
        // the plain scan goes to edrms over TLS; edrms encrypts it under its own key
        const buffer = await toBuffer(await this.readFile(d.fileKey, d.encryption));
        const result = await this.edrms.fileDocument({
            buffer, fileName: d.fileName, mimeType: d.mimeType,
            meta: {
                sourceId: d.id, batchId: d.batchId, docType: d.docType, title: t.label, pages: d.pages || 1,
                fields: d.fields.filter(f => f.value).map(f => ({ k: f.k, label: f.label, v: f.value, ...(f.status === 'edited' ? { edited: true } : {}) })),
                capturedBy: { id: d.capturedById, name: d.capturedByName },
                reviewedBy: { id: actor.id, name: actor.name },
                provenance: extraction && {
                    intakeDocumentId: d.id, extractionId: extraction.id, provider: extraction.provider, model: extraction.model,
                    promptVersion: extraction.promptVersion, extractedAt: extraction.createdAt, escalated: !!d.escalated,
                    extracted: Object.fromEntries(d.fields.filter(f => f.extracted != null).map(f => [f.k, f.extracted])),
                    corrected: d.fields.filter(f => f.status === 'edited').map(f => f.k),
                    // tool, model, version and calls of the cross-check, and the fields it still
                    // flagged when filed as read (corrected ones are in `corrected`); audit only
                    ...(d.crosscheck ? { crosscheck: { ...d.crosscheck, flagged: d.fields.filter(f => f.checks.some(c => XCHECK_CODES.includes(c.code))).map(f => f.k) } } : {})
                }
            }
        });
        d = await this.save(d, {
            status: 'filed', filedDocumentId: result.document.id, edrmsNo: result.document.edrmsNo, filedAt: this.clock(),
            filedById: actor.id, filedByName: actor.name, claimedById: null, claimedByName: null, claimedAt: null
        });
        await this.event(id, 'filed', actor, { detail: result.document.edrmsNo });
        await this.events.publish('intake.document.filed', { documentId: id, edrmsDocumentId: result.document.id, edrmsNo: result.document.edrmsNo }, { actor });
        return this.summary(d);
    }

    /** Not a land-registry instrument, a duplicate, unreadable… Kept, never deleted. */
    async rejectDocument(id, reason, actor) {
        if (!String(reason || '').trim()) throw new BadRequestError('A reason is required');
        const d = await this.requireDocument(id);
        if (d.status === 'filed') throw new ConflictError('A filed document cannot be rejected; request a correction in the EDRMS instead');
        if (this.claimActive(d) && d.claimedById !== actor.id) throw new ForbiddenError(`${d.claimedByName} is reviewing this document`);
        const updated = await this.save(d, { status: 'rejected', rejectedReason: String(reason).trim(), claimedById: null, claimedByName: null, claimedAt: null });
        await this.event(id, 'rejected', actor, { detail: updated.rejectedReason });
        return this.summary(updated);
    }

    // ---------------------------------------------------------------- usage

    /** Model calls, tokens and cost since the start of a month (default: this month). */
    async usage({ month } = {}) {
        const now = this.clock();
        const [y, m] = month ? month.split('-').map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
        const since = new Date(Date.UTC(y, m - 1, 1));
        const until = new Date(Date.UTC(y, m, 1));
        const rows = (await this.repo.usageSince(since)).filter(e => new Date(e.createdAt) < until);
        const byModel = {};
        for (const e of rows) {
            const b = byModel[e.model] ??= { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, thoughtsTokens: 0, costUsd: 0 };
            b.calls++;
            if (!e.ok) b.failed++;
            b.inputTokens += e.usage?.inputTokens || 0;
            b.outputTokens += e.usage?.outputTokens || 0;
            b.thoughtsTokens += e.usage?.thoughtsTokens || 0;
            b.costUsd = Math.round((b.costUsd + (e.costUsd || 0)) * 1e6) / 1e6;
        }
        const documents = new Set(rows.filter(e => e.ok).map(e => e.documentId)).size;
        const costUsd = Math.round(Object.values(byModel).reduce((a, b) => a + b.costUsd, 0) * 1e6) / 1e6;
        return { month: `${y}-${String(m).padStart(2, '0')}`, documents, costUsd, byModel };
    }
}
