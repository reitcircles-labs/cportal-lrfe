import {AppError, BadRequestError} from '@lrfe/common';
import {auditWording, recordKindOf} from './domain.js';
import {createServiceClient} from './service-client.js';
import {recordClientAt, recordServiceLabel} from './record-service.js';

/** At most this many records to choose from when a search matches several. */
const MAX_CHOICES = 20;
/** Searches one user may run per minute. */
const SEARCHES_PER_MINUTE = 30;
/** Audit sign-offs of one record read for its history. */
const MAX_SIGNOFFS = 200;

/** An EDRMS document number: EDR-NA-2026-000412. */
const DOCUMENT_NO = /^EDR-/i;

/**
 * What a search names: a record number, a document number, an instrument number (as the domain
 * pack's record kind recognises record and instrument numbers), or words (`none` without a record
 * kind: then only document numbers can be looked up).
 * @param {string} q the search
 * @param {import('@lrfe/domain-pack').DomainPack=} pack
 * @return {string} recordNo | edrmsNo | instrument | words | none
 */
export function classify(q, pack) {
  const kind = recordKindOf(pack);
  if (kind?.lookup.recordNumber?.test(q)) {
    return 'recordNo';
  }
  if (DOCUMENT_NO.test(q)) {
    return 'edrmsNo';
  }
  if (kind?.lookup.instrumentNumber?.test(q)) {
    return 'instrument';
  }
  return kind ? 'words' : 'none';
}

const recordKey = (recordId, versionNumber) =>
  `record-version:${recordId}:${versionNumber}`;
const documentKey = (documentId, version) =>
  `document-version:${documentId}:${version}`;
const isCommitted = v => v.state === 'committed' || v.state === 'superseded';
const newestFirst = (x, y) => new Date(y.at ?? 0) - new Date(x.at ?? 0);

/**
 * "Is it on the blockchain?" (API-697): find a record or a document by number (or other words the
 * product service matches a record on), and answer in plain terms, with its history of batches. For
 * a record the answer is its current version's: that version's seal stands for its documents and
 * every version before it. Numbers match exactly; words may match several records, which are then
 * offered to choose from. Every signed-in user may search (`anchors.view`), within a limit per minute.
 * Without a record kind in the domain pack, only documents are looked up.
 *
 * `sources`: from the product service { records({ q, limit }) (committed records matched on number
 * and the like, never on people), versions(recordId), lookup(body) }, and from edrms
 * { documentByNumber({ edrmsNo | instrumentRef }), document(id) }.
 */
export class AnchorLookupService {
  /** @param pack the domain pack (default: the install's): how numbers are recognised (CB-3) */
  constructor({
    repo,
    proofs,
    anchorings,
    sources,
    clock = () => new Date(),
    pack,
  }) {
    this.repo = repo;
    this.proofs = proofs;
    this.anchorings = anchorings;
    this.sources = sources;
    this.clock = clock;
    this.pack = pack;
    this.recent = new Map(); // user id → times of their searches in the last minute
  }

  async search(query, userId) {
    this.limitRate(userId);
    const q = String(query ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!q) {
      throw new BadRequestError(auditWording(this.pack).lookupHint);
    }
    const kind = classify(q, this.pack);
    if (kind === 'none') {
      return {query: q, kind: 'none'};
    }
    if (kind === 'edrmsNo' || kind === 'instrument') {
      const found = await this.sources.documentByNumber(
        kind === 'edrmsNo' ? {edrmsNo: q.toUpperCase()} : {instrumentRef: q},
      );
      return found
        ? this.documentResult(q, found.id)
        : {query: q, kind: 'none'};
    }
    // committed records, matched by the product service on number and the like: never on people
    const {items} = await this.sources.records({q, limit: MAX_CHOICES + 1});
    let matches = items.filter(r => r.currentVersion);
    if (kind === 'recordNo') {
      matches = matches.filter(
        r => r.recordNo.toUpperCase() === q.toUpperCase(),
      );
    }
    if (!matches.length) return {query: q, kind: 'none'};
    if (matches.length > 1) {
      return {
        query: q,
        kind: 'choices',
        choices: matches
          .slice(0, MAX_CHOICES)
          .map(r => ({recordId: r.id, recordNo: r.recordNo, label: r.label})),
      };
    }
    return this.recordResult(q, matches[0]);
  }

