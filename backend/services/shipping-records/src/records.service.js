import {randomUUID} from 'node:crypto';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@lrfe/common';
import {
  assertBillOfLading,
  billOfLadingHash,
  formatNamed,
} from '@lrfe/domain-shipping/bill-of-lading';
import {sealOf, verifyChain} from '@lrfe/record-contract/seal';

/** The list's status filters: the record's own status, or a draft waiting in review. */
export const LIST_STATUSES = Object.freeze(['draft', 'committed', 'in_review']);

/**
 * Whether a caller sees a record: a user only their organisation's (`organisationId`), a service
 * every record (`organisationId` null).
 * @param {{organisationId: string}} record
 * @param {?string} organisationId
 * @return {boolean}
 */
function isVisible(record, organisationId) {
  return organisationId === null || record.organisationId === organisationId;
}

/**
 * A record as the list answers it.
 * @param {object} r a stored record
 * @return {object}
 */
function summaryOf(r) {
  return {
    id: r.id,
    recordNo: r.recordNo,
    carrierCode: r.carrierCode,
    label: r.label,
    organisationId: r.organisationId,
    status: r.status,
    currentVersion: r.currentVersion ?? null,
    draftVersion: r.draftVersion ?? null,
    draftState: r.draftState ?? null,
    createdAt: r.createdAt,
    createdByName: r.createdByName ?? null,
    updatedAt: r.updatedAt,
  };
}

/**
 * A version as the versions list answers it: everything but its data.
 * @param {object} v a stored version
 * @return {object}
 */
function versionSummaryOf(v) {
  return {
    versionNumber: v.versionNumber,
    state: v.state,
    documentHash: v.documentHash,
    createdAt: v.createdAt,
    createdByName: v.createdByName ?? null,
    submittedAt: v.submittedAt ?? null,
    submittedByName: v.submittedByName ?? null,
    approvedByName: v.approvedByName ?? null,
    committedAt: v.committedAt ?? null,
    seal: v.seal ?? null,
    changes: v.changes || [],
  };
}

/**
 * What a version's event says about it: never the whole document, only its hash.
 * @param {object} record
 * @param {object} version
 * @return {{recordId: string, recordNo: string, versionNumber: number, documentHash: string}}
 */
function eventDataOf(record, version) {
  return {
    recordId: record.id,
    recordNo: record.recordNo,
    versionNumber: version.versionNumber,
    documentHash: version.documentHash,
  };
}

/**
 * Refuses a draft whose document is another B/L: the carrier code and the transport document
 * reference name the record, so they never change.
 * @param {object} record
 * @param {object} document the draft's DCSA transport document
 */
function assertSameDocument(record, document) {
  const sameCarrier = document.carrierCode === record.carrierCode;
  const sameReference = document.transportDocumentReference === record.recordNo;
  if (!sameCarrier || !sameReference) {
    throw new BadRequestError(
      `The carrier code and the transport document reference of a B/L cannot change (${record.label})`,
    );
  }
}

/**
 * The 409 for a draft changed or submitted by someone else since it was read.
 * @return {!ConflictError}
 */
function changedMeanwhile() {
  return new ConflictError(
    'The draft was changed or submitted meanwhile: reload it and try again',
  );
}

/**
 * Shipping records (README.md): draft bills of lading of an organisation, versioned, submitted for
 * review, committed by a second person and sealed. Each record answers the record contract (CB-4)
 * for the shared services; a user sees only their organisation's records.
 */
export class ShippingRecordsService {
  /**
   * @param {{
   *   repo: object,
   *   events: ?object,
   *   formats: ReadonlyArray<object>,
   *   clock?: function(): Date,
   * }} options `formats`: the B/L formats on in this install (formatsFromSettings)
   */
  constructor({repo, events, formats, clock = () => new Date()}) {
    this.repo = repo;
    this.events = events;
    this.formats = formats;
    this.clock = clock;
  }

  /**
   * Run `fn` so its writes and the events it publishes are committed together.
   * @param {function(): Promise<*>} fn
   * @return {Promise<*>}
   */
  atomic(fn) {
    return this.events?.atomic ? this.events.atomic(fn) : fn();
  }

