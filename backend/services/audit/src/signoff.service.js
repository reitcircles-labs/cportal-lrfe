import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@lrfe/common';

/** What the screens and the re-review task say when an item no longer matches the blockchain. */
export const CHANGED_SINCE_REVIEW = 'This land record has changed since it was last reviewed and submitted, so its documents and details can\u2019t be audited as true. It must be re-reviewed and submitted again before it can be audited.';
/** How many items are checked against the blockchain at once (each check calls other services). */
const VERIFY_AT_ONCE = 4;

/** Run `fn` on every item, `size` at a time. */
async function inBatches(items, size, fn) {
    for (let i = 0; i < items.length; i += size) {
        await Promise.all(items.slice(i, i + size).map(fn));
    }
}

/** How an auditor may close a finding (README.md section 5). */
export const CLOSE_OUTCOMES = ['agreed', 'mistake'];

/**
 * Sign-off and findings (README.md section 5; API-659, API-680). An auditor (`audit.signoff`):
 *
 *   checkpoint(recordId, actor)    what the next audit sign-off of a land record covers: every version
 *                                  committed since the last audit sign-off and the documents they added,
 *                                  each checked against the blockchain, the open findings, and whether
 *                                  the sign-off would be accepted (and if not, why)
 *   signOff({ recordId }, actor)   one audit sign-off for that whole checkpoint, accepted only when
 *                                  everything is on the blockchain, matches it, and no finding is open
 *   raiseFinding(target, text)     a finding on a land record version or a document version; the records
 *                                  officers and the registrars get it in their task inbox (bpm process
 *                                  "audit-finding"). Open until a newer reviewed version resolves it
 *                                  (onEvent) or an auditor answers and closes it (closeFinding)
 *   answerFinding(id, text)        an auditor's answer in the finding's thread
 *
 * Each is stored here and published as a durable event in the same transaction, so it becomes a trail
 * entry of the land record and the document it is about and, at the next anchoring, part of the root on
 * the blockchain. Finding events carry the whole thread under the key `Findings`.
 *
 * A changed item (its data no longer matches the blockchain) is not a finding: the land record changed
 * since it was reviewed, so the records officers and the registrars get a re-review task (bpm process
 * "audit-rereview"), once per item.
 *
 * `sources`: { recordInfo(recordId), version(recordId, n), record(recordId, n) → { record, version },
 * document(documentId) }
 * read from land-records and edrms with the audit service's token; `bpm`: { start(variables, process),
 * cancel(id, reason) }; `proofs`: the ProofService (anchoring status and verification).
 */
export class SignoffService {
    constructor({ repo, events, sources, bpm, proofs, clock = () => new Date(), logger = console }) {
        this.repo = repo;
        this.events = events;
        this.sources = sources;
        this.bpm = bpm;
        this.proofs = proofs;
        this.clock = clock;
        this.logger = logger;
    }

    atomic(fn) { return this.events?.atomic ? this.events.atomic(fn) : fn(); }

    /**
     * What a sign-off or finding is about: a committed land record version (recordId, version), a
     * document version pinned in it (also documentId), or, for findings, a document version on its own
     * (documentId, version).
     */
    async target({ recordId, version, documentId }, { recordRequired = false } = {}) {
        const n = Number(version);
        if (!Number.isSafeInteger(n) || n < 1) throw new BadRequestError('Which version? Give "version" (1, 2, …)');
        if (!recordId && recordRequired) throw new BadRequestError('A sign-off is on a land record version: give "recordId" and "version"');
        if (!recordId && !documentId) throw new BadRequestError('Give a land record ("recordId") or a document ("documentId")');
        const out = {};
        if (recordId) {
            const { record, version: v } = await this.sources.record(recordId, n);
            if (!['committed', 'superseded'].includes(v.state)) throw new ConflictError(`Version ${n} of ${record.recordNo} is not committed: only reviewed, committed versions can be audited`);
            out.record = { id: record.id, recordNo: record.recordNo, label: record.label, currentVersion: record.currentVersion };
            out.recordVersion = v;
            if (documentId) {
                const pinned = (v.data?.documents || []).find(d => d.edrmsDocumentId === documentId);
                if (!pinned) throw new BadRequestError(`That document is not in version ${n} of ${record.recordNo}`);
                await this.addDocument(out, documentId, pinned.version);
            }
        } else {
            await this.addDocument(out, documentId, n);
        }
        return out;
    }

