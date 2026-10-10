import { randomUUID } from 'node:crypto';
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@lrfe/common';

/**
 * Sign-off and findings (README.md section 5; API-659). An auditor (`audit.signoff`):
 *
 *   signOff(target, comment)       marks a committed land record version, or a document version pinned
 *                                  in it, audited. Refused for whoever approved that version (sod2).
 *   raiseFinding(target, text)     a finding on a land record version or a document version; the records
 *                                  officers and the registrars get it in their task inbox (bpm process
 *                                  "audit-finding"). Open until a newer reviewed version resolves it
 *                                  (onEvent) or an auditor closes it with a reason (closeFinding).
 *
 * Each is stored here and published as a durable event in the same transaction, so it becomes a trail
 * entry and, at the next anchoring, part of the root on Cardano.
 *
 * `sources`: { record(recordId, n) → { record, version }, document(documentId) → document with versions }
 * read from land-records and edrms with the audit service's token; `bpm`: { start(variables), cancel(id, reason) }.
 */
export class SignoffService {
    constructor({ repo, events, sources, bpm, clock = () => new Date(), logger = console }) {
        this.repo = repo;
        this.events = events;
        this.sources = sources;
        this.bpm = bpm;
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

    // ------------------------------------------------ sign-off

    async signOff({ recordId, version, documentId, comment }, actor) {
        const text = String(comment ?? '').trim();
        if (!text) throw new BadRequestError('Say what you checked: a sign-off needs a comment');
        const t = await this.target({ recordId, version, documentId }, { recordRequired: true });
        // segregation of duties (sod2): whoever can finalize land records does not sign them off, and the
        // approver of a version never signs it off, whatever the roles say
        if ((actor.perms || []).includes('record.finalize')) {
            throw new ForbiddenError('You can finalize land records: an auditor without that permission must sign it off', { rule: 'sod2' });
        }
        if (t.recordVersion.approvedById && t.recordVersion.approvedById === actor.id) {
            throw new ForbiddenError('You approved this version: another auditor must sign it off', { rule: 'sod2' });
        }
        if (t.documentVersion?.approvedById && t.documentVersion.approvedById === actor.id) {
            throw new ForbiddenError('You approved this document version: another auditor must sign it off', { rule: 'sod2' });
        }
        const item = SignoffService.itemOf(t);
        const earlier = await this.repo.listSignoffs({ recordId: item.recordId });
        if (earlier.some(s => s.signedById === actor.id && s.recordVersion === item.recordVersion && (s.documentId ?? null) === item.documentId)) {
            throw new ConflictError('You have already signed this off');
        }
        const row = { id: randomUUID(), ...item, comment: text, signedById: actor.id, signedByName: actor.name ?? null, signedAt: this.clock() };
        await this.atomic(async () => {
            if (!(await this.repo.createSignoff(row))) throw new ConflictError('You have already signed this off');
            await this.events.publish('audit.signoff.recorded', { signoffId: row.id, ...SignoffService.eventItem(item), comment: text }, { actor });
        });
        return row;
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
        const row = { id, ...item, description: text, status: 'open', raisedById: actor.id, raisedByName: actor.name ?? null, raisedAt: this.clock(), instanceId: instance.id };
        try {
            await this.atomic(async () => {
                await this.repo.createFinding(row);
                await this.events.publish('audit.finding.raised', { findingId: id, ...SignoffService.eventItem(item), description: text, instanceId: instance.id }, { actor });
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

    /** An auditor closes an open finding, with a reason. */
    async closeFinding(id, { reason }, actor) {
        const text = String(reason ?? '').trim();
        if (text.length < 3) throw new BadRequestError('Say why the finding is closed');
        const f = await this.getFinding(id);
        const patch = { status: 'closed', closedById: actor.id, closedByName: actor.name ?? null, closeReason: text, closedAt: this.clock() };
        await this.atomic(async () => {
            if (!(await this.repo.updateOpenFinding(id, patch))) throw new ConflictError(`The finding is already ${(await this.repo.getFinding(id))?.status ?? f.status}`);
            await this.events.publish('audit.finding.closed', { findingId: id, ...SignoffService.eventItem(f), outcome: 'closed', reason: text, instanceId: f.instanceId ?? undefined }, { actor });
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
                    await this.events.publish('audit.finding.closed', { findingId: f.id, ...SignoffService.eventItem(f), outcome: 'resolved', resolvedByVersion: by, instanceId: f.instanceId ?? undefined },
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
            document: (documentId) => read(`${edrmsUrl}/documents/${documentId}`, 'document service')
        },
        bpm: {
            async start(variables) {
                const { status, json } = await call(`${bpmUrl}/processes/audit-finding/instances`, 'task inbox (bpm)', { method: 'POST', body: { variables } });
                if (status >= 400) throw new AppError(502, `The finding could not be sent to the records desk's inbox (${status}): ${json?.message || 'no detail'}`);
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
