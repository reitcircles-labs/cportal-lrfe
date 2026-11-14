import {randomUUID} from 'node:crypto';
import {BadRequestError} from '@lrfe/common';
import {
  assertBillOfLading,
  billOfLadingHash,
  formatNamed,
} from '@lrfe/domain-shipping/bill-of-lading';
import {KINDS, TITLE_WORDING, kindOf} from '@lrfe/domain-shipping/title';
import {sealOf} from '@lrfe/record-contract/seal';

/**
 * The versions the title engine commits itself (CB-35, README.md "The title"): an amendment's new
 * version of a B/L and the first version of each B/L a split makes. They are converted and checked
 * like any document, sealed and chained like a version committed after review, but committed by
 * the engine: the holder's surrender for amendment is the authority, so there is no four-eyes
 * review (the version names no approver).
 */

/**
 * Whether a value is a plain object (not null, not an array).
 * @param {*} value
 * @return {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A B/L of the model from a request's `{format, document, partyOrganisations?}`, converted from
 * its format but not checked yet: 400 without a document, for an unknown format or a format that
 * is off. Without `partyOrganisations` the B/L keeps `links` (the links of the version it
 * replaces or is split from).
 * @param {!ReadonlyArray<object>} formats the B/L formats on in this install
 * @param {*} body
 * @param {?Object} links the organisation links to keep when the body gives none
 * @return {{schemaVersion: string, document: !Object, partyOrganisations: (!Object|undefined)}}
 */
export function convertedDocument(formats, body, links) {
  if (!isObject(body) || !isObject(body.document)) {
    throw new BadRequestError(TITLE_WORDING.missingDocument, {
      code: 'missing-document',
    });
  }
  const {billOfLading} = formatNamed(formats, body.format).toModel(
    body.document,
  );
  const partyOrganisations = body.partyOrganisations ?? links;
  if (partyOrganisations !== undefined && partyOrganisations !== null) {
    billOfLading.partyOrganisations = partyOrganisations;
  }
  return billOfLading;
}

/**
 * Checks that a converted document is a B/L the engine may commit: of the carrier code `carrierCode`
 * (and, when `reference` is given, of that transport document reference), still a negotiable B/L,
 * and valid (400 with every problem).
 * @param {{document: !Object}} billOfLading the converted B/L
 * @param {{carrierCode: string, reference: (string|undefined)}} expected
 * @return {!Object} the same B/L
 */
export function checkedDocument(billOfLading, {carrierCode, reference}) {
  const document = billOfLading.document;
  const sameReference =
    reference === undefined ||
    document.transportDocumentReference === reference;
  if (document.carrierCode !== carrierCode || !sameReference) {
    throw new BadRequestError(TITLE_WORDING.differentReference, {
      code: 'different-reference',
    });
  }
  if (kindOf(document) !== KINDS.NEGOTIABLE) {
    throw new BadRequestError(TITLE_WORDING.kindChanged, {
      code: 'kind-changed',
    });
  }
  return assertBillOfLading(billOfLading);
}

/**
 * A version committed by the engine, sealed after the record's version before it.
 * @param {{
 *   record: {id: string, recordNo: string},
 *   versionNumber: number,
 *   data: !Object,
 *   previous: ?{seal: string},
 *   actor: {id: string, name?: string},
 *   action: string,
 *   at: !Date,
 * }} made `action`: the change log's entry, `amend` or `split`
 * @return {!Object} the version, as the repository stores it
 */
export function engineCommittedVersion({
  record,
  versionNumber,
  data,
  previous,
  actor,
  action,
  at,
}) {
  const version = {
    id: randomUUID(),
    recordId: record.id,
    versionNumber,
    state: 'committed',
    revision: 1,
    data,
    documentHash: billOfLadingHash(data),
    changes: [
      {
        at: at.toISOString(),
        byId: actor.id,
        byName: actor.name ?? null,
        action,
        via: 'title',
      },
    ],
    reviewComment: null,
    createdAt: at,
    createdById: actor.id,
    createdByName: actor.name ?? null,
    updatedAt: at,
    submittedAt: at,
    submittedById: actor.id,
    submittedByName: actor.name ?? null,
    approvedById: null,
    approvedByName: null,
    committedAt: at,
    previousSeal: previous?.seal ?? null,
  };
  return {...version, seal: sealOf(record, version)};
}

/**
 * The event of a version the engine committed, `records.record.committed`, as a commit after
 * review publishes it: no approver.
 * @param {{id: string, recordNo: string}} record
 * @param {!Object} version
 * @param {{id: string, name?: string}} actor
 * @return {!Object}
 */
export function committedEventOf(record, version, actor) {
  return {
    recordId: record.id,
    recordNo: record.recordNo,
    versionNumber: version.versionNumber,
    seal: version.seal,
    previousSeal: version.previousSeal,
    submittedBy: {id: actor.id, name: actor.name ?? null},
    approvedBy: null,
    documentHash: version.documentHash,
  };
}