    async addDocument(out, documentId, n) {
        const doc = await this.sources.document(documentId);
        const v = (doc.versions || []).find(x => x.versionNumber === n);
        if (!v) throw new NotFoundError(`${doc.edrmsNo} has no version ${n}`);
        out.document = { id: doc.id, edrmsNo: doc.edrmsNo, title: doc.title, currentVersion: doc.currentVersion };
        out.documentVersion = v;
    }

    /** The columns and event fields that name the item. */
    static itemOf(t) {
        return {
            recordId: t.record?.id ?? null, recordNo: t.record?.recordNo ?? null, recordVersion: t.recordVersion?.versionNumber ?? null,
            documentId: t.document?.id ?? null, edrmsNo: t.document?.edrmsNo ?? null, documentVersion: t.documentVersion?.versionNumber ?? null,
            seal: (t.documentVersion ?? t.recordVersion).seal ?? null
        };
    }

    /** For events: subjects are read from recordId and edrmsDocumentId (src/subjects.js). */
    static eventItem(i) {
        return {
            recordId: i.recordId ?? undefined, recordNo: i.recordNo ?? undefined, versionNumber: i.recordVersion ?? undefined,
            edrmsDocumentId: i.documentId ?? undefined, edrmsNo: i.edrmsNo ?? undefined, documentVersion: i.documentVersion ?? undefined,
            seal: i.seal ?? undefined
        };
    }

    static about(t) {
        const rec = t.record && `${t.record.recordNo} (${t.record.label}) version ${t.recordVersion.versionNumber}`;
        const doc = t.document && `${t.document.edrmsNo} version ${t.documentVersion.versionNumber}`;
        return rec && doc ? `${doc} in ${rec}` : rec || `${doc} (${t.document.title})`;
    }

    // ------------------------------------------------ audit sign-off: one per checkpoint (API-680)