  /** A record: the answer for its current version, and its versions, documents and audit sign-offs, newest first. */
  async recordResult(q, record) {
    const committed = (await this.sources.versions(record.id))
      .filter(isCommitted)
      .sort((x, y) => y.versionNumber - x.versionNumber);
    const {versions: made} = await this.sources.lookup({
      versions: committed.map(v => ({
        recordId: record.id,
        versionNumber: v.versionNumber,
      })),
    });
    const documents = new Map();
    for (const v of made) {
      for (const d of v.documents) {
        documents.set(documentKey(d.id, d.version), d);
      }
    }
    const versionKeys = committed.map(v =>
      recordKey(record.id, v.versionNumber),
    );
    const batches = await this.proofs.batchOf([
      ...versionKeys,
      ...documents.keys(),
    ]);
    const {entries: signoffs} = await this.repo.list(
      {subjects: [`record:${record.id}`], type: 'audit.signoff.recorded'},
      {limit: MAX_SIGNOFFS, offset: 0},
    );

    const history = [
      ...committed.map(v =>
        versionItem(v, batches[recordKey(record.id, v.versionNumber)]),
      ),
      ...[...documents].map(([key, d]) => documentItem(d, batches[key])),
      ...(await Promise.all(
        signoffs.map(async e =>
          signoffItem(e, await this.proofs.entryBatch(e.seq)),
        ),
      )),
    ].sort(newestFirst);
    const current = committed[0];
    return {
      query: q,
      kind: 'record',
      record: {
        id: record.id,
        recordNo: record.recordNo,
        label: record.label,
        currentVersion: current?.versionNumber ?? null,
        committedAt: current?.committedAt ?? null,
      },
      answer: await this.answer(
        current ? batches[recordKey(record.id, current.versionNumber)] : null,
        current?.versionNumber ?? null,
      ),
      history,
    };
  }

  /** A document: the answer for its current version, its versions, and the record versions made of it, newest first. */
  async documentResult(q, documentId) {
    const doc = await this.sources.document(documentId);
    const {pinnedBy, records} = await this.sources.lookup({
      pinning: [documentId],
    });
    const labels = new Map(records.map(r => [r.id, r]));
    const keys = [
      ...doc.versions.map(v => documentKey(documentId, v.versionNumber)),
      ...pinnedBy.map(p => recordKey(p.recordId, p.versionNumber)),
    ];
    const batches = await this.proofs.batchOf([...new Set(keys)]);
    const history = [
      ...doc.versions.map(v => ({
        kind: 'document',
        version: v.versionNumber,
        at: v.createdAt,
        ...statusAndBatch(batches[documentKey(documentId, v.versionNumber)]),
      })),
      ...pinnedBy.map(p =>
        usedInItem(
          p,
          labels.get(p.recordId),
          batches[recordKey(p.recordId, p.versionNumber)],
        ),
      ),
    ].sort(newestFirst);
    return {
      query: q,
      kind: 'document',
      document: {
        id: doc.id,
        edrmsNo: doc.edrmsNo,
        docType: doc.docType,
        ref: doc.instrumentRef ?? null,
        currentVersion: doc.currentVersion,
      },
      answer: await this.answer(
        batches[documentKey(documentId, doc.currentVersion)],
        doc.currentVersion,
      ),
      history,
    };
  }

