import {randomUUID} from 'node:crypto';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@lrfe/common';
import {
  PARCEL_KINDS,
  formatRecordNo,
  kindOf,
  parcelKey,
  parcelLabel,
  schemaFor,
  validateVersion,
} from './catalogue.js';
import {parcelFromProperty, propertyMatches} from './parcel-match.js';
import {checksFor, sameName, suggestFromDocuments} from './derive.js';
import {readingMethods} from './records-reading.js';
import {reviewMethods, settleFiled} from './records-review.js';
import {searchTextOf} from './search-text.js';
import {SYSTEM} from './system-actor.js';

export {propertyMatches, searchTextOf};

/** Core fields an officer edits in a draft (README.md section 2); `documents` change by link and unlink. */
const EDITABLE = [
  'parcel',
  'extent',
  'tenure',
  'owners',
  'encumbrances',
  'attributes',
];
/** Core fields that can be taken over from the documents' suggestions. */
const SUGGESTED = ['owners', 'extent', 'encumbrances'];

/**
 * Land records (README.md): creating a record with its first draft, editing the draft (core fields,
 * pinned documents, suggestions and checks) and opening a new draft after a commit. Its other
 * methods are in two files: records-review.js (review and commit through bpm, API-647, and flags
 * when edrms corrects a linked document, API-648) and records-reading.js (records, versions, the
 * seal chain, the history, comments and finding documents).
 */
export class RecordsService {
  constructor({
    repo,
    events,
    edrms = null,
    bpm = null,
    anchoring = null,
    identity = null,
    clock = () => new Date(),
    config = {},
  }) {
    this.repo = repo;
    this.events = events;
    this.edrms = edrms;
    this.bpm = bpm;
    this.anchoring = anchoring; // the audit service: is a version anchored on chain yet (API-658)
    this.identity = identity; // the security policies: Four-eyes finalization (API-663); none: only the submitter is excluded
    this.clock = clock;
    this.config = {country: 'NA', ...config};
  }

  catalogue() {
    return {
      parcelKinds: PARCEL_KINDS.map(k => ({
        ...k,
        schema: schemaFor(k.schemaVersion),
        draftSchema: schemaFor(k.schemaVersion, {complete: false}),
      })),
    };
  }

  /** Run `fn` so its writes and the events it publishes are committed together (API-613). */
  atomic(fn) {
    return this.events?.atomic ? this.events.atomic(fn) : fn();
  }

  async requireRecord(id) {
    const r = await this.repo.getRecord(id);
    if (!r) throw new NotFoundError('Land record not found');
    return r;
  }

  // ---------------------------------------------------------------- create