    /**
     * The open checkpoint of a land record, for the screen and for the sign-off itself:
     *
     *   range                 { from, to }: the versions committed since the last audit sign-off, or null
     *   lastSignoff           the last audit sign-off, or null; with `withProof` (the screen), also
     *                         `proof` { status, batch } of its trail entry
     *   versions, documents   each with its leaf key, `anchoring` (waiting | sent | onChain | confirmed),
     *                         `batch` (the batch it is in, null while waiting)
     *                         and `match` (matches | changed | notOnChain | unavailable); a changed one
     *                         is `superseded` when a version committed after the change was found
     *                         matches (the re-reviewed version)
     *   openFindings          open findings on the record and on its documents
     *   canSignOff, reason    whether `actor` may sign it off now; if not, the reason as the screen shows it
     *
     * Only what is on the blockchain is checked for a match: the rest is `notOnChain`. A changed item
     * starts a re-review task the first time it is found (alertChanged).
     */
    async checkpoint(recordId, actor = null, { withProof = false } = {}) {
        const record = await this.sources.recordInfo(recordId);
        const past = (await this.repo.listSignoffs({ recordId })).filter(s => s.kind === 'checkpoint');
        const lastSignoff = past.at(-1) ?? null;
        const from = lastSignoff ? lastSignoff.toVersion + 1 : 1;
        const to = record.currentVersion ?? 0;
        // for the screen only: how far the last sign-off's trail entry has got, and in which batch (API-699).
        // Signing off does not need it, so it never waits for it.
        const shown = withProof && lastSignoff ? { ...lastSignoff, proof: await this.proofs.signoffBatch(recordId, lastSignoff.id) } : lastSignoff;
        const base = { recordId, recordNo: record.recordNo, label: record.label, lastSignoff: shown };
        if (from > to) {
            const reason = lastSignoff
                ? `Nothing to audit: no version was committed since the last audit sign-off (v${lastSignoff.toVersion}).`
                : 'Nothing to audit: the land record has no committed version yet.';
            return { ...base, range: null, versions: [], documents: [], openFindings: [], canSignOff: false, reason, refusal: { status: 409, reason } };
        }

        const versions = [];
        for (let n = from; n <= to; n++) {
            const version = await this.sources.version(recordId, n);
            versions.push({
                kind: 'record-version', key: `record-version:${recordId}:${n}`, label: `v${n}`,
                versionNumber: n, seal: version.seal, approvedById: version.approvedById ?? null,
                approvedByName: version.approvedByName ?? null, committedAt: version.committedAt, pins: version.data?.documents || []
            });
        }
        const documents = SignoffService.newDocuments(versions, past);
        const items = [...versions, ...documents];

        const anchoring = await this.proofs.anchoringOf(items.map(i => i.key));
        await inBatches(items, VERIFY_AT_ONCE, async (item) => {
            item.anchoring = anchoring[item.key]?.status ?? 'waiting';
            item.batch = anchoring[item.key]?.batch ?? null;
            if (['onChain', 'confirmed'].includes(item.anchoring)) {
                item.match = await this.matchOf(item, recordId);
            } else {
                item.match = 'notOnChain';
            }
        });
        for (const item of items.filter(i => i.match === 'changed')) {
            const alert = await this.alertChanged(record, item);
            item.changedFoundAt = alert?.foundAt ?? null;
            item.superseded = !!alert && versions.some(v => SignoffService.reReviews(v, item, alert));
        }

        const openFindings = await this.openFindings(recordId, documents);
        const refusal = SignoffService.refusal({ versions, documents, openFindings, actor });
        // the pinned documents and the approver's id are for the checks above, not for the screen
        const strip = ({ pins, approvedById, ...rest }) => rest;
        return {
            ...base, range: { from, to },
            versions: versions.map(strip), documents: documents.map(strip),
            openFindings: openFindings.map(SignoffService.findingRecord),
            canSignOff: !refusal, reason: refusal?.reason ?? null, refusal
        };
    }

    /**
     * Whether version `v` re-reviewed the changed `item` (README.md section 5): it was committed after
     * the change was found (told by version number, so the services' clocks do not matter), it matches
     * the blockchain, and a changed document version is no longer pinned in it.
     */
    static reReviews(v, item, alert) {
        if (v.match !== 'matches' || v.versionNumber <= alert.currentVersion) {
            return false;
        }
        if (item.kind !== 'document-version') {
            return true;
        }
        return !v.pins.some(p => p.edrmsDocumentId === item.documentId && p.version === item.version);
    }

    /**
     * The document versions the checkpoint covers: every one pinned in its versions that no earlier
     * audit sign-off covered, with the version that first pinned it (`addedIn`).
     */
    static newDocuments(versions, past) {
        const covered = new Set(past.flatMap(s => (s.items?.documents || []).map(d => `${d.documentId}:${d.version}`)));
        const out = new Map();
        for (const v of versions) {
            for (const pin of v.pins) {
                const id = `${pin.edrmsDocumentId}:${pin.version}`;
                if (covered.has(id) || out.has(id)) continue;
                out.set(id, {
                    kind: 'document-version', key: `document-version:${pin.edrmsDocumentId}:${pin.version}`, label: pin.edrmsNo,
                    documentId: pin.edrmsDocumentId, edrmsNo: pin.edrmsNo, version: pin.version, seal: pin.seal, addedIn: v.versionNumber
                });
            }
        }
        return [...out.values()];
    }