  /**
   * The plain answer for the current version: `yes` (in a block, or confirmed), `sent` (on its
   * way), `waiting` (with when the next batch is due), or `notRecorded` (no fingerprint recorded:
   * no committed version yet, or not in the audit tree).
   */
  async answer(batch, version) {
    if (!batch) return {status: 'notRecorded', version};
    if (batch.status === 'onChain' || batch.status === 'confirmed') {
      return {status: 'yes', version, batch: batch.batch};
    }
    if (batch.status === 'sent') {
      return {status: 'sent', version, batch: batch.batch};
    }
    const next = await this.anchorings.next();
    return {status: 'waiting', version, nextDueAt: next?.dueAt ?? null};
  }

  /** 429 after SEARCHES_PER_MINUTE searches by one user within a minute. Users idle for a minute are forgotten. */
  limitRate(userId) {
    const now = this.clock().getTime();
    for (const [user, times] of this.recent) {
      if (now - times.at(-1) >= 60_000) this.recent.delete(user);
    }
    const recent = (this.recent.get(userId) ?? []).filter(
      t => now - t < 60_000,
    );
    if (recent.length >= SEARCHES_PER_MINUTE) {
      throw new AppError(429, 'Too many searches. Try again in a minute.');
    }
    recent.push(now);
    this.recent.set(userId, recent);
  }
}

/** An item's status and batch, for the history; `notRecorded` when it is not in the audit tree. */
function statusAndBatch(batch) {
  return batch
    ? {status: batch.status, batch: batch.batch}
    : {status: 'notRecorded', batch: null};
}

/** A committed record version in its history. */
function versionItem(v, batch) {
  return {
    kind: 'version',
    versionNumber: v.versionNumber,
    at: v.committedAt,
    ...statusAndBatch(batch),
  };
}

/** A document a record version is made of, in the record's history. */
function documentItem(d, batch) {
  return {
    kind: 'document',
    documentId: d.id,
    version: d.version,
    edrmsNo: d.edrmsNo,
    docType: d.docType,
    ref: d.ref,
    at: batch?.sealedAt ?? null,
    ...statusAndBatch(batch),
  };
}

/** An audit sign-off (its trail entry) in the record's history. */
function signoffItem(entry, batch) {
  const {fromVersion, toVersion, recordVersion} = entry.data;
  return {
    kind: 'signoff',
    from: fromVersion ?? recordVersion,
    to: toVersion ?? recordVersion,
    at: entry.time,
    ...batch,
  };
}

/** A record version made of the document, in the document's history. */
function usedInItem(pin, label, batch) {
  return {
    kind: 'usedIn',
    recordId: pin.recordId,
    recordNo: label?.recordNo ?? null,
    label: label?.label ?? null,
    versionNumber: pin.versionNumber,
    documentVersion: pin.version,
    at: batch?.sealedAt ?? null,
    ...statusAndBatch(batch),
  };
}

/** The record service's and edrms reads of the search (with the audit service's token). */
export function createLookupSources({
  recordsUrl,
  recordsLabel = recordServiceLabel(),
  edrmsUrl,
  serviceToken,
  fetchImpl,
  timeoutMs,
}) {
  const request = createServiceClient({serviceToken, fetchImpl, timeoutMs});
  const records = recordClientAt(recordsUrl, (url, method, body) =>
    request(url, {name: `${recordsLabel} service`, method, body}),
  );
  const edrms = {name: 'document service'};
  return {
    // committed records, matched on number and parcel only (never owners)
    records: ({q, limit}) =>
      records.list({
        q,
        status: 'committed',
        match: 'parcel',
        limit: String(limit),
      }),
    versions: recordId => records.versions(recordId),
    lookup: body => records.lookup(body),
    documentByNumber: by =>
      request(`${edrmsUrl}/documents/lookup?${new URLSearchParams(by)}`, {
        ...edrms,
        notFound: null,
      }),
    document: id => request(`${edrmsUrl}/documents/${id}`, edrms),
  };
}
