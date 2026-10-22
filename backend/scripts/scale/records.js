/**
 * Land records of the test register (API-769), built as the land-records service builds them: the
 * parcel read from the first title deed, the documents pinned with their seals and field snapshots,
 * owners, extent and bonds taken from the documents' suggestions, checks, and for an approved
 * version its seal in the record's chain. Records are in every state the work lists show.
 */
import {sealOf as documentSealOf} from '../../services/edrms/src/seal.js';
import {searchTextOf as documentSearchText} from '../../services/edrms/src/search.js';
import {
  formatRecordNo,
  kindOf,
  parcelKey,
  parcelLabel,
  validateVersion,
} from '../../services/land-records/src/catalogue.js';
import {
  checksFor,
  suggestFromDocuments,
} from '../../services/land-records/src/derive.js';
import {parcelFromProperty} from '../../services/land-records/src/parcel-match.js';
import {sealOf} from '../../services/land-records/src/seal.js';
import {searchTextOf} from '../../services/land-records/src/search-text.js';

const DAY_MS = 86_400_000;
const TITLE_TYPES = ['deed_of_grant', 'deed_of_transfer'];

/**
 * The share of records in each state; the rest are approved. A fifth of the approved ones, and of
 * those needing review or with a new document, have a second approved version. `newDocument`: a
 * document filed for the parcel that is not in the record yet; `needsReview`: a pinned document
 * corrected in edrms since.
 */
export const STATE_MIX = {
  draft: 0.05,
  inBin: 0.02,
  inReview: 0.04,
  needsReview: 0.02,
  newDocument: 0.03,
};

/** Every record's later steps (approval, a change, a correction) fall within this many days after it was created. */
const LATEST_STEP_DAYS = 60;

/** A change-log entry of a record or version, as the service writes it. */
const logEntry = (actor, at, change) => ({
  at: at.toISOString(),
  byId: actor.id,
  byName: actor.name,
  ...change,
});

/** Creates the land records of the register, numbered per year as they are created. */
export class RecordsBuilder {
  /** @param {{random: object, profile: object, asOf: Date, parcels: number, years: number}} options */
  constructor({random, profile, asOf, parcels, years}) {
    this.random = random;
    this.profile = profile;
    this.parcelCount = parcels;
    // records are created early enough that their later steps are before `asOf` too
    this.end = asOf.getTime() - LATEST_STEP_DAYS * DAY_MS;
    this.start = asOf.getTime() - years * 365.25 * DAY_MS;
    this.counters = new Map(); // year → last record number
    this.invalid = 0;
    const person = (id, name) => ({id, name});
    this.officers = [1, 2, 3].map(n =>
      person(`generated-rec-${n}`, `Generated records officer ${n}`),
    );
    this.registrars = [1, 2].map(n =>
      person(`generated-sup-${n}`, `Generated registrar ${n}`),
    );
  }

  /** The last record number used per year: land-records' counter table. */
  yearCounters() {
    return [...this.counters].map(([year, last]) => ({year, last}));
  }

  pickState() {
    let roll = this.random.next();
    for (const [state, share] of Object.entries(STATE_MIX)) {
      if (roll < share) return state;
      roll -= share;
    }
    return 'approved';
  }

  /**
   * The record of a parcel, from its filed documents ({document, versions}, oldest first): the
   * rows to insert ({record, versions, state}), or null when no title deed names the parcel. A
   * `needsReview` record corrects one of its documents in edrms: that document gets version 2.0.
   */
  build(index, filed) {
    const firstTitle = filed.find(f =>
      TITLE_TYPES.includes(f.document.docType),
    );
    if (!firstTitle) return null;
    const {props} = firstTitle.document;
    const parcel = parcelFromProperty(props.property, props);
    const kind = kindOf(parcel?.kind);
    if (!kind) return null;
    let state = this.pickState();
    let pinned = filed;
    let newDocument = null;
    if (state === 'newDocument') {
      newDocument = filed[filed.length - 1];
      pinned = filed.slice(0, -1);
      // the record must hold a title deed for its owners
      if (!pinned.some(f => TITLE_TYPES.includes(f.document.docType))) {
        state = 'approved';
        pinned = filed;
        newDocument = null;
      }
    }

    const context = this.newRecord(index, parcel, kind);
    const {record, officer, createdAt} = context;
    const documents = pinned.map(f => pinOf(f, officer, createdAt));
    const derived = suggestFromDocuments(documents);
    const complete = {
      schemaVersion: kind.schemaVersion,
      parcel,
      owners: derived.owners ?? [],
      ...(derived.extent ? {extent: derived.extent} : {}),
      tenure: 'freehold',
      encumbrances: derived.encumbrances,
      documents,
    };
    const versions =
      state === 'draft' || state === 'inBin'
        ? this.neverApproved(context, complete)
        : this.approved(context, complete, state);
    if (state === 'needsReview') {
      record.flags = [this.correctionFlag(context, pinned[pinned.length - 1])];
    }
    if (newDocument) {
      record.flags = [newDocumentFlag(context, newDocument.document)];
    }

    for (const version of versions) {
      const problems = validateVersion(version.data, {
        complete: version.state !== 'draft',
      });
      if (problems.length) {
        // not what the service would accept: left out and counted, the run goes on
        this.invalid += 1;
        return null;
      }
    }
    const current = versions.find(
      v => v.versionNumber === record.currentVersion,
    );
    const draft = versions.find(v => v.versionNumber === record.draftVersion);
    record.searchText = searchTextOf(record, current?.data, draft?.data);
    record.updatedAt = versions[versions.length - 1].updatedAt;
    if (state === 'inBin') this.moveToBin(context);
    return {record, versions, state};
  }