    /** An item on the blockchain checked now: matches, changed, or unavailable (the check could not run). */
    async matchOf(item, recordId) {
        const v = item.kind === 'record-version'
            ? await this.proofs.verify('record-version', recordId, item.versionNumber)
            : await this.proofs.verify('document-version', item.documentId, item.version);
        if (v.valid) return 'matches';
        const checks = [v.checks.item, v.checks.path, v.checks.chain];
        return checks.some(c => c?.ok === false) ? 'changed' : 'unavailable';
    }

    /** Open findings on the record and on its new documents alone, oldest first. */
    async openFindings(recordId, documents) {
        const out = await this.repo.listFindings({ recordId, status: 'open' });
        for (const d of documents) {
            const onDocument = await this.repo.listFindings({ documentId: d.documentId, status: 'open' });
            out.push(...onDocument.filter(f => !f.recordId && f.documentVersion === d.version));
        }
        return out.sort((x, y) => new Date(x.raisedAt) - new Date(y.raisedAt));
    }

    /**
     * Why the checkpoint cannot be signed off now, or null. Rules the auditor cannot change come first,
     * then the blockchain, then the findings (README.md section 5). `status` is the HTTP status.
     */
    static refusal({ versions, documents, openFindings, actor }) {
        const items = [...versions, ...documents];
        if (actor && (actor.perms || []).includes('record.finalize')) {
            return { status: 403, rule: 'sod2', reason: 'You can commit land record versions, so you can’t sign off audits. Another auditor signs off.' };
        }
        const approved = actor ? versions.find(v => v.approvedById && v.approvedById === actor.id) : null;
        if (approved) {
            return { status: 403, rule: 'sod2', reason: `You approved ${approved.label}, which is part of this audit, so another auditor must sign it off.` };
        }
        const waiting = items.filter(i => i.anchoring === 'waiting');
        if (waiting.length) {
            return { status: 409, reason: 'Some items go to the blockchain with the next batch. You can sign off once everything is there.' };
        }
        const sent = items.find(i => i.anchoring === 'sent');
        if (sent) {
            return { status: 409, reason: `${sent.label} is on its way to the blockchain. You can sign off once it is in a block, usually within minutes.` };
        }
        if (items.some(i => i.match === 'changed' && !i.superseded)) {
            return { status: 409, reason: 'The audit can’t be signed off until the land record has been re-reviewed and submitted again.' };
        }
        if (items.some(i => i.match === 'unavailable')) {
            return { status: 503, reason: 'The blockchain couldn’t be reached. Try again in a few minutes.' };
        }
        if (openFindings.length) {
            const f = openFindings[0];
            return { status: 409, reason: `The finding on ${f.edrmsNo ?? `${f.recordNo} version ${f.recordVersion}`} is still open. The audit can’t be signed off until it is resolved by a corrected version, or an auditor closes it as resolved by agreement.` };
        }
        return null;
    }

