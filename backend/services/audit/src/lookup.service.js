import { AppError, BadRequestError } from '@lrfe/common';
import { createServiceClient } from './service-client.js';

/** At most this many land records to choose from when a search matches several. */
const MAX_CHOICES = 20;
/** Searches one user may run per minute. */
const SEARCHES_PER_MINUTE = 30;
/** Audit sign-offs of one land record read for its history. */
const MAX_SIGNOFFS = 200;

const LAND_RECORD_NO = /^LR-/i;
const DOCUMENT_NO = /^EDR-/i;
/** A deed or other instrument number: T 2210/2008, A 412/2007, B 3301/2015 (spaces around the slash allowed). */
const INSTRUMENT_NO = /^[A-Z]{1,3}\s?\d{1,7}\s?\/\s?\d{4}$/i;

/** What a search names: a land record number, a document number, an instrument number, or words (Erf, township). */
export function classify(q) {
    if (LAND_RECORD_NO.test(q)) return 'recordNo';
    if (DOCUMENT_NO.test(q)) return 'edrmsNo';
    if (INSTRUMENT_NO.test(q)) return 'instrument';
    return 'words';
}

const recordKey = (recordId, versionNumber) => `record-version:${recordId}:${versionNumber}`;
const documentKey = (documentId, version) => `document-version:${documentId}:${version}`;
const isCommitted = (v) => v.state === 'committed' || v.state === 'superseded';
const newestFirst = (x, y) => new Date(y.at ?? 0) - new Date(x.at ?? 0);

/**
 * "Is it on the blockchain?" (API-697): find a land record or a document by number, Erf or deed
 * number, and answer in plain terms, with its history of batches. For a land record the answer is
 * its current version's: that version's seal stands for its documents and every version before it.
 * Numbers match exactly; words may match several land records, which are then offered to choose
 * from. Every signed-in user may search (`anchors.view`), within a limit per minute.
 *
 * `sources`: from land-records { records({ q, limit }) (committed land records matched on number and
 * parcel only), versions(recordId), lookup(body) }, and from edrms { documentByNumber({ edrmsNo |
 * instrumentRef }), document(id) }.
 */
export class AnchorLookupService {
    constructor({ repo, proofs, anchorings, sources, clock = () => new Date() }) {
        this.repo = repo;
        this.proofs = proofs;
        this.anchorings = anchorings;
        this.sources = sources;
        this.clock = clock;
        this.recent = new Map();                   // user id → times of their searches in the last minute
    }

    async search(query, userId) {
        this.limitRate(userId);
        const q = String(query ?? '').trim().replace(/\s+/g, ' ');
        if (!q) throw new BadRequestError('Give a land record number, document number, Erf or deed number');
        const kind = classify(q);
        if (kind === 'edrmsNo' || kind === 'instrument') {
            const found = await this.sources.documentByNumber(kind === 'edrmsNo' ? { edrmsNo: q.toUpperCase() } : { instrumentRef: q });
            return found ? this.documentResult(q, found.id) : { query: q, kind: 'none' };
        }
        // committed land records, by number or parcel only: never by an owner's name or ID number
        const { items } = await this.sources.records({ q, limit: MAX_CHOICES + 1 });
        let matches = items.filter(r => r.currentVersion);
        if (kind === 'recordNo') matches = matches.filter(r => r.recordNo.toUpperCase() === q.toUpperCase());
        if (!matches.length) return { query: q, kind: 'none' };
        if (matches.length > 1) {
            return { query: q, kind: 'choices', choices: matches.slice(0, MAX_CHOICES).map(r => ({ recordId: r.id, recordNo: r.recordNo, label: r.label })) };
        }
        return this.recordResult(q, matches[0]);
    }

    /** A land record: the answer for its current version, and its versions, documents and audit sign-offs, newest first. */
    async recordResult(q, record) {
        const committed = (await this.sources.versions(record.id)).filter(isCommitted).sort((x, y) => y.versionNumber - x.versionNumber);
        const { versions: made } = await this.sources.lookup({ versions: committed.map(v => ({ recordId: record.id, versionNumber: v.versionNumber })) });
        const documents = new Map();
        for (const v of made) {
            for (const d of v.documents) documents.set(documentKey(d.id, d.version), d);
        }
        const versionKeys = committed.map(v => recordKey(record.id, v.versionNumber));
        const batches = await this.proofs.batchOf([...versionKeys, ...documents.keys()]);
        const { entries: signoffs } = await this.repo.list({ subjects: [`record:${record.id}`], type: 'audit.signoff.recorded' }, { limit: MAX_SIGNOFFS, offset: 0 });

        const history = [
            ...committed.map(v => versionItem(v, batches[recordKey(record.id, v.versionNumber)])),
            ...[...documents].map(([key, d]) => documentItem(d, batches[key])),
            ...await Promise.all(signoffs.map(async (e) => signoffItem(e, await this.proofs.entryBatch(e.seq))))
        ].sort(newestFirst);
        const current = committed[0];
        return {
            query: q,
            kind: 'record',
            record: { id: record.id, recordNo: record.recordNo, label: record.label, currentVersion: current?.versionNumber ?? null, committedAt: current?.committedAt ?? null },
            answer: await this.answer(current ? batches[recordKey(record.id, current.versionNumber)] : null, current?.versionNumber ?? null),
            history
        };
    }