  /** The record row, numbered in creation order, with who created it and when. */
  newRecord(index, parcel, kind) {
    const createdAt = new Date(
      Math.round(
        this.start + (index / this.parcelCount) * (this.end - this.start),
      ),
    );
    const year = createdAt.getUTCFullYear();
    const seq = (this.counters.get(year) ?? 0) + 1;
    this.counters.set(year, seq);
    const officer = this.random.pick(this.officers);
    const record = {
      id: this.random.uuid(),
      recordNo: formatRecordNo(this.profile.country, year, seq),
      parcelKey: parcelKey(parcel),
      kind: kind.id,
      label: parcelLabel(parcel),
      status: 'committed',
      currentVersion: 1,
      draftVersion: null,
      draftState: null,
      flags: [],
      flagLog: [],
      discardedAt: null,
      binLog: [],
      createdAt,
      createdById: officer.id,
      createdByName: officer.name,
      updatedAt: createdAt,
    };
    return {
      record,
      kind,
      officer,
      registrar: this.random.pick(this.registrars),
      createdAt,
      later: days => new Date(createdAt.getTime() + days * DAY_MS),
    };
  }

  /** A version as a draft, before anything else happens to it. */
  version(context, versionNumber, data, changes) {
    const {record, kind, officer, createdAt} = context;
    return {
      id: this.random.uuid(),
      recordId: record.id,
      versionNumber,
      state: 'draft',
      revision: 1,
      schemaVersion: kind.schemaVersion,
      data,
      derived: suggestFromDocuments(data.documents),
      checks: checksFor(data, {flags: record.flags}),
      changes,
      reviewComment: null,
      reviewInstanceId: null,
      createdAt,
      createdById: officer.id,
      createdByName: officer.name,
      updatedAt: createdAt,
      submittedAt: null,
      submittedById: null,
      submittedByName: null,
      approvedById: null,
      approvedByName: null,
      committedAt: null,
      seal: null,
      previousSeal: null,
    };
  }

  /** The version submitted for review by the officer on `at`. */
  submit(context, version, at, revision) {
    const {officer} = context;
    return Object.assign(version, {
      state: 'in_review',
      revision,
      submittedAt: at,
      submittedById: officer.id,
      submittedByName: officer.name,
      updatedAt: at,
      changes: [...version.changes, logEntry(officer, at, {action: 'submit'})],
    });
  }

  /** The version approved by the registrar on `at`: sealed after `previous`, which is superseded. */
  commit(context, version, at, previous) {
    const {record, registrar} = context;
    Object.assign(version, {
      state: 'committed',
      approvedById: registrar.id,
      approvedByName: registrar.name,
      committedAt: at,
      previousSeal: previous?.seal ?? null,
      updatedAt: at,
      changes: [
        ...version.changes,
        logEntry(registrar, at, {action: 'commit', via: 'bpm'}),
      ],
    });
    version.seal = sealOf(record, version);
    if (previous) previous.state = 'superseded';
    return version;
  }

  /** A record never approved: its draft holds the documents, the owners not taken over yet. */
  neverApproved(context, complete) {
    const {record, officer, createdAt} = context;
    Object.assign(record, {
      status: 'draft',
      currentVersion: null,
      draftVersion: 1,
      draftState: 'draft',
    });
    const data = {...complete, owners: [], encumbrances: []};
    const created = logEntry(officer, createdAt, {action: 'create'});
    return [this.version(context, 1, data, [created])];
  }