  /**
   * A new record for a parcel, with an empty draft v1. One record per parcel. With
   * `edrmsDocumentId` (and no parcel): the parcel is read from that filed document's property
   * field, and the document is linked to the new draft.
   */
  async createRecord({parcel, attributes, edrmsDocumentId}, actor = SYSTEM) {
    if (edrmsDocumentId && !parcel) {
      const doc = await this.requireDocument(edrmsDocumentId);
      parcel = parcelFromProperty(doc.props?.property, doc.props);
      if (!parcel) {
        throw new BadRequestError(
          `The parcel cannot be read from ${doc.edrmsNo} ("${doc.props?.property ?? ''}"): give the parcel`,
        );
      }
    }
    const kind = kindOf(parcel?.kind);
    if (!kind) {
      throw new BadRequestError(
        `parcel.kind must be one of ${PARCEL_KINDS.map(k => k.id).join(', ')}`,
      );
    }
    const data = {
      schemaVersion: kind.schemaVersion,
      parcel,
      owners: [],
      encumbrances: [],
      documents: [],
      ...(attributes ? {attributes} : {}),
    };
    const problems = validateVersion(data);
    if (problems.length) {
      throw new BadRequestError('The record data is not valid', {problems});
    }
    const missing = kind.parcelRequired.filter(
      f => !String(parcel[f] ?? '').trim(),
    );
    if (missing.length) {
      throw new BadRequestError(`The parcel needs: ${missing.join(', ')}`, {
        missing,
      });
    }
    const key = parcelKey(parcel);
    const existing = await this.repo.findRecord({parcelKey: key});
    if (existing) {
      throw new ConflictError(
        `${parcelLabel(parcel)} already has a land record (${existing.recordNo})`,
        {recordId: existing.id, recordNo: existing.recordNo},
      );
    }

    const id = randomUUID();
    const now = this.clock();
    // the record, its first draft and its event are committed together (API-613)
    await this.atomic(async () => {
      const record = await this.repo.createRecord({
        year: now.getUTCFullYear(),
        build: seq => {
          const r = {
            id,
            recordNo: formatRecordNo(
              this.config.country,
              now.getUTCFullYear(),
              seq,
            ),
            parcelKey: key,
            kind: kind.id,
            label: parcelLabel(parcel),
            status: 'draft',
            currentVersion: null,
            draftVersion: 1,
            draftState: 'draft',
            flags: [],
            createdAt: now,
            createdById: actor.id,
            createdByName: actor.name ?? null,
            updatedAt: now,
          };
          r.searchText = searchTextOf(r, data);
          const version = {
            id: randomUUID(),
            recordId: id,
            versionNumber: 1,
            state: 'draft',
            revision: 1,
            schemaVersion: kind.schemaVersion,
            data,
            derived: suggestFromDocuments([]),
            checks: checksFor(data),
            changes: [
              {
                at: now.toISOString(),
                byId: actor.id,
                byName: actor.name ?? null,
                action: 'create',
              },
            ],
            createdAt: now,
            createdById: actor.id,
            createdByName: actor.name ?? null,
            updatedAt: now,
          };
          return {record: r, version};
        },
      });
      await this.events?.publish(
        'records.record.created',
        {recordId: id, recordNo: record.recordNo, parcelKey: key},
        {actor},
      );
    });
    if (edrmsDocumentId) {
      return this.addDocument(id, {revision: 1, edrmsDocumentId}, actor);
    }
    return this.getRecord(id);
  }

  // ---------------------------------------------------------------- editing a draft (API-646)

  /** The record's open draft, which must not be in review. */
  async requireDraft(recordId) {
    const record = await this.requireRecord(recordId);
    if (!record.draftVersion) {
      throw new ConflictError('The record has no open draft');
    }
    if (record.draftState !== 'draft') {
      throw new ConflictError('The draft is in review and cannot be changed');
    }
    return {
      record,
      version: await this.repo.getVersion(recordId, record.draftVersion),
    };
  }

  async requireDocument(edrmsDocumentId) {
    const doc = await this.requireEdrms().getDocument(edrmsDocumentId);
    if (!doc) throw new NotFoundError('Document not found in the EDRMS');
    return doc;
  }

  /**
   * Store a changed draft: suggestions and checks recomputed, revision + 1 (only if nobody saved
   * in between), the change logged on the version and published.
   */
  async saveDraft({record, version}, revision, data, change, actor) {
    const conflict = () =>
      new ConflictError(
        'The draft was changed by someone else: reload it and try again',
        {revision: version.revision},
      );
    if (revision !== version.revision) throw conflict();
    const problems = validateVersion(data);
    if (problems.length) {
      throw new BadRequestError('The record data is not valid', {problems});
    }
    const derived = suggestFromDocuments(data.documents);
    const now = this.clock();
    const entry = {
      at: now.toISOString(),
      byId: actor.id,
      byName: actor.name ?? null,
      ...change,
    };
    // the draft, the record and the event are committed together (API-613)
    await this.atomic(async () => {
      const saved = await this.repo.updateVersion(
        record.id,
        version.versionNumber,
        {
          data,
          derived,
          checks: checksFor(data, {flags: record.flags, suggested: derived}),
          revision: revision + 1,
          changes: [...(version.changes || []), entry],
          updatedAt: now,
        },
        {expectedRevision: revision},
      );
      if (!saved) throw conflict();
      const current = record.currentVersion
        ? await this.repo.getVersion(record.id, record.currentVersion)
        : null;
      const label = parcelLabel(data.parcel);
      const key = parcelKey(data.parcel);
      // a "new document" flag ends while a draft holds its document (API-766); read again here, so
      // a flag raised meanwhile is kept
      const settled = settleFiled(
        await this.repo.getRecord(record.id),
        data,
        version.versionNumber,
        entry,
      );
      await this.repo.updateRecord(record.id, {
        label,
        parcelKey: key,
        updatedAt: now,
        searchText: searchTextOf(
          {...record, label, parcelKey: key},
          current?.data,
          data,
        ),
        ...settled,
      });
      await this.events?.publish(
        'records.draft.changed',
        {
          recordId: record.id,
          recordNo: record.recordNo,
          versionNumber: version.versionNumber,
          revision: revision + 1,
          change: entry,
        },
        {actor},
      );
    });
    return this.getRecord(record.id);
  }