    /**
     * A changed item: the records officers and the registrars get a re-review task, once per item.
     * Returns the alert (with `foundAt`), or null when bpm cannot be reached (tried again at the next
     * check; the checkpoint stays refused either way).
     */
    async alertChanged(record, item) {
        const known = await this.repo.getAlert(item.key);
        if (known) return known;
        const about = item.kind === 'record-version'
            ? `${record.recordNo} (${record.label}) version ${item.versionNumber}`
            : `${item.edrmsNo} version ${item.version} in ${record.recordNo} (${record.label})`;
        let instance;
        try {
            instance = await this.bpm.start({
                alert: { key: item.key, about, message: CHANGED_SINCE_REVIEW },
                record: { id: record.id, recordNo: record.recordNo, label: record.label }
            }, 'audit-rereview');
        } catch (err) {
            this.logger.warn?.({ key: item.key, err: err.message }, 'audit: the re-review task for a changed item could not be started; tried again at the next check');
            return null;
        }
        const alert = { key: item.key, recordId: record.id, recordNo: record.recordNo, versionNumber: item.versionNumber ?? null,
            documentId: item.documentId ?? null, edrmsNo: item.edrmsNo ?? null, documentVersion: item.version ?? null,
            currentVersion: record.currentVersion, instanceId: instance?.id ?? null, foundAt: this.clock() };
        await this.atomic(async () => {
            if (!(await this.repo.createAlert(alert))) return;            // found by another check at the same moment
            await this.events.publish('audit.item.changed', {
                recordId: record.id, recordNo: record.recordNo, versionNumber: alert.versionNumber ?? undefined,
                edrmsDocumentId: alert.documentId ?? undefined, edrmsNo: alert.edrmsNo ?? undefined, documentVersion: alert.documentVersion ?? undefined,
                key: item.key, message: CHANGED_SINCE_REVIEW, instanceId: alert.instanceId ?? undefined
            }, { actor: { id: null, name: 'System' } });
        });
        return (await this.repo.getAlert(item.key)) ?? alert;
    }

    /**
     * One audit sign-off for the open checkpoint of a land record. The checkpoint is checked again now;
     * the screen's view of it is never trusted. One sign-off per checkpoint, also for two requests at
     * the same moment.
     */
    async signOff({ recordId, comment }, actor) {
        const text = comment === undefined || comment === null ? null : String(comment).trim() || null;
        const c = await this.checkpoint(recordId, actor);
        if (c.refusal) {
            if (c.refusal.status === 403) throw new ForbiddenError(c.refusal.reason, { rule: c.refusal.rule });
            if (c.refusal.status === 503) throw new AppError(503, c.refusal.reason);
            throw new ConflictError(c.refusal.reason);
        }
        const top = c.versions.at(-1);
        const row = {
            id: randomUUID(), kind: 'checkpoint', recordId, recordNo: c.recordNo,
            recordVersion: top.versionNumber, fromVersion: c.range.from, toVersion: c.range.to, seal: top.seal,
            documentId: null, edrmsNo: null, documentVersion: null,
            items: {
                versions: c.versions.map(v => ({ version: v.versionNumber, seal: v.seal, match: v.match, ...(v.superseded ? { superseded: true } : {}) })),
                documents: c.documents.map(d => ({ documentId: d.documentId, edrmsNo: d.edrmsNo, version: d.version, seal: d.seal, match: d.match, ...(d.superseded ? { superseded: true } : {}) })),
                findings: await this.findingsInRange(recordId, c)
            },
            comment: text, signedById: actor.id, signedByName: actor.name ?? null, signedAt: this.clock()
        };
        await this.atomic(async () => {
            if (!(await this.repo.createSignoff(row))) throw new ConflictError('This audit has just been signed off by someone else.');
            await this.events.publish('audit.signoff.recorded', {
                signoffId: row.id, kind: 'checkpoint', recordId, recordNo: row.recordNo, versionNumber: row.recordVersion,
                fromVersion: row.fromVersion, toVersion: row.toVersion, seal: row.seal, comment: text, findings: row.items.findings
            }, { actor });
        });
        return row;
    }

    /** The ids of the findings raised on the checkpoint's versions and documents (they live in the trail). */
    async findingsInRange(recordId, c) {
        const onRecord = (await this.repo.listFindings({ recordId })).filter(f => f.recordVersion >= c.range.from && f.recordVersion <= c.range.to);
        const ids = new Set(onRecord.map(f => f.id));
        for (const d of c.documents) {
            for (const f of await this.repo.listFindings({ documentId: d.documentId })) {
                if (!f.recordId && f.documentVersion === d.version) {
                    ids.add(f.id);
                }
            }
        }
        return [...ids];
    }

    listSignoffs(filter) { return this.repo.listSignoffs(filter); }

    // ------------------------------------------------ findings