  /**
   * A record the caller sees; 404 otherwise, never saying that another organisation has it.
   * @param {string} id
   * @param {?string} organisationId the caller's organisation, null for a service
   * @return {Promise<object>}
   */
  async requireRecord(id, organisationId = null) {
    const record = await this.repo.getRecord(id);
    if (!record || !isVisible(record, organisationId)) {
      throw new NotFoundError('B/L not found');
    }
    return record;
  }

  /**
   * One version of a record; 404 when it has none of that number.
   * @param {object} record
   * @param {number} n
   * @return {Promise<object>}
   */
  async requireVersion(record, n) {
    const version = await this.repo.getVersion(record.id, n);
    if (!version) {
      throw new NotFoundError('Version not found');
    }
    return version;
  }

  /**
   * A B/L of the model from a request: the document converted from its format, with the links of
   * its parties to organisations; 400 with every problem when it is not valid.
   * @param {{format: string, document: object, partyOrganisations?: object}} body
   * @return {object}
   */
  billOfLadingOf({format, document, partyOrganisations}) {
    const {billOfLading} = formatNamed(this.formats, format).toModel(document);
    if (partyOrganisations !== undefined) {
      billOfLading.partyOrganisations = partyOrganisations;
    }
    return assertBillOfLading(billOfLading);
  }

  /**
   * An entry of a version's change log.
   * @param {{id: string, name?: string}} actor
   * @param {object} change
   * @return {object}
   */
  entry(actor, change) {
    return {
      at: this.clock().toISOString(),
      byId: actor.id,
      byName: actor.name ?? null,
      ...change,
    };
  }

  /**
   * Publishes a version's event with its actor.
   * @param {string} type
   * @param {object} data
   * @param {object} actor
   * @return {Promise<void>}
   */
  async publish(type, data, actor) {
    await this.events?.publish(type, data, {actor});
  }

  // ---------------------------------------------------------------- drafts

  /**
   * A new record with its first draft, owned by the creator's organisation. One record per
   * organisation, carrier code and transport document reference (409). Another organisation may
   * hold the same reference: drafts are private, and refusing it would reveal the other's B/L. One
   * issued B/L per carrier reference on the platform is a rule of issuing (L3/L4), not of drafts.
   * @param {{format: string, document: object, partyOrganisations?: object}} body
   * @param {{id: string, name?: string, org?: string}} actor
   * @param {string} organisationId the owner
   * @return {Promise<object>} the record as getRecord answers it
   */
  async createRecord(body, actor, organisationId) {
    const data = this.billOfLadingOf(body);
    const {carrierCode, transportDocumentReference: recordNo} = data.document;
    if (await this.repo.findRecord({organisationId, carrierCode, recordNo})) {
      throw new ConflictError(
        `Your organisation already has a B/L with the reference ${recordNo} of carrier ${carrierCode}`,
      );
    }
    const now = this.clock();
    const record = {
      id: randomUUID(),
      recordNo,
      carrierCode,
      label: `B/L ${recordNo} (${carrierCode})`,
      organisationId,
      status: 'draft',
      currentVersion: null,
      draftVersion: 1,
      draftState: 'draft',
      createdAt: now,
      createdById: actor.id,
      createdByName: actor.name ?? null,
      updatedAt: now,
    };
    const version = this.newVersion(record, 1, data, actor, 'create');
    // the record, its first draft and its event are committed together
    await this.atomic(async () => {
      await this.repo.createRecord({record, version});
      await this.publish(
        'records.record.created',
        eventDataOf(record, version),
        actor,
      );
    });
    return this.getRecord(record.id, organisationId);
  }

  /**
   * A new draft version of a record.
   * @param {object} record
   * @param {number} versionNumber
   * @param {object} data the B/L
   * @param {object} actor
   * @param {string} action the change log's first entry: `create` or `open`
   * @return {object}
   */
  newVersion(record, versionNumber, data, actor, action) {
    const now = this.clock();
    return {
      id: randomUUID(),
      recordId: record.id,
      versionNumber,
      state: 'draft',
      revision: 1,
      data,
      documentHash: billOfLadingHash(data),
      changes: [this.entry(actor, {action})],
      reviewComment: null,
      createdAt: now,
      createdById: actor.id,
      createdByName: actor.name ?? null,
      updatedAt: now,
    };
  }