  /**
   * Edit the draft's core fields and attributes (`changes`; null removes a field), and/or take over
   * the documents' suggestions (`accept`: owners, extent, encumbrances). Owners or an extent that
   * differ from the suggestions are marked as entered by hand and need a `reason`.
   */
  async updateDraft(
    recordId,
    {revision, changes = {}, accept = [], reason} = {},
    actor = SYSTEM,
  ) {
    const draft = await this.requireDraft(recordId);
    const unknown = Object.keys(changes).filter(k => !EDITABLE.includes(k));
    if (unknown.length) {
      throw new BadRequestError(
        `Cannot change: ${unknown.join(', ')} (editable: ${EDITABLE.join(', ')})`,
      );
    }
    const badAccept = accept.filter(k => !SUGGESTED.includes(k));
    if (badAccept.length) {
      throw new BadRequestError(`No suggestions for: ${badAccept.join(', ')}`);
    }
    if (!Object.keys(changes).length && !accept.length) {
      throw new BadRequestError('Nothing to change');
    }
    const overlap = accept.filter(k => k in changes);
    if (overlap.length) {
      throw new BadRequestError(
        `Either accept or change: ${overlap.join(', ')}`,
      );
    }

    const old = draft.version.data;
    const data = structuredClone(old);
    const suggested = suggestFromDocuments(old.documents);

    if ('parcel' in changes) {
      const parcel = changes.parcel;
      if (!parcel || parcel.kind !== old.parcel.kind) {
        throw new BadRequestError(
          `The parcel kind cannot change (${old.parcel.kind}): create a new record`,
        );
      }
      const missing = kindOf(parcel.kind).parcelRequired.filter(
        f => !String(parcel[f] ?? '').trim(),
      );
      if (missing.length) {
        throw new BadRequestError(`The parcel needs: ${missing.join(', ')}`, {
          missing,
        });
      }
      const other = await this.repo.findRecord({parcelKey: parcelKey(parcel)});
      if (other && other.id !== recordId) {
        throw new ConflictError(
          `${parcelLabel(parcel)} already has a land record (${other.recordNo})`,
          {recordId: other.id, recordNo: other.recordNo},
        );
      }
    }
    for (const [k, v] of Object.entries(changes)) {
      if (v === null && k !== 'parcel') delete data[k];
      else data[k] = structuredClone(v);
    }
    for (const k of accept) {
      const value = suggested[k];
      if (
        !value ||
        (Array.isArray(value) && !value.length && k !== 'encumbrances')
      ) {
        throw new BadRequestError(`The documents suggest no ${k} yet`);
      }
      data[k] = structuredClone(value);
    }

    // values that are not what the documents say: entered by hand, with a reason
    const byHand = [];
    if (Array.isArray(changes.owners)) {
      data.owners = changes.owners.map(o => {
        const fromDocs = suggested.owners?.find(
          s =>
            sameName(s.name, o.name) &&
            s.share === o.share &&
            (s.idNo ?? null) === (o.idNo ?? null),
        );
        if (fromDocs) {
          return {
            ...o,
            since: o.since ?? fromDocs.since,
            source: fromDocs.source,
          };
        }
        const why =
          reason || (o.source?.from === 'manual' ? o.source.reason : null);
        byHand.push({what: `owner ${o.name}`, why});
        return {
          ...o,
          source: {
            from: 'manual',
            by: actor.name ?? actor.id,
            ...(why ? {reason: why} : {}),
          },
        };
      });
    }
    if (changes.extent) {
      const s = suggested.extent;
      if (
        s &&
        s.value === changes.extent.value &&
        s.unit === changes.extent.unit
      ) {
        data.extent = {...changes.extent, source: s.source};
      } else {
        const why =
          reason ||
          (changes.extent.source?.from === 'manual'
            ? changes.extent.source.reason
            : null);
        byHand.push({what: 'extent', why});
        data.extent = {
          ...changes.extent,
          source: {
            from: 'manual',
            by: actor.name ?? actor.id,
            ...(why ? {reason: why} : {}),
          },
        };
      }
    }
    const unexplained = byHand.filter(x => !x.why);
    if (unexplained.length) {
      throw new BadRequestError(
        `Give a reason for the values entered by hand: ${unexplained.map(x => x.what).join(', ')}`,
        {byHand: unexplained.map(x => x.what)},
      );
    }

    const fields = [...Object.keys(changes), ...accept];
    return this.saveDraft(
      draft,
      revision,
      data,
      {
        action: 'edit',
        fields,
        ...(accept.length ? {accepted: accept} : {}),
        ...(byHand.length ? {byHand: byHand.map(x => x.what), reason} : {}),
      },
      actor,
    );
  }