    async raiseFinding({ recordId, version, documentId, description }, actor) {
        const text = String(description ?? '').trim();
        if (text.length < 5) throw new BadRequestError('Describe the finding (at least a few words)');
        const t = await this.target({ recordId, version, documentId });
        // on the current version: an older one is already superseded by a reviewed version
        const current = documentId && !recordId ? t.document.currentVersion : t.record ? t.record.currentVersion : null;
        if (current && Number(version) < current) {
            throw new ConflictError(`Version ${version} has been replaced by version ${current}: raise the finding on the current version`);
        }
        // a document in it that edrms has corrected since: the finding belongs on the corrected version
        if (t.document && t.document.currentVersion > t.documentVersion.versionNumber) {
            throw new ConflictError(`${t.document.edrmsNo} version ${t.documentVersion.versionNumber} has been corrected (version ${t.document.currentVersion}): raise the finding on the current version`);
        }
        const item = SignoffService.itemOf(t);
        const id = randomUUID();
        // the records desk is told first: a finding nobody was told about is not raised
        const variables = {
            finding: { id, description: text, about: SignoffService.about(t) },
            ...(t.record ? { record: { id: t.record.id, recordNo: t.record.recordNo, label: t.record.label, versionNumber: item.recordVersion } } : {}),
            ...(t.document ? { document: { id: t.document.id, edrmsNo: t.document.edrmsNo, title: t.document.title, currentVersion: item.documentVersion } } : {}),
            raisedBy: { id: actor.id, name: actor.name ?? '' }
        };
        const instance = await this.bpm.start(variables);
        if (!instance?.id) throw new AppError(502, 'The records desk\'s inbox gave no answer about the finding: try again');
        const row = { id, ...item, description: text, status: 'open', raisedById: actor.id, raisedByName: actor.name ?? null, raisedAt: this.clock(), instanceId: instance.id, answers: [] };
        try {
            await this.atomic(async () => {
                await this.repo.createFinding(row);
                await this.events.publish('audit.finding.raised', { findingId: id, ...SignoffService.eventItem(item), description: text, instanceId: instance.id, Findings: [SignoffService.findingRecord(row)] }, { actor });
            });
        } catch (err) {
            await this.withdraw(row, 'the finding could not be recorded');
            throw err;
        }
        // a newer version committed while it was being raised (its event may already have been read)
        const newer = await this.newerVersion(row).catch(() => null);
        if (newer) {
            await this.onEvent(row.documentId && !row.recordId
                ? { type: 'edrms.document.amended', data: { documentId: row.documentId, version: newer } }
                : { type: 'records.record.committed', data: { recordId: row.recordId, versionNumber: newer } });
            return { ...row, ...(await this.repo.getFinding(row.id)) };
        }
        return row;
    }

    listFindings(filter) { return this.repo.listFindings(filter); }

    async getFinding(id) {
        const f = await this.repo.getFinding(id);
        if (!f) throw new NotFoundError('No such finding');
        return f;
    }

    /**
     * A finding as its trail entries carry it under the key `Findings`: who raised it and why, every
     * answer, and how it ended.
     */
    static findingRecord(f) {
        const at = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
        return {
            id: f.id, status: f.status, outcome: f.outcome ?? null,
            recordId: f.recordId ?? null, recordNo: f.recordNo ?? null, recordVersion: f.recordVersion ?? null,
            documentId: f.documentId ?? null, edrmsNo: f.edrmsNo ?? null, documentVersion: f.documentVersion ?? null,
            raisedBy: { id: f.raisedById, name: f.raisedByName ?? null, at: at(f.raisedAt) },
            issue: f.description,
            answers: (f.answers || []).map(a => ({ id: a.byId, name: a.byName ?? null, role: a.role ?? null, at: at(a.at), text: a.text })),
            ...(f.status === 'closed' ? { closedBy: { id: f.closedById, name: f.closedByName ?? null, at: at(f.closedAt) }, answer: f.closeReason } : {}),
            ...(f.status === 'resolved' ? { resolvedByVersion: f.resolvedByVersion, resolvedAt: at(f.closedAt) } : {})
        };
    }