  /**
   * Replaces the open draft's B/L, or opens a new draft version after the current one when there
   * is none. Refused while the draft is in review (409) and for another B/L's document (400).
   * @param {string} id
   * @param {{format: string, document: object, partyOrganisations?: object}} body
   * @param {object} actor
   * @param {string} organisationId the caller's organisation
   * @return {Promise<object>} the record as getRecord answers it
   */
  async saveDraft(id, body, actor, organisationId) {
    const record = await this.requireRecord(id, organisationId);
    const data = this.billOfLadingOf(body);
    assertSameDocument(record, data.document);
    // the draft as read now: it is replaced only if nobody changes it meanwhile
    const draft = record.draftVersion
      ? await this.requireVersion(record, record.draftVersion)
      : null;
    // the draft, the record and the event are committed together
    await this.atomic(async () => {
      const version = draft
        ? await this.replaceDraft(record, draft, data, actor)
        : await this.openDraft(record, data, actor);
      await this.publish(
        'records.draft.changed',
        eventDataOf(record, version),
        actor,
      );
    });
    return this.getRecord(id, organisationId);
  }

  /**
   * The open draft with a new B/L; 409 when it is in review, or was changed or submitted since it
   * was read (the last writer never silently wins).
   * @param {object} record
   * @param {object} draft the open draft as read before
   * @param {object} data
   * @param {object} actor
   * @return {Promise<object>} the saved version
   */
  async replaceDraft(record, draft, data, actor) {
    if (draft.state !== 'draft') {
      throw new ConflictError(
        'The draft is in review: it can change again once it is sent back',
      );
    }
    const saved = await this.repo.updateVersion(
      record.id,
      draft.versionNumber,
      {
        data,
        documentHash: billOfLadingHash(data),
        changes: [
          ...(draft.changes || []),
          this.entry(actor, {action: 'edit'}),
        ],
        revision: draft.revision + 1,
        updatedAt: this.clock(),
      },
      {expectedState: 'draft', expectedRevision: draft.revision},
    );
    if (!saved) {
      throw changedMeanwhile();
    }
    return saved;
  }

  /**
   * A new draft version after the current committed one.
   * @param {object} record
   * @param {object} data
   * @param {object} actor
   * @return {Promise<object>} the new version
   */
  async openDraft(record, data, actor) {
    const versionNumber = record.currentVersion + 1;
    const version = this.newVersion(record, versionNumber, data, actor, 'open');
    await this.repo.addVersion(version);
    await this.repo.updateRecord(record.id, {
      draftVersion: versionNumber,
      draftState: 'draft',
      updatedAt: version.createdAt,
    });
    return version;
  }

  /**
   * Submits the open draft for review: it is frozen until a second person commits it or sends it
   * back (the contract's commit and reject). 409 when the draft was changed since it was read, so
   * the version submitted is always the one the submitted event names.
   * @param {string} id
   * @param {number} n the draft's version number
   * @param {object} actor the submitter
   * @param {string} organisationId the caller's organisation
   * @return {Promise<object>} the record as getRecord answers it
   */
  async submit(id, n, actor, organisationId) {
    const record = await this.requireRecord(id, organisationId);
    const version = await this.requireVersion(record, n);
    if (record.draftVersion !== n || version.state !== 'draft') {
      throw new ConflictError(
        `Version ${n} is not an open draft (${version.state})`,
      );
    }
    const now = this.clock();
    // the version, the record and the event are committed together
    await this.atomic(async () => {
      const frozen = await this.repo.updateVersion(
        id,
        n,
        {
          state: 'in_review',
          reviewComment: null,
          submittedAt: now,
          submittedById: actor.id,
          submittedByName: actor.name ?? null,
          changes: [
            ...(version.changes || []),
            this.entry(actor, {action: 'submit'}),
          ],
          revision: version.revision + 1,
          updatedAt: now,
        },
        {expectedState: 'draft', expectedRevision: version.revision},
      );
      if (!frozen) {
        throw changedMeanwhile();
      }
      await this.repo.updateRecord(id, {
        draftState: 'in_review',
        updatedAt: now,
      });
      await this.publish(
        'records.draft.submitted',
        eventDataOf(record, frozen),
        actor,
      );
    });
    return this.getRecord(id, organisationId);
  }

