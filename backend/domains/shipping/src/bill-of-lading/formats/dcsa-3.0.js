import {BadRequestError} from '@lrfe/common';

import {SCHEMA_VERSION} from '../model.js';

/**
 * The statuses DCSA eBL 3.0 gives a transport document (`transportDocumentStatus`).
 * @type {ReadonlyArray<string>}
 */
export const DCSA_STATUSES = Object.freeze([
  'DRAFT',
  'APPROVED',
  'ISSUED',
  'PENDING_SURRENDER_FOR_AMENDMENT',
  'SURRENDERED_FOR_AMENDMENT',
  'PENDING_SURRENDER_FOR_DELIVERY',
  'SURRENDERED_FOR_DELIVERY',
  'VOIDED',
]);

/**
 * Lays the endorsee over a copy of a document being written out (CB-37): a party object becomes
 * `documentParties.endorsee`, null leaves any stored endorsee out.
 *
 * @param {object} document the copy being written out, changed in place
 * @param {?object} endorsee a DCSA Endorsee party, or null
 * @throws {Error} when a party is given for a B/L not to order (DCSA allows an endorsee only on
 *     a B/L to order) or one that names a consignee (DCSA allows a consignee or an endorsee, not
 *     both)
 */
function overlayEndorsee(document, endorsee) {
  if (endorsee === null) {
    if (document.documentParties) {
      delete document.documentParties.endorsee;
    }
    return;
  }
  if (document.isToOrder !== true) {
    throw new Error(
      'DCSA 3.0 writes an endorsee only on a B/L to order (isToOrder true)',
    );
  }
  if (document.documentParties?.consignee) {
    throw new Error(
      'DCSA 3.0 writes a consignee or an endorsee, not both: this B/L names a consignee',
    );
  }
  document.documentParties = {
    ...document.documentParties,
    endorsee: structuredClone(endorsee),
  };
}

/**
 * The converter between DCSA eBL 3.0's TransportDocument and the internal model (CB-26). The
 * internal model keeps DCSA's names (docs/dcsa-field-map.md), so the conversion only moves the
 * fields the model keeps apart: the status (the title engine's), the feedbacks (API messages,
 * dropped) and, when writing out, the endorsee (the chain of title's, CB-37). Works for every
 * 3.0.x release.
 * @type {import('./index.js').BillOfLadingFormat}
 */
export const dcsa30 = Object.freeze({
  name: 'dcsa-3.0',
  label: 'DCSA eBL 3.0',

  /**
   * A DCSA transport document as a B/L of the model, with its DCSA status apart.
   *
   * @param {object} external a DCSA TransportDocument
   * @return {{billOfLading: object, status: ?string}}
   * @throws {BadRequestError} when it is not an object
   */
  toModel(external) {
    if (!external || typeof external !== 'object' || Array.isArray(external)) {
      throw new BadRequestError(
        'A DCSA 3.0 transport document must be a JSON object',
      );
    }
    const document = structuredClone(external);
    const status = document.transportDocumentStatus ?? null;
    delete document.transportDocumentStatus;
    delete document.feedbacks; // API messages, not part of a B/L
    return {billOfLading: {schemaVersion: SCHEMA_VERSION, document}, status};
  },

  /**
   * A B/L of the model as a DCSA transport document, with the status the platform holds for it
   * and, for a B/L to order, the endorsee its chain of title gives (CB-37). The endorsee is never
   * stored in the document (Jira CB-37 comment 11579): it is laid over the copy written out.
   *
   * @param {{schemaVersion: string, document: object}} billOfLading
   * @param {{status: string, endorsee: (?object|undefined)}} options the DCSA status to write
   *     (DCSA requires one) and the endorsee: absent, the document as stored; null, no endorsee
   *     (blank endorsed, or not endorsed yet); a DCSA Endorsee party, written as
   *     `documentParties.endorsee`
   * @return {object} a DCSA TransportDocument
   * @throws {Error} on another schema version, a status DCSA does not have, or an endorsee on a
   *     B/L not to order or one that names a consignee
   */
  fromModel(billOfLading, {status, endorsee}) {
    if (billOfLading.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `DCSA 3.0 writes B/Ls of ${SCHEMA_VERSION}, not ${billOfLading.schemaVersion}`,
      );
    }
    if (!DCSA_STATUSES.includes(status)) {
      throw new Error(`Not a DCSA 3.0 status: ${status}`);
    }
    const document = structuredClone(billOfLading.document);
    if (endorsee !== undefined) {
      overlayEndorsee(document, endorsee);
    }
    return {transportDocumentStatus: status, ...document};
  },
});