    /** A document: the answer for its current version, its versions, and the land record versions made of it, newest first. */
    async documentResult(q, documentId) {
        const doc = await this.sources.document(documentId);
        const { pinnedBy, records } = await this.sources.lookup({ pinning: [documentId] });
        const labels = new Map(records.map(r => [r.id, r]));
        const keys = [...doc.versions.map(v => documentKey(documentId, v.versionNumber)), ...pinnedBy.map(p => recordKey(p.recordId, p.versionNumber))];
        const batches = await this.proofs.batchOf([...new Set(keys)]);
        const history = [
            ...doc.versions.map(v => ({ kind: 'document', version: v.versionNumber, at: v.createdAt, ...statusAndBatch(batches[documentKey(documentId, v.versionNumber)]) })),
            ...pinnedBy.map(p => usedInItem(p, labels.get(p.recordId), batches[recordKey(p.recordId, p.versionNumber)]))
        ].sort(newestFirst);
        return {
            query: q,
            kind: 'document',
            document: { id: doc.id, edrmsNo: doc.edrmsNo, docType: doc.docType, ref: doc.instrumentRef ?? null, currentVersion: doc.currentVersion },
            answer: await this.answer(batches[documentKey(documentId, doc.currentVersion)], doc.currentVersion),
            history
        };
    }

    /**
     * The plain answer for the current version: `yes` (in a block, or confirmed), `sent` (on its
     * way), `waiting` (with when the next batch is due), or `notRecorded` (no fingerprint recorded:
     * no committed version yet, or not in the audit tree).
     */
    async answer(batch, version) {
        if (!batch) return { status: 'notRecorded', version };
        if (batch.status === 'onChain' || batch.status === 'confirmed') return { status: 'yes', version, batch: batch.batch };
        if (batch.status === 'sent') return { status: 'sent', version, batch: batch.batch };
        const next = await this.anchorings.next();
        return { status: 'waiting', version, nextDueAt: next?.dueAt ?? null };
    }

    /** 429 after SEARCHES_PER_MINUTE searches by one user within a minute. Users idle for a minute are forgotten. */
    limitRate(userId) {
        const now = this.clock().getTime();
        for (const [user, times] of this.recent) {
            if (now - times.at(-1) >= 60_000) this.recent.delete(user);
        }
        const recent = (this.recent.get(userId) ?? []).filter(t => now - t < 60_000);
        if (recent.length >= SEARCHES_PER_MINUTE) throw new AppError(429, 'Too many searches. Try again in a minute.');
        recent.push(now);
        this.recent.set(userId, recent);
    }
}

/** An item's status and batch, for the history; `notRecorded` when it is not in the audit tree. */
function statusAndBatch(batch) {
    return batch ? { status: batch.status, batch: batch.batch } : { status: 'notRecorded', batch: null };
}

/** A committed land record version in its history. */
function versionItem(v, batch) {
    return { kind: 'version', versionNumber: v.versionNumber, at: v.committedAt, ...statusAndBatch(batch) };
}

/** A document a land record version is made of, in the record's history. */
function documentItem(d, batch) {
    return {
        kind: 'document', documentId: d.id, version: d.version, edrmsNo: d.edrmsNo, docType: d.docType, ref: d.ref,
        at: batch?.sealedAt ?? null, ...statusAndBatch(batch)
    };
}

/** An audit sign-off (its trail entry) in the record's history. */
function signoffItem(entry, batch) {
    const { fromVersion, toVersion, recordVersion } = entry.data;
    return { kind: 'signoff', from: fromVersion ?? recordVersion, to: toVersion ?? recordVersion, at: entry.time, ...batch };
}

/** A land record version made of the document, in the document's history. */
function usedInItem(pin, label, batch) {
    return {
        kind: 'usedIn', recordId: pin.recordId, recordNo: label?.recordNo ?? null, label: label?.label ?? null,
        versionNumber: pin.versionNumber, documentVersion: pin.version, at: batch?.sealedAt ?? null, ...statusAndBatch(batch)
    };
}

/** The land-records and edrms reads of the search (with the audit service's token). */
export function createLookupSources({ recordsUrl, edrmsUrl, serviceToken, fetchImpl, timeoutMs }) {
    const request = createServiceClient({ serviceToken, fetchImpl, timeoutMs });
    const records = { name: 'land records service' }, edrms = { name: 'document service' };
    return {
        // committed land records, matched on number and parcel only (never owners)
        records: ({ q, limit }) => request(`${recordsUrl}/records?${new URLSearchParams({ q, status: 'committed', match: 'parcel', limit: String(limit) })}`, records),
        versions: (recordId) => request(`${recordsUrl}/records/${recordId}/versions`, records),
        lookup: (body) => request(`${recordsUrl}/records/lookup`, { ...records, method: 'POST', body }),
        documentByNumber: (by) => request(`${edrmsUrl}/documents/lookup?${new URLSearchParams(by)}`, { ...edrms, notFound: null }),
        document: (id) => request(`${edrmsUrl}/documents/${id}`, edrms)
    };
}