  // ---------------------------------------------------------------- review decisions (the contract)

  /**
   * Approved: the version in review is committed, sealed and chained to the previous current
   * version. The approver must not be the submitter (four-eyes, always on). A repeated call for a
   * version already committed by the same approver answers it unchanged.
   * @param {string} id
   * @param {number} n
   * @param {{by: {id: string, name?: string}, comment?: string}} decision
   * @param {string} via the service that reports the decision
   * @return {Promise<object>} the record as getRecord answers it
   */
  async commit(id, n, {by, comment}, via) {
    const record = await this.requireRecord(id);
    const version = await this.requireVersion(record, n);
    if (version.state === 'committed' && version.approvedById === by.id) {
      return this.getRecord(id);
    }
    if (version.state !== 'in_review') {
      throw new ConflictError(
        `Version ${n} is not in review (${version.state})`,
      );
    }
    if (by.id === version.submittedById) {
      throw new ForbiddenError(
        'The submitter cannot approve their own version (four-eyes)',
      );
    }
    const previous = record.currentVersion
      ? await this.repo.getVersion(id, record.currentVersion)
      : null;
    const committedAt = this.clock();
    const approved = {
      approvedById: by.id,
      approvedByName: by.name ?? null,
      committedAt,
      previousSeal: previous?.seal ?? null,
    };
    const seal = sealOf(record, {...version, ...approved});
    const actor = {id: by.id, name: by.name ?? null};
    const note = comment ? {comment} : {};
    // the commit and its event are committed together
    await this.atomic(async () => {
      await this.repo.commit({
        recordId: id,
        versionNumber: n,
        versionPatch: {
          ...approved,
          seal,
          revision: version.revision + 1,
          reviewComment: comment || null,
          updatedAt: committedAt,
          changes: [
            ...(version.changes || []),
            this.entry(actor, {action: 'commit', via, ...note}),
          ],
        },
        recordPatch: {
          status: 'committed',
          currentVersion: n,
          draftVersion: null,
          draftState: null,
          updatedAt: committedAt,
        },
      });
      await this.publish(
        'records.record.committed',
        {
          recordId: id,
          recordNo: record.recordNo,
          versionNumber: n,
          seal,
          previousSeal: approved.previousSeal,
          submittedBy: {
            id: version.submittedById,
            name: version.submittedByName,
          },
          approvedBy: actor,
          documentHash: version.documentHash,
        },
        actor,
      );
    });
    return this.getRecord(id);
  }

  /**
   * Sent back: the version in review returns to its submitter as a draft, with the comment (which
   * is required). A repeated call with the same comment answers it unchanged.
   * @param {string} id
   * @param {number} n
   * @param {{by: {id: string, name?: string}, comment?: string}} decision
   * @param {string} via the service that reports the decision
   * @return {Promise<object>} the record as getRecord answers it
   */
  async reject(id, n, {by, comment}, via) {
    const record = await this.requireRecord(id);
    const version = await this.requireVersion(record, n);
    if (version.state === 'draft' && version.reviewComment === comment) {
      return this.getRecord(id);
    }
    /**
     * The 409 for a version no longer in review.
     * @return {!ConflictError}
     */
    const notInReview = () =>
      new ConflictError(`Version ${n} is not in review (${version.state})`);
    if (version.state !== 'in_review') {
      throw notInReview();
    }
    if (!String(comment ?? '').trim()) {
      throw new BadRequestError('A rejection needs a comment');
    }
    const actor = {id: by.id, name: by.name ?? null};
    const now = this.clock();
    // back to draft and the event, committed together
    await this.atomic(async () => {
      const saved = await this.repo.updateVersion(
        id,
        n,
        {
          state: 'draft',
          revision: version.revision + 1,
          reviewComment: comment,
          changes: [
            ...(version.changes || []),
            this.entry(actor, {action: 'reject', via, comment}),
          ],
          updatedAt: now,
        },
        {expectedState: 'in_review', expectedRevision: version.revision},
      );
      if (!saved) {
        throw notInReview();
      }
      await this.repo.updateRecord(id, {draftState: 'draft', updatedAt: now});
      await this.publish(
        'records.draft.rejected',
        eventDataOf(record, version),
        actor,
      );
    });
    return this.getRecord(id);
  }