  /**
   * An approved record: version 1 approved, and then either a change in review (`inReview`) or,
   * for a fifth of the others, a second approved version.
   */
  approved(context, complete, state) {
    const {record, officer, createdAt, later} = context;
    const created = logEntry(officer, createdAt, {action: 'create'});
    const first = this.version(context, 1, complete, [created]);
    this.submit(context, first, later(1), 3);
    const versions = [this.commit(context, first, later(2), null)];
    const opened = at => [logEntry(officer, at, {action: 'open', from: 1})];
    if (state === 'inReview') {
      // waiting for the registrar; the bpm review task itself is not generated
      const data = {...complete, attributes: {zoning: 'Residential 1'}};
      const change = this.version(context, 2, data, opened(later(19)));
      versions.push(this.submit(context, change, later(20), 2));
      Object.assign(record, {draftVersion: 2, draftState: 'in_review'});
    } else if (this.random.chance(0.2)) {
      const data = {...complete, attributes: {zoning: 'General business'}};
      const change = this.version(context, 2, data, opened(later(29)));
      this.submit(context, change, later(30), 2);
      versions.push(this.commit(context, change, later(31), first));
      record.currentVersion = 2;
    }
    return versions;
  }

  /** A pinned document corrected in edrms since (its version 2.0), and the flag it raised. */
  correctionFlag(context, target) {
    const {officer, registrar, later} = context;
    const at = later(LATEST_STEP_DAYS);
    const corrected = amend(target, this.random, officer, {
      at,
      approvedBy: registrar,
    });
    const {document} = target;
    return {
      type: 'document_updated',
      edrmsDocumentId: document.id,
      edrmsNo: document.edrmsNo,
      ref: document.instrumentRef ?? null,
      from: 1,
      to: 2,
      reason: corrected.reason,
      at: at.toISOString(),
      message: `Document updated: ${document.edrmsNo} v1 → v2. Review needed.`,
    };
  }

  /** The record moved to the bin: its parcel is free for a new record meanwhile. */
  moveToBin({record, officer, later}) {
    const at = later(5);
    record.discardedAt = at;
    record.binLog = [
      logEntry(officer, at, {
        action: 'discarded',
        reason: 'Created for the wrong parcel',
        parcelKey: record.parcelKey,
      }),
    ];
    record.parcelKey = `${record.parcelKey}~bin~${record.id}`;
    record.updatedAt = at;
  }
}

/** The flag a document filed for the parcel raised on its record (API-766). */
function newDocumentFlag({later}, document) {
  return {
    type: 'document_filed',
    edrmsDocumentId: document.id,
    edrmsNo: document.edrmsNo,
    ref: document.instrumentRef ?? null,
    docType: document.docType,
    matchedBy: 'property',
    at: later(10).toISOString(),
    message: `New document for this parcel: ${document.instrumentRef || document.edrmsNo}. Open a change to add it.`,
  };
}

/** A filed document as a record version pins it (the service's pinOf). */
function pinOf({document, versions}, actor, at) {
  const [first] = versions;
  return {
    edrmsDocumentId: document.id,
    edrmsNo: document.edrmsNo,
    version: first.versionNumber,
    seal: first.seal,
    docType: document.docType,
    ref: document.instrumentRef ?? null,
    addedBy: actor.id,
    addedAt: at.toISOString(),
    fields: Object.fromEntries(
      Object.entries(document.props).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
  };
}

/** The fields a correction may change, in order of preference: none of them changes matching. */
const CORRECTABLE = [
  'tee1Id',
  'mortgagorId',
  'buyer1Id',
  'surveyor',
  'reference',
];

/**
 * A correction of a filed document, as edrms makes it (four-eyes approved): version 2.0 with one
 * value corrected (an ID number's last digit, say), added to `filed.versions`, and the document
 * row updated.
 */
function amend(filed, random, actor, {at, approvedBy}) {
  const {document} = filed;
  const previous = filed.versions[filed.versions.length - 1];
  const fields = structuredClone(document.fields);
  const field =
    CORRECTABLE.map(k => fields.find(f => f.k === k)).find(Boolean) ??
    fields[fields.length - 1];
  const from = field.v;
  field.v = /\d$/.test(from)
    ? `${from.slice(0, -1)}${(Number(from.slice(-1)) + 1) % 10}`
    : `${from} (corrected)`;
  field.edited = true;
  const reason = `Correction of the ${field.label.toLowerCase()}`;
  const version = {
    ...previous,
    id: random.uuid(),
    versionNumber: 2,
    label: '2.0',
    kind: 'amendment',
    reason,
    changes: [{k: field.k, from, to: field.v}],
    fields,
    createdAt: at,
    createdById: actor.id,
    createdByName: actor.name,
    approvedById: approvedBy.id,
    approvedByName: approvedBy.name,
  };
  version.seal = documentSealOf(document.id, document.edrmsNo, version);
  filed.versions.push(version);
  Object.assign(document, {
    fields,
    props: Object.fromEntries(fields.map(f => [f.k, f.v])),
    currentVersion: 2,
    updatedAt: at,
    searchText: documentSearchText({...document, fields}),
  });
  return version;
}