    /** An auditor answers an open finding: the answer joins its thread, with who wrote it and when. */
    async answerFinding(id, { text }, actor) {
        const answerText = String(text ?? '').trim();
        if (answerText.length < 3) throw new BadRequestError('Write your answer');
        const f = await this.getFinding(id);
        const answer = { byId: actor.id, byName: actor.name ?? null, role: 'Auditor', at: this.clock(), text: answerText };
        await this.atomic(async () => {
            if (!(await this.repo.addAnswer(id, answer))) throw new ConflictError(`The finding is already ${(await this.repo.getFinding(id))?.status ?? f.status}`);
            const updated = { ...f, answers: [...(f.answers || []), answer] };
            await this.events.publish('audit.finding.answered', { findingId: id, ...SignoffService.eventItem(f), answer: answerText, Findings: [SignoffService.findingRecord(updated)] }, { actor });
        });
        return this.getFinding(id);
    }

    /**
     * An auditor closes an open finding, answering it: resolved by agreement outside the portal
     * (`agreed`, the agreed exception) or raised by mistake (`mistake`). Today's `{ reason }` alone is
     * read as `{ outcome: 'mistake', answer: reason }`.
     */
    async closeFinding(id, { outcome, answer, reason }, actor) {
        const text = String(answer ?? reason ?? '').trim();
        if (text.length < 3) throw new BadRequestError('Answer the finding: say why it is closed');
        if (answer === undefined && outcome === undefined) {
            outcome = 'mistake';                                   // API-659's { reason }: closed, no change needed
        }
        if (!CLOSE_OUTCOMES.includes(outcome)) throw new BadRequestError(`How was it closed? Use ${CLOSE_OUTCOMES.join(' or ')}`);
        const f = await this.getFinding(id);
        const patch = { status: 'closed', outcome, closedById: actor.id, closedByName: actor.name ?? null, closeReason: text, closedAt: this.clock() };
        await this.atomic(async () => {
            if (!(await this.repo.updateOpenFinding(id, patch))) throw new ConflictError(`The finding is already ${(await this.repo.getFinding(id))?.status ?? f.status}`);
            await this.events.publish('audit.finding.closed', {
                findingId: id, ...SignoffService.eventItem(f), outcome, reason: text, instanceId: f.instanceId ?? undefined,
                Findings: [SignoffService.findingRecord({ ...f, ...patch })]
            }, { actor });
        });
        await this.withdraw(f, `closed by ${actor.name ?? 'an auditor'}: ${text}`);
        return { ...f, ...patch };
    }

    /**
     * The consumer's handler (after the trail and the tree): a newer reviewed version resolves the open
     * findings on older versions of the same land record (records.record.committed) or document
     * (edrms.document.amended: an approved correction). A redelivered event finds them resolved.
     */
    async onEvent(event) {
        const d = event?.data || {};
        let open = [], by = null;
        if (event?.type === 'records.record.committed' && d.recordId && d.versionNumber) {
            by = d.versionNumber;
            open = (await this.repo.listFindings({ recordId: d.recordId, status: 'open' })).filter(f => !f.documentId && f.recordVersion < by);
        } else if (event?.type === 'edrms.document.amended' && d.documentId && d.version) {
            by = d.version;
            open = (await this.repo.listFindings({ documentId: d.documentId, status: 'open' })).filter(f => f.documentVersion < by);
        }
        for (const f of open) {
            const patch = { status: 'resolved', resolvedByVersion: by, closedAt: this.clock() };
            let resolved = false;
            await this.atomic(async () => {
                resolved = await this.repo.updateOpenFinding(f.id, patch);
                if (resolved) {
                    await this.events.publish('audit.finding.closed', { findingId: f.id, ...SignoffService.eventItem(f), outcome: 'resolved', resolvedByVersion: by, instanceId: f.instanceId ?? undefined, Findings: [SignoffService.findingRecord({ ...f, ...patch })] },
                        { actor: { id: null, name: 'System' } });
                }
            });
            if (resolved) await this.withdraw(f, `resolved by version ${by}`);
        }
        return open.length;
    }