  // ---------------------------------------------------------------- reading

  /**
   * A page of records, newest first.
   * @param {{status?: string, q?: string, limit?: number, offset?: number}} query
   * @param {?string} organisationId the caller's organisation, null for a service
   * @return {Promise<{items: !Array<object>, total: number}>}
   */
  async listRecords({status, q, limit, offset} = {}, organisationId = null) {
    if (status && !LIST_STATUSES.includes(status)) {
      throw new BadRequestError(`Unknown status "${status}"`);
    }
    const inReview = status === 'in_review';
    const page = await this.repo.listRecords({
      organisationId,
      status: inReview ? undefined : status,
      draftState: inReview ? 'in_review' : undefined,
      q,
      limit,
      offset,
    });
    return {items: page.items.map(summaryOf), total: page.total};
  }

  /**
   * One record with its current committed version and its open draft, both with their data.
   * `draftDiff` is the contract's place for a difference between them, which B/Ls do not
   * compute: always null.
   * @param {string} id
   * @param {?string} organisationId the caller's organisation, null for a service
   * @return {Promise<object>}
   */
  async getRecord(id, organisationId = null) {
    const r = await this.requireRecord(id, organisationId);
    const current = r.currentVersion
      ? await this.repo.getVersion(id, r.currentVersion)
      : null;
    const draft = r.draftVersion
      ? await this.repo.getVersion(id, r.draftVersion)
      : null;
    return {...summaryOf(r), current, draft, draftDiff: null};
  }

  /**
   * The versions of a record, without their data.
   * @param {string} id
   * @param {?string} organisationId
   * @return {Promise<!Array<object>>}
   */
  async listVersions(id, organisationId = null) {
    await this.requireRecord(id, organisationId);
    return (await this.repo.listVersions(id)).map(versionSummaryOf);
  }

  /**
   * One version of a record, with its data.
   * @param {string} id
   * @param {number} n
   * @param {?string} organisationId
   * @return {Promise<object>}
   */
  async getVersion(id, n, organisationId = null) {
    const record = await this.requireRecord(id, organisationId);
    return this.requireVersion(record, n);
  }

  /**
   * Recompute the seals of all committed versions and their chain.
   * @param {string} id
   * @return {Promise<object>}
   */
  async verify(id) {
    const record = await this.requireRecord(id);
    const all = await this.repo.listVersions(id);
    const versions = verifyChain(
      record,
      all.filter(v => v.state === 'committed'),
    );
    return {
      recordId: id,
      recordNo: record.recordNo,
      intact: versions.every(v => v.intact && v.linked),
      versions,
      checkedAt: this.clock(),
    };
  }

  /**
   * Every committed version's seal, oldest first, a page at a time (the audit backfill).
   * @param {{after?: ?{at: string, id: string, version: number}, limit?: number}} [page]
   * @return {!Promise<!Array<{recordId: string, version: number, seal: string, at: Date}>>}
   */
  listSeals({after = null, limit = 500} = {}) {
    return this.repo.listSeals({after, limit});
  }

  /**
   * For the audit service: the number and label of each record asked for or named by a version,
   * and the committed versions asked for. A B/L version pins no documents: `documents` and
   * `pinnedBy` are always empty.
   * @param {{recordIds?: string[], versions?: object[]}} body
   * @return {Promise<object>}
   */
  async lookup({recordIds = [], versions = []}) {
    const named = [
      ...new Set([...recordIds, ...versions.map(v => v.recordId)]),
    ];
    const [records, committed] = await Promise.all([
      this.repo.recordLabels(named),
      this.repo.committedVersions(versions),
    ]);
    return {
      records,
      versions: committed.map(v => ({...v, documents: []})),
      pinnedBy: [],
    };
  }
}