  /**
   * Change a committed record: a new draft vN+1, a copy of the current version. The current
   * version stays current until the new one is approved. One open draft per record.
   */
  async openDraft(recordId, actor = SYSTEM) {
    const record = await this.requireRecord(recordId);
    if (record.draftVersion) {
      throw new ConflictError(
        `The record already has an open draft (version ${record.draftVersion})`,
        {versionNumber: record.draftVersion},
      );
    }
    if (!record.currentVersion) {
      throw new ConflictError('The record has no committed version yet');
    }
    const current = await this.repo.getVersion(recordId, record.currentVersion);
    const n =
      Math.max(
        ...(await this.repo.listVersions(recordId)).map(v => v.versionNumber),
      ) + 1;
    const now = this.clock();
    const data = structuredClone(current.data);
    const derived = suggestFromDocuments(data.documents);
    const change = this.entry(actor, {
      action: 'open',
      from: current.versionNumber,
    });
    // the new draft, the record and the event are committed together (API-613)
    await this.atomic(async () => {
      await this.repo
        .addVersion({
          id: randomUUID(),
          recordId,
          versionNumber: n,
          state: 'draft',
          revision: 1,
          schemaVersion: current.schemaVersion,
          data,
          derived,
          checks: checksFor(data, {flags: record.flags, suggested: derived}),
          changes: [change],
          createdAt: now,
          createdById: actor.id,
          createdByName: actor.name ?? null,
          updatedAt: now,
        })
        .catch(err => {
          // a concurrent open fails here (unique version number)
          throw err instanceof ConflictError
            ? new ConflictError('The record already has an open draft')
            : err;
        });
      await this.repo.updateRecord(recordId, {
        draftVersion: n,
        draftState: 'draft',
        updatedAt: now,
      });
      await this.events?.publish(
        'records.draft.changed',
        {
          recordId,
          recordNo: record.recordNo,
          versionNumber: n,
          revision: 1,
          change,
        },
        {actor},
      );
    });
    return this.getRecord(recordId);
  }

