/**
 * Reading land records (the list, a record with its versions, the history and seal chain), the
 * comments on a record (listing and adding them), and finding documents for a record. These are methods of RecordsService
 * (records.service.js adds them), so `this` is the service.
 */
import {randomUUID} from 'node:crypto';
import {BadRequestError, NotFoundError} from '@lrfe/common';
import {kindOf, parcelKey, parcelLabel} from './catalogue.js';
import {diffVersions} from './diff.js';
import {
  parcelFromProperty,
  propertyMatches,
  propertyMismatch,
  sameParcelNumber,
} from './parcel-match.js';
import {verifyChain} from './seal.js';
import {SYSTEM} from './system-actor.js';

/**
 * The reading and comment methods of RecordsService.
 * @this {import('./records.service.js').RecordsService}
 */
export const readingMethods = {
  // ---------------------------------------------------------------- history (API-648)

  /**
   * Every committed version, newest first: who submitted and approved it, when, what it changed
   * against the version before, whether its seal and chain verify, and its anchoring status
   * (`waiting` for the next anchoring, `anchored`, `confirmed`; null when the audit service cannot say).
   */
  async history(recordId) {
    const record = await this.requireRecord(recordId);
    const committed = (await this.repo.listVersions(recordId)).filter(v =>
      ['committed', 'superseded'].includes(v.state),
    );
    const seals = verifyChain(record, committed);
    const key = v => `record-version:${recordId}:${v.versionNumber}`;
    const anchoring = this.anchoring
      ? await this.anchoring.statusOf(committed.map(key))
      : {};
    const versions = committed.map((v, i) => ({
      versionNumber: v.versionNumber,
      state: v.state,
      current: v.versionNumber === record.currentVersion,
      submittedAt: v.submittedAt ?? null,
      submittedById: v.submittedById ?? null,
      submittedByName: v.submittedByName ?? null,
      approvedById: v.approvedById ?? null,
      approvedByName: v.approvedByName ?? null,
      committedAt: v.committedAt,
      reviewComment: v.reviewComment ?? null,
      seal: v.seal,
      previousSeal: v.previousSeal ?? null,
      intact: seals[i].intact,
      linked: seals[i].linked,
      diff: diffVersions(i ? committed[i - 1].data : null, v.data),
      anchoring: anchoring[key(v)] ?? null,
    }));
    return {
      recordId,
      recordNo: record.recordNo,
      label: record.label,
      intact: seals.every(x => x.intact && x.linked),
      flags: record.flags || [],
      // ended "new document" flags: dismissed (who, when, why) or added to a draft (API-766)
      flagLog: record.flagLog || [],
      versions: versions.reverse(),
    };
  },

  // ---------------------------------------------------------------- comments

  async listComments(recordId) {
    await this.requireRecord(recordId);
    return {items: await this.repo.listComments(recordId)};
  },

  async addComment(recordId, {body}, actor = SYSTEM) {
    const record = await this.requireRecord(recordId);
    const text = String(body ?? '').trim();
    if (!text) throw new BadRequestError('The comment is empty');
    return this.repo.addComment({
      id: randomUUID(),
      recordId,
      versionNumber: record.draftVersion ?? record.currentVersion ?? null,
      body: text,
      authorId: actor.id,
      authorName: actor.name ?? null,
      createdAt: this.clock(),
    });
  },

  // ---------------------------------------------------------------- finding documents (API-645)

  /** A filed document as land records show it, with the records that already hold it. */
  documentSummary(d, pinnedBy, recordId) {
    const linked = (pinnedBy.get(d.id) || []).filter(
      x => x.recordId !== recordId,
    );
    const unique = [
      ...new Map(
        linked.map(x => [
          x.recordId,
          {recordId: x.recordId, recordNo: x.recordNo, label: x.label},
        ]),
      ).values(),
    ];
    return {
      edrmsDocumentId: d.id,
      edrmsNo: d.edrmsNo,
      docType: d.docType,
      title: d.title,
      ref: d.instrumentRef ?? null,
      property: d.props?.property ?? null,
      currentVersion: d.currentVersion,
      filedAt: d.filedAt,
      inThisRecord:
        !!recordId &&
        (pinnedBy.get(d.id) || []).some(x => x.recordId === recordId),
      linkedTo: unique,
      // the verified metadata, with the labels the Documents screen shows (API-765)
      fields: (d.fields || []).map(f => ({
        k: f.k,
        label: f.label ?? f.k,
        v: f.v,
        ...(f.edited ? {edited: true} : {}),
      })),
    };
  },

  /** One filed document as land records show it: its metadata and the records that hold it. */
  async documentDetails(edrmsDocumentId) {
    const doc = await this.requireDocument(edrmsDocumentId);
    const pinnedBy = await this.repo.findRecordsPinning([doc.id]);
    return this.documentSummary(doc, pinnedBy);
  },

  /**
   * Before creating a record (API-765): the parcel as read from a filed document (or as the officer
   * corrected it, `parcel`), what it still needs, the filed documents with the same parcel number
   * and whether each describes this parcel, values for missing fields that those documents agree
   * on, and the record the parcel already has. Reads only.
   */
  async createPreview({edrmsDocumentId, parcel} = {}) {
    const doc = edrmsDocumentId
      ? await this.requireDocument(edrmsDocumentId)
      : null;
    const read = doc
      ? parcelFromProperty(doc.props?.property, doc.props)
      : null;
    const shown = parcel ?? read;
    const kind = kindOf(shown?.kind);
    const missing = kind
      ? kind.parcelRequired.filter(f => !String(shown[f] ?? '').trim())
      : [];

    let about = [];
    if (kind) {
      const q = numberWords(shown);
      const {items} = q
        ? await this.requireEdrms().searchDocuments({q, limit: 200})
        : {items: []};
      about = items.filter(d => sameParcelNumber(shown, d.props?.property));
    }
    if (doc && !about.some(d => d.id === doc.id)) about.unshift(doc);
    const pinnedBy = await this.repo.findRecordsPinning(about.map(d => d.id));
    const documents = about.map(d => {
      const why = kind ? propertyMismatch(shown, d.props?.property) : null;
      return {
        ...this.documentSummary(d, pinnedBy),
        chosen: d.id === doc?.id,
        matches: !!kind && !why,
        ...(why ? {mismatch: why} : {}),
      };
    });

    // a value the parcel lacks (a bond has no registration division) that the documents describing it agree on
    const suggested = {};
    const describing = about.filter(
      d => kind && propertyMatches(shown, d.props?.property),
    );
    for (const f of missing) {
      const values = [
        ...new Set(describing.map(d => d.props?.[f]).filter(Boolean)),
      ];
      const from = describing.filter(d => d.props?.[f]).length;
      if (values.length === 1) suggested[f] = {value: values[0], from};
    }

    const key = kind && !missing.length ? parcelKey(shown) : null;
    const record = key ? await this.repo.findRecord({parcelKey: key}) : null;
    const existing = record
      ? {
          ...this.summary(record),
          hasDocument:
            !!doc &&
            (pinnedBy.get(doc.id) || []).some(x => x.recordId === record.id),
        }
      : null;
    return {
      document: doc ? this.documentSummary(doc, pinnedBy) : null,
      read,
      parcel: shown,
      missing,
      suggested,
      documents,
      existing,
    };
  },

  /**
   * Search filed documents by their verified metadata (edrms searchDocuments: words, word starts,
   * spelling variants of names, document type, field filters), marking those already in a record.
   */
  async searchDocuments({q, docType, fields = {}, recordId, limit = 50} = {}) {
    if (recordId) await this.requireRecord(recordId);
    const {items, total} = await this.requireEdrms().searchDocuments({
      q,
      docType,
      fields,
      limit,
    });
    const pinnedBy = await this.repo.findRecordsPinning(items.map(d => d.id));
    return {
      items: items.map(d => this.documentSummary(d, pinnedBy, recordId)),
      total,
    };
  },

  /**
   * Documents that match this parcel, with the reasons: the property described is this parcel;
   * or the chain of the documents already in the record (their SG diagram, their prior title,
   * deeds and bonds that cite them as prior title).
   */
  async suggestions(recordId) {
    const record = await this.requireRecord(recordId);
    const version = await this.repo.getVersion(
      recordId,
      record.draftVersion ?? record.currentVersion,
    );
    const parcel = version.data.parcel;
    const edrms = this.requireEdrms();
    const found = new Map(); // edrms id → { doc, reasons }
    const add = (doc, reason) => {
      const entry = found.get(doc.id) || {doc, reasons: []};
      if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
      found.set(doc.id, entry);
    };

    // 1. the property field describes this parcel
    const {items} = await edrms.searchDocuments({
      q: parcelWords(parcel),
      limit: 200,
    });
    for (const d of items) {
      if (propertyMatches(parcel, d.props?.property)) {
        add(d, `Property: ${d.props.property}`);
      }
    }

    // 2. the chain of the documents already pinned
    for (const p of version.data.documents || []) {
      const f = p.fields || {};
      const ref = p.ref || f.deedNo || f.sgNo;
      if (f.sgRef) {
        for (const d of (await edrms.searchDocuments({fields: {sgNo: f.sgRef}}))
          .items) {
          add(d, `SG diagram cited by ${ref}`);
        }
      }
      if (f.priorTitle) {
        for (const d of (
          await edrms.searchDocuments({fields: {deedNo: f.priorTitle}})
        ).items) {
          add(d, `Prior title of ${ref}`);
        }
      }
      if (ref) {
        for (const d of (
          await edrms.searchDocuments({fields: {priorTitle: ref}})
        ).items) {
          add(d, `Cites ${ref} as prior title`);
        }
      }
    }

    const pinnedBy = await this.repo.findRecordsPinning([...found.keys()]);
    const items2 = [...found.values()].map(({doc, reasons}) => ({
      ...this.documentSummary(doc, pinnedBy, recordId),
      reasons,
    }));
    // not yet in this record first, then by registration reference
    items2.sort(
      (a, b) =>
        a.inThisRecord - b.inThisRecord ||
        String(a.ref).localeCompare(String(b.ref)),
    );
    return {recordId, parcel: parcelLabel(parcel), items: items2};
  },

  // ---------------------------------------------------------------- reading

  summary(r) {
    return {
      id: r.id,
      recordNo: r.recordNo,
      kind: r.kind,
      label: r.label,
      parcelKey: r.parcelKey,
      status: r.status,
      currentVersion: r.currentVersion ?? null,
      draftVersion: r.draftVersion ?? null,
      draftState: r.draftState ?? null,
      // a linked document was corrected in edrms (API-648)
      needsReview: (r.flags || []).some(f => f.type !== 'document_filed'),
      // documents filed for the parcel and not in the record yet (API-766)
      newDocuments: (r.flags || []).filter(f => f.type === 'document_filed')
        .length,
      flags: r.flags || [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  },

  /** `match: 'parcel'`: `q` against the record number and the parcel label only, never owners (the Anchorings search, API-697). */
  async listRecords({q, status, match, limit, offset} = {}) {
    if (
      status &&
      ![
        'draft',
        'committed',
        'in_review',
        'needs_review',
        'new_document',
      ].includes(status)
    ) {
      throw new BadRequestError(`Unknown status "${status}"`);
    }
    // in_review / needs_review / new_document filter in the service: small lists, simple repos
    const base = ['draft', 'committed'].includes(status) ? status : undefined;
    const res = await this.repo.listRecords({
      q,
      status: base,
      match,
      limit: status && !base ? 1000 : limit,
      offset: status && !base ? 0 : offset,
    });
    let items = res.items;
    if (status === 'in_review') {
      items = items.filter(r => r.draftState === 'in_review');
    }
    let summaries = items.map(r => this.summary(r));
    if (status === 'needs_review') {
      summaries = summaries.filter(r => r.needsReview);
    }
    if (status === 'new_document') {
      summaries = summaries.filter(r => r.newDocuments > 0);
    }
    return {
      items: summaries,
      total: status && !base ? summaries.length : res.total,
    };
  },

  /** Every committed version's seal, oldest first, a page at a time: the audit service's backfill (API-669). */
  listSeals({after = null, limit = 500} = {}) {
    return this.repo.listSeals({after, limit});
  },

  /**
   * For the audit service's Anchorings screens: the documents each committed land record version is
   * made of (API-696), the committed versions that pin the given documents (API-697), and the
   * number and label of each land record asked for or named by them.
   */
  async lookup({recordIds = [], versions = [], pinning = []}) {
    const [made, pins] = await Promise.all([
      this.repo.versionDocuments(versions),
      this.repo.findCommittedPinning(pinning),
    ]);
    const named = [
      ...recordIds,
      ...versions.map(v => v.recordId),
      ...pins.map(p => p.recordId),
    ];
    const records = await this.repo.recordLabels([...new Set(named)]);
    return {records, versions: made, pinnedBy: pins};
  },

  async getRecord(id) {
    const r = await this.requireRecord(id);
    const current = r.currentVersion
      ? await this.repo.getVersion(id, r.currentVersion)
      : null;
    const draft = r.draftVersion
      ? await this.repo.getVersion(id, r.draftVersion)
      : null;
    // a change in progress: what it changes against the current committed version
    return {
      ...this.summary(r),
      current,
      draft,
      draftDiff:
        draft && current ? diffVersions(current.data, draft.data) : null,
    };
  },

  async listVersions(id) {
    await this.requireRecord(id);
    return (await this.repo.listVersions(id)).map(v => ({
      versionNumber: v.versionNumber,
      state: v.state,
      schemaVersion: v.schemaVersion,
      createdAt: v.createdAt,
      createdByName: v.createdByName ?? null,
      submittedAt: v.submittedAt ?? null,
      submittedByName: v.submittedByName ?? null,
      approvedByName: v.approvedByName ?? null,
      committedAt: v.committedAt ?? null,
      seal: v.seal ?? null,
      changes: v.changes || [],
    }));
  },

  async getVersion(id, n) {
    await this.requireRecord(id);
    const v = await this.repo.getVersion(id, n);
    if (!v) throw new NotFoundError('Version not found');
    return v;
  },

  /** Recompute the seals of all committed versions and their chain. */
  async verify(id) {
    const r = await this.requireRecord(id);
    const committed = (await this.repo.listVersions(id)).filter(v =>
      ['committed', 'superseded'].includes(v.state),
    );
    const versions = verifyChain(r, committed);
    return {
      recordId: id,
      recordNo: r.recordNo,
      intact: versions.every(v => v.intact && v.linked),
      versions,
      checkedAt: this.clock(),
    };
  },
};

/** The parcel's number alone (erf, farm or unit number): the broadest search for documents about it. */
function numberWords(parcel) {
  if (parcel.kind === 'erf') return parcel.number ?? '';
  if (parcel.kind === 'farm_portion') return parcel.farmNumber ?? '';
  if (parcel.kind === 'sectional_unit') return parcel.unit ?? '';
  return '';
}

/** The words that identify a parcel in a document's text (for a first, broad search). */
function parcelWords(parcel) {
  if (parcel.kind === 'erf') {
    return [parcel.number, parcel.township].filter(Boolean).join(' ');
  }
  if (parcel.kind === 'farm_portion') {
    return [parcel.farmName, parcel.farmNumber].filter(Boolean).join(' ');
  }
  if (parcel.kind === 'sectional_unit') {
    return [parcel.schemeName, parcel.unit].filter(Boolean).join(' ');
  }
  return '';
}
