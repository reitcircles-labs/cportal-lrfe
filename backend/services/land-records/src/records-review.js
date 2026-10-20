/**
 * Reviewing a land record's draft (API-647): submitting it for review, withdrawing it, and the
 * approve and return decisions that bpm's land-record-review process reports back; and the flags
 * set when edrms corrects a linked document (API-648) or files a new document for the parcel
 * (API-766). These are methods of RecordsService
 * (records.service.js adds them), so `this` is the service.
 */
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@lrfe/common';
import {validateVersion} from './catalogue.js';
import {blocking, checksFor} from './derive.js';
import {diffVersions} from './diff.js';
import {parcelFromProperty, propertyMatches} from './parcel-match.js';
import {searchTextOf} from './search-text.js';
import {sealOf} from './seal.js';
import {SYSTEM} from './system-actor.js';

/**
 * The review methods of RecordsService.
 * @this {import('./records.service.js').RecordsService}
 */
export const reviewMethods = {
  // ---------------------------------------------------------------- review and commit (API-647)

  /**
   * Four-eyes finalization (API-663): with the security policy on, the reviewers who filed the
   * documents a version pins, the first time they were filed to the EDRMS. A correction (a later
   * version of a document) adds nobody: the same reviewers may correct their documents. With the
   * policy off, or no identity service configured, nobody (the submitter is excluded anyway).
   */
  async fourEyesExcluded(data) {
    if (!this.identity) return [];
    const {fourEyes} = await this.identity.policies();
    if (!fourEyes) return [];
    const ids = [
      ...new Set((data.documents || []).map(d => d.edrmsDocumentId)),
    ];
    const docs = await Promise.all(ids.map(id => this.requireDocument(id)));
    return [...new Set(docs.map(d => d.filedById).filter(Boolean))];
  },

  requireBpm() {
    if (!this.bpm) {
      throw new AppError(503, 'The review process is not configured');
    }
    return this.bpm;
  },

  /**
   * Submit the draft for review: refused while the data is incomplete or an error check fails
   * (the list is returned). The draft is frozen and a bpm "land-record-review" starts, whose
   * approval task goes to holders of record.finalize other than the submitter.
   */
  async submit(recordId, {revision}, actor = SYSTEM) {
    const {record, version} = await this.requireDraft(recordId);
    if (revision !== version.revision) {
      throw new ConflictError(
        'The draft was changed by someone else: reload it and try again',
        {revision: version.revision},
      );
    }
    const problems = validateVersion(version.data, {complete: true});
    if (problems.length) {
      throw new BadRequestError('The record is not complete yet', {problems});
    }
    const checks = checksFor(version.data, {flags: record.flags});
    const failing = blocking(checks);
    if (failing.length) {
      throw new BadRequestError(
        `${failing.length} check${failing.length > 1 ? 's' : ''} must pass before review: ${failing.map(c => c.message).join('; ')}`,
        {failing},
      );
    }

    const bpm = this.requireBpm();
    // four-eyes: with the policy on, the reviewers who filed the record's documents may not approve it either
    const filedBy = await this.fourEyesExcluded(version.data);
    const now = this.clock();
    const frozen = await this.repo.updateVersion(
      recordId,
      version.versionNumber,
      {
        state: 'in_review',
        revision: revision + 1,
        checks,
        reviewComment: null,
        submittedAt: now,
        submittedById: actor.id,
        submittedByName: actor.name ?? null,
        changes: [
          ...(version.changes || []),
          this.entry(actor, {action: 'submit'}),
        ],
        updatedAt: now,
      },
      {expectedRevision: revision},
    );
    if (!frozen) {
      throw new ConflictError(
        'The draft was changed by someone else: reload it and try again',
      );
    }
    await this.repo.updateRecord(recordId, {
      draftState: 'in_review',
      updatedAt: now,
    });

    let instance;
    try {
      instance = await bpm.startReview({
        record: {
          id: recordId,
          recordNo: record.recordNo,
          label: record.label,
          versionNumber: version.versionNumber,
        },
        submittedBy: {id: actor.id, name: actor.name ?? actor.id},
        filedBy,
      });
    } catch (err) {
      // the review did not start: the draft is editable again, as before
      await this.repo.updateVersion(recordId, version.versionNumber, {
        state: 'draft',
        revision,
        submittedAt: null,
        submittedById: null,
        submittedByName: null,
        changes: version.changes || [],
        updatedAt: now,
      });
      await this.repo.updateRecord(recordId, {draftState: 'draft'});
      throw err;
    }
    // the review link and the event are committed together (API-613)
    await this.atomic(async () => {
      await this.repo.updateVersion(recordId, version.versionNumber, {
        reviewInstanceId: instance.id,
      });
      await this.events?.publish(
        'records.draft.submitted',
        {
          recordId,
          recordNo: record.recordNo,
          versionNumber: version.versionNumber,
          reviewInstanceId: instance.id,
        },
        {actor},
      );
    });
    return this.getRecord(recordId);
  },

  /** The submitter takes the version back before a decision: the review task disappears. */
  async withdraw(recordId, actor = SYSTEM) {
    const record = await this.requireRecord(recordId);
    if (record.draftState !== 'in_review') {
      throw new ConflictError('The record has no version in review');
    }
    const version = await this.repo.getVersion(recordId, record.draftVersion);
    if (version.submittedById !== actor.id) {
      throw new ForbiddenError(
        'Only the person who submitted the version can withdraw it',
      );
    }
    if (version.reviewInstanceId) {
      await this.requireBpm().cancel(
        version.reviewInstanceId,
        'Withdrawn by the submitter',
      );
    }
    // back to draft and the event, committed together (API-613)
    await this.atomic(async () => {
      await this.backToDraft(
        record,
        version,
        this.entry(actor, {action: 'withdraw'}),
      );
      await this.events?.publish(
        'records.draft.withdrawn',
        {
          recordId,
          recordNo: record.recordNo,
          versionNumber: version.versionNumber,
        },
        {actor},
      );
    });
    return this.getRecord(recordId);
  },

  async backToDraft(record, version, change, patch = {}) {
    const now = this.clock();
    const saved = await this.repo.updateVersion(
      record.id,
      version.versionNumber,
      {
        state: 'draft',
        revision: version.revision + 1,
        reviewInstanceId: null,
        checks: checksFor(version.data, {
          flags: (await this.repo.getRecord(record.id)).flags,
        }),
        changes: [...(version.changes || []), change],
        updatedAt: now,
        ...patch,
      },
      {expectedRevision: version.revision},
    );
    if (!saved) {
      throw new ConflictError(
        'The version was changed at the same time: try again',
      );
    }
    await this.repo.updateRecord(record.id, {
      draftState: 'draft',
      updatedAt: now,
    });
  },

  /** The version in review, for a decision from bpm. */
  async requireInReview(recordId, versionNumber) {
    const record = await this.requireRecord(recordId);
    const version = await this.repo.getVersion(recordId, versionNumber);
    if (!version) throw new NotFoundError('Version not found');
    return {record, version};
  },

  /**
   * Approved (from bpm): the version is committed, sealed and chained to the previous current
   * version, which is superseded. The approver must not be the submitter. A repeated call for
   * a version already committed by the same approver returns it unchanged.
   */
  async commitFromReview(
    recordId,
    versionNumber,
    {by, comment},
    service = 'bpm',
  ) {
    const {record, version} = await this.requireInReview(
      recordId,
      versionNumber,
    );
    if (version.state === 'committed' && version.approvedById === by.id) {
      return this.getRecord(recordId);
    }
    if (version.state !== 'in_review') {
      throw new ConflictError(
        `Version ${versionNumber} is not in review (${version.state})`,
      );
    }
    if (by.id === version.submittedById) {
      throw new ForbiddenError(
        'The submitter cannot approve their own version (four-eyes)',
      );
    }
    // the policy as it is now: also when it was switched on while the version was in review
    if ((await this.fourEyesExcluded(version.data)).includes(by.id)) {
      throw new ForbiddenError(
        'You filed a document of this land record, so another person must approve it (four-eyes)',
      );
    }

    const previous = record.currentVersion
      ? await this.repo.getVersion(recordId, record.currentVersion)
      : null;
    const committedAt = this.clock();
    const sealed = {
      ...version,
      approvedById: by.id,
      approvedByName: by.name ?? null,
      committedAt,
      previousSeal: previous?.seal ?? null,
    };
    const seal = sealOf(record, sealed);
    const actor = {id: by.id, name: by.name};
    // flags this version settles; read again just before the commit so a flag raised meanwhile is kept
    const flagsNow = (await this.repo.getRecord(recordId)).flags || [];
    const remaining = openFlags(flagsNow, version.data);
    const settledFlags =
      remaining.length !== flagsNow.length ? {flags: remaining} : {};
    // the commit and its event are committed together (API-613)
    await this.atomic(async () => {
      await this.repo.commit({
        recordId,
        versionNumber,
        versionPatch: {
          approvedById: by.id,
          approvedByName: by.name ?? null,
          committedAt,
          previousSeal: sealed.previousSeal,
          seal,
          reviewComment: comment || null,
          updatedAt: committedAt,
          changes: [
            ...(version.changes || []),
            this.entry(actor, {
              action: 'commit',
              via: service,
              ...(comment ? {comment} : {}),
            }),
          ],
        },
        recordPatch: {
          status: 'committed',
          currentVersion: versionNumber,
          draftVersion: null,
          draftState: null,
          updatedAt: committedAt,
          searchText: searchTextOf(record, version.data),
          ...settledFlags,
        },
        supersede: previous?.versionNumber,
      });
      await this.events?.publish(
        'records.record.committed',
        {
          recordId,
          recordNo: record.recordNo,
          versionNumber,
          seal,
          previousSeal: sealed.previousSeal,
          submittedBy: {
            id: version.submittedById,
            name: version.submittedByName,
          },
          approvedBy: actor,
        },
        {actor},
      );
    });
    return this.getRecord(recordId);
  },

  /** Rejected (from bpm): the version returns to the submitter as a draft, with the comment. */
  async rejectFromReview(
    recordId,
    versionNumber,
    {by, comment},
    service = 'bpm',
  ) {
    const {record, version} = await this.requireInReview(
      recordId,
      versionNumber,
    );
    if (version.state === 'draft' && version.reviewComment === comment) {
      return this.getRecord(recordId);
    }
    if (version.state !== 'in_review') {
      throw new ConflictError(
        `Version ${versionNumber} is not in review (${version.state})`,
      );
    }
    if (!String(comment || '').trim()) {
      throw new BadRequestError('A rejection needs a comment');
    }
    const actor = {id: by.id, name: by.name};
    // back to draft and the event, committed together (API-613)
    await this.atomic(async () => {
      await this.backToDraft(
        record,
        version,
        this.entry(actor, {action: 'reject', via: service, comment}),
        {reviewComment: comment},
      );
      await this.events?.publish(
        'records.draft.rejected',
        {
          recordId,
          recordNo: record.recordNo,
          versionNumber,
          comment,
          submittedBy: {
            id: version.submittedById,
            name: version.submittedByName,
          },
        },
        {actor},
      );
    });
    return this.getRecord(recordId);
  },

  /**
   * What the reviewer sees: the version (draft or in review), its checks and the difference
   * from the current committed version.
   */
  async review(recordId) {
    const record = await this.requireRecord(recordId);
    if (!record.draftVersion) {
      throw new NotFoundError('The record has no version waiting for review');
    }
    const version = await this.repo.getVersion(recordId, record.draftVersion);
    const current = record.currentVersion
      ? await this.repo.getVersion(recordId, record.currentVersion)
      : null;
    const checks =
      version.state === 'in_review' && version.checks?.length
        ? version.checks
        : checksFor(version.data, {flags: record.flags});
    return {
      record: this.summary(record),
      version,
      checks,
      blocking: blocking(checks).map(c => c.id),
      overrides: [
        ...(version.data.owners || [])
          .filter(o => o.source?.from === 'manual')
          .map(o => ({
            what: `owner ${o.name}`,
            by: o.source.by ?? null,
            reason: o.source.reason ?? null,
          })),
        ...(version.data.extent?.source?.from === 'manual'
          ? [
              {
                what: 'extent',
                by: version.data.extent.source.by ?? null,
                reason: version.data.extent.source.reason ?? null,
              },
            ]
          : []),
      ],
      diff: diffVersions(current?.data ?? null, version.data),
      currentVersion: current
        ? {
            versionNumber: current.versionNumber,
            seal: current.seal,
            committedAt: current.committedAt,
          }
        : null,
    };
  },

  // ---------------------------------------------------------------- edrms corrections (API-648)

  /**
   * edrms filed a new version of a document (`edrms.document.amended`). Every record whose
   * current version or open draft pins an older version is flagged "needs review"; nothing in
   * the record changes by itself. Repeated or late events only move the flag forward.
   */
  async onDocumentAmended({documentId, edrmsNo, version, reason}) {
    if (!documentId || !version) return [];
    const pinning =
      (await this.repo.findRecordsPinning([documentId])).get(documentId) || [];
    const flagged = [];
    for (const recordId of new Set(pinning.map(p => p.recordId))) {
      const record = await this.repo.getRecord(recordId);
      const live = [record.currentVersion, record.draftVersion].filter(Boolean);
      const versions = await Promise.all(
        live.map(n => this.repo.getVersion(recordId, n)),
      );
      const pinned = versions.flatMap(v =>
        (v.data.documents || []).filter(d => d.edrmsDocumentId === documentId),
      );
      const from = Math.min(...pinned.map(d => d.version));
      if (!pinned.length || from >= version) continue;
      const existing = (record.flags || []).find(
        f => f.type === 'document_updated' && f.edrmsDocumentId === documentId,
      );
      if (existing && existing.to >= version) continue;
      const flag = {
        type: 'document_updated',
        edrmsDocumentId: documentId,
        edrmsNo: edrmsNo ?? pinned[0].edrmsNo,
        ref: pinned[0].ref ?? null,
        from,
        to: version,
        ...(reason ? {reason} : {}),
        at: this.clock().toISOString(),
        message: `Document updated: ${edrmsNo ?? pinned[0].edrmsNo} v${from} → v${version}. Review needed.`,
      };
      const flags = [...(record.flags || []).filter(f => f !== existing), flag];
      // the flag and its event are committed together (API-613)
      await this.atomic(async () => {
        await this.repo.updateRecord(recordId, {flags});
        // the open draft's checks show it at once (documents_current); its data is unchanged
        const draft = versions.find(
          v => v.versionNumber === record.draftVersion && v.state === 'draft',
        );
        if (draft) {
          await this.repo.updateVersion(recordId, draft.versionNumber, {
            checks: checksFor(draft.data, {flags}),
          });
        }
        await this.events?.publish('records.record.flagged', {
          recordId,
          recordNo: record.recordNo,
          flag,
        });
      });
      flagged.push(recordId);
    }
    return flagged;
  },

  // ---------------------------------------------------------------- new documents (API-766)

  /**
   * edrms filed a new document (`edrms.document.filed`). Every record it is about and does not
   * hold yet is flagged "new document": by its property (the rule of the parcel check), or as the
   * next link in the record's chain (it names a title deed of the record as its prior title).
   * Nothing in the record changes by itself. A repeated event, or a flag dismissed before, raises
   * no new flag.
   */
  async onDocumentFiled({documentId, edrmsNo, docType, instrumentRef, props}) {
    if (!documentId) return [];
    const fields = props || {};
    const matchedBy = new Map(); // record id → 'property' | 'chain'

    // 1. the property describes the record's parcel: the records with that parcel number, checked
    const parcel = parcelFromProperty(fields.property, fields);
    const number = parcel?.number ?? parcel?.farmNumber;
    if (number) {
      const {items} = await this.repo.listRecords({
        q: String(number),
        match: 'parcel',
        limit: 200,
      });
      for (const r of items) {
        const v = await this.repo.getVersion(
          r.id,
          r.draftVersion ?? r.currentVersion,
        );
        if (v && propertyMatches(v.data.parcel, fields.property)) {
          matchedBy.set(r.id, 'property');
        }
      }
    }
    // 2. it names a title deed in a record as its prior title
    if (fields.priorTitle && this.edrms) {
      const {items} = await this.edrms.searchDocuments({
        fields: {deedNo: fields.priorTitle},
      });
      const pins = await this.repo.findRecordsPinning(items.map(d => d.id));
      for (const list of pins.values()) {
        for (const p of list) {
          if (!matchedBy.has(p.recordId)) matchedBy.set(p.recordId, 'chain');
        }
      }
    }

    const holding = new Set(
      (
        (await this.repo.findRecordsPinning([documentId])).get(documentId) || []
      ).map(p => p.recordId),
    );
    const flagged = [];
    for (const [recordId, by] of matchedBy) {
      if (holding.has(recordId)) continue;
      const record = await this.repo.getRecord(recordId);
      const known = [
        ...(record.flags || []),
        ...(record.flagLog || []).map(e => e.flag),
      ].some(
        f => f.type === 'document_filed' && f.edrmsDocumentId === documentId,
      );
      if (known) continue;
      const flag = {
        type: 'document_filed',
        edrmsDocumentId: documentId,
        edrmsNo,
        ref: instrumentRef ?? null,
        docType: docType ?? null,
        matchedBy: by,
        at: this.clock().toISOString(),
        message: `New document for this parcel: ${instrumentRef || edrmsNo}. Open a change to add it.`,
      };
      // the flag and its event are committed together (API-613)
      await this.atomic(async () => {
        await this.repo.updateRecord(recordId, {
          flags: [...(record.flags || []), flag],
        });
        await this.events?.publish('records.record.flagged', {
          recordId,
          recordNo: record.recordNo,
          flag,
        });
      });
      flagged.push(recordId);
    }
    return flagged;
  },

  /**
   * An officer dismisses a "new document" flag, with the reason (the document is about another
   * parcel, say). The flag moves to the record's flag log, with who dismissed it, when and why.
   * (The log also keeps the flags whose document went into a draft: `outcome: 'added'`.)
   */
  async dismissFlag(recordId, {edrmsDocumentId, reason}, actor = SYSTEM) {
    const record = await this.requireRecord(recordId);
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestError('Give the reason for dismissing it');
    const flag = (record.flags || []).find(
      f => f.type === 'document_filed' && f.edrmsDocumentId === edrmsDocumentId,
    );
    if (!flag) {
      throw new NotFoundError('The record has no new-document flag for it');
    }
    const entry = {
      flag,
      outcome: 'dismissed',
      dismissedAt: this.clock().toISOString(),
      dismissedById: actor.id,
      dismissedByName: actor.name ?? null,
      reason: why,
    };
    // the change and its event are committed together (API-613)
    await this.atomic(async () => {
      await this.repo.updateRecord(recordId, {
        flags: record.flags.filter(f => f !== flag),
        flagLog: [...(record.flagLog || []), entry],
        updatedAt: this.clock(),
      });
      await this.events?.publish(
        'records.record.flag-dismissed',
        {recordId, recordNo: record.recordNo, ...entry},
        {actor},
      );
    });
    return this.getRecord(recordId);
  },
};