  /** The document's current version in edrms, as it is pinned into a version. */
  pinOf(doc, actor) {
    const v = (doc.versions || []).find(
      x => x.versionNumber === doc.currentVersion,
    );
    if (!v?.seal) {
      throw new ConflictError(`${doc.edrmsNo} has no sealed current version`);
    }
    const fields = Object.fromEntries(
      Object.entries(doc.props || {})
        .filter(([, val]) => val !== null && val !== undefined && val !== '')
        .map(([k, val]) => [k, String(val)]),
    );
    return {
      edrmsDocumentId: doc.id,
      edrmsNo: doc.edrmsNo,
      version: v.versionNumber,
      seal: v.seal,
      docType: doc.docType,
      ref: doc.instrumentRef ?? null,
      addedBy: actor.id,
      addedAt: this.clock().toISOString(),
      fields,
    };
  }

  /**
   * Adopt a document's newer EDRMS version (after a correction): its pinned version, seal and
   * fields are updated in the draft; suggestions and checks follow, and the change is reviewed.
   */
  async refreshDocument(recordId, edrmsDocumentId, {revision}, actor = SYSTEM) {
    const draft = await this.requireDraft(recordId);
    const data = structuredClone(draft.version.data);
    const i = (data.documents || []).findIndex(
      d => d.edrmsDocumentId === edrmsDocumentId,
    );
    if (i < 0) throw new NotFoundError('The document is not in this record');
    const old = data.documents[i];
    const doc = await this.requireDocument(edrmsDocumentId);
    if (doc.currentVersion === old.version) {
      throw new ConflictError(
        `${old.edrmsNo} is already at its current version (${old.version})`,
      );
    }
    data.documents[i] = this.pinOf(doc, actor);
    return this.saveDraft(
      draft,
      revision,
      data,
      {
        action: 'update',
        edrmsNo: old.edrmsNo,
        ref: data.documents[i].ref,
        fromVersion: old.version,
        toVersion: doc.currentVersion,
      },
      actor,
    );
  }

  /** Pin a filed document into the draft, at its current EDRMS version and seal. */
  async addDocument(recordId, {revision, edrmsDocumentId}, actor = SYSTEM) {
    const draft = await this.requireDraft(recordId);
    const data = structuredClone(draft.version.data);
    data.documents = data.documents || [];
    if (data.documents.some(d => d.edrmsDocumentId === edrmsDocumentId)) {
      throw new ConflictError('The document is already in this record');
    }
    const doc = await this.requireDocument(edrmsDocumentId);
    const pin = this.pinOf(doc, actor);
    data.documents.push(pin);
    return this.saveDraft(
      draft,
      revision,
      data,
      {
        action: 'link',
        edrmsNo: doc.edrmsNo,
        ref: pin.ref,
        version: pin.version,
      },
      actor,
    );
  }

  /** Remove a document from the draft. */
  async removeDocument(recordId, edrmsDocumentId, {revision}, actor = SYSTEM) {
    const draft = await this.requireDraft(recordId);
    const data = structuredClone(draft.version.data);
    const doc = (data.documents || []).find(
      d => d.edrmsDocumentId === edrmsDocumentId,
    );
    if (!doc) throw new NotFoundError('The document is not in this record');
    data.documents = data.documents.filter(d => d !== doc);
    return this.saveDraft(
      draft,
      revision,
      data,
      {action: 'unlink', edrmsNo: doc.edrmsNo, ref: doc.ref ?? null},
      actor,
    );
  }

  // ---------------------------------------------------------------- shared by the parts

  /** A change-log entry. */
  entry(actor, change) {
    return {
      at: this.clock().toISOString(),
      byId: actor.id,
      byName: actor.name ?? null,
      ...change,
    };
  }

  requireEdrms() {
    if (!this.edrms) {
      throw new AppError(503, 'The document store is not configured');
    }
    return this.edrms;
  }
}

// Reviewing (submit, approve, return) and reading (records, versions, history, comments,
// documents) are in their own files; their methods are methods of RecordsService.
addMethods(RecordsService, reviewMethods);
addMethods(RecordsService, readingMethods);

/**
 * Adds the methods in `methods` to a class, as if they were written in it (not enumerable, like
 * class methods), so `this` in them is the service.
 */
function addMethods(cls, methods) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    Object.defineProperty(cls.prototype, name, {
      ...descriptor,
      enumerable: false,
    });
  }
}