    /** A version of the finding's record (or document) newer than the one it is on, or null. */
    async newerVersion(f) {
        if (f.recordId && !f.documentId) {
            const { record } = await this.sources.record(f.recordId, f.recordVersion);
            return record.currentVersion > f.recordVersion ? record.currentVersion : null;
        }
        const doc = await this.sources.document(f.documentId);
        return doc.currentVersion > f.documentVersion ? doc.currentVersion : null;
    }

    /**
     * The finding's process, if still open: withdrawn. Best effort: an acknowledged one has ended; if
     * bpm cannot be reached the tasks stay in the inbox until acknowledged (the finding is closed).
     */
    async withdraw(f, reason) {
        if (!f.instanceId) return;
        try { await this.bpm.cancel(f.instanceId, reason); } catch (err) {
            this.logger.warn?.({ findingId: f.id, instanceId: f.instanceId, err: err.message }, 'audit: the finding\'s task could not be withdrawn; it stays in the inbox until acknowledged');
        }
    }
}

/** land-records, edrms and bpm, over HTTP with the audit service's token. */
export function createSignoffClients({ recordsUrl, edrmsUrl, bpmUrl, serviceToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    async function call(url, what, { method = 'GET', body, timeoutMs: limit = timeoutMs } = {}) {
        let res;
        try {
            res = await fetchImpl(url, {
                method, headers: { authorization: `Bearer ${serviceToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(limit)
            });
        } catch (err) {
            throw new AppError(503, `The ${what} cannot be reached: ${err.message}`);
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: reported by status */ }
        return { status: res.status, json };
    }
    const read = async (url, what) => {
        const { status, json } = await call(url, what);
        if (status === 404) throw new NotFoundError(json?.message || 'Not found');
        if (status >= 400 || !json) throw new AppError(502, `Reading from the ${what} failed (${status}): ${json?.message || 'no detail'}`);
        return json;
    };
    return {
        sources: {
            async record(recordId, n) {
                const [record, version] = await Promise.all([read(`${recordsUrl}/records/${recordId}`, 'land records service'), read(`${recordsUrl}/records/${recordId}/versions/${n}`, 'land records service')]);
                return { record, version };
            },
            recordInfo: (recordId) => read(`${recordsUrl}/records/${recordId}`, 'land records service'),
            version: (recordId, n) => read(`${recordsUrl}/records/${recordId}/versions/${n}`, 'land records service'),
            document: (documentId) => read(`${edrmsUrl}/documents/${documentId}`, 'document service')
        },
        bpm: {
            async start(variables, process = 'audit-finding') {
                const { status, json } = await call(`${bpmUrl}/processes/${process}/instances`, 'task inbox (bpm)', { method: 'POST', body: { variables } });
                if (status >= 400) throw new AppError(502, `The task could not be sent to the records desk's inbox (${status}): ${json?.message || 'no detail'}`);
                return json;
            },
            async cancel(instanceId, reason) {
                // short: it can run in the trail's consumer, which must not wait long on bpm
                const { status, json } = await call(`${bpmUrl}/instances/${instanceId}/cancel`, 'task inbox (bpm)', { method: 'POST', body: { reason }, timeoutMs: 5000 });
                if (status === 404 || status === 409) return null;          // acknowledged (ended) or gone
                if (status >= 400) throw new AppError(502, json?.message || `Withdrawing the finding's task failed (${status})`);
                return json;
            }
        }
    };
}