/**
 * The flags still open once `data` is committed: a "document updated" flag stays while that
 * document is in the record at an older version than the corrected one; a "new document" flag
 * while that document is not in the record.
 */
function openFlags(flags = [], data) {
  const docs = data.documents || [];
  return flags.filter(f => {
    if (f.type === 'document_updated') {
      return docs.some(
        d => d.edrmsDocumentId === f.edrmsDocumentId && d.version < f.to,
      );
    }
    if (f.type === 'document_filed') {
      return !docs.some(d => d.edrmsDocumentId === f.edrmsDocumentId);
    }
    return true;
  });
}

/**
 * The "new document" flags once a draft (version `versionNumber`) holds `data` (API-766): a flag
 * whose document is in the draft moves to the flag log as added; one added to this draft whose
 * document was taken out again comes back. `{flags, flagLog}` when either changes, else `{}`.
 */
export function settleFiled(record, data, versionNumber, change) {
  const inDraft = id =>
    (data.documents || []).some(d => d.edrmsDocumentId === id);
  const flags = record.flags || [];
  const log = record.flagLog || [];
  const added = flags.filter(
    f => f.type === 'document_filed' && inDraft(f.edrmsDocumentId),
  );
  const back = log.filter(
    e =>
      e.outcome === 'added' &&
      e.versionNumber === versionNumber &&
      !inDraft(e.flag.edrmsDocumentId),
  );
  if (!added.length && !back.length) return {};
  return {
    flags: [...flags.filter(f => !added.includes(f)), ...back.map(e => e.flag)],
    flagLog: [
      ...log.filter(e => !back.includes(e)),
      ...added.map(flag => ({
        flag,
        outcome: 'added',
        versionNumber,
        at: change.at,
        byId: change.byId,
        byName: change.byName,
      })),
    ],
  };
}
