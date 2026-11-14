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
 * The converter between DCSA eBL 3.0's TransportDocument and the internal model (CB-26). The
 * internal model keeps DCSA's names (docs/dcsa-field-map.md), so the conversion only moves the
 * two fields the model keeps apart: the status (the title engine's) and the feedbacks (API
 * messages, dropped). Works for every 3.0.x release.
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
   * A B/L of the model as a DCSA transport document, with the status the platform holds for it.
   *
   * @param {{schemaVersion: string, document: object}} billOfLading
   * @param {{status: string}} options the DCSA status to write (DCSA requires one)
   * @return {object} a DCSA TransportDocument
   */
  fromModel(billOfLading, {status}) {
    if (billOfLading.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `DCSA 3.0 writes B/Ls of ${SCHEMA_VERSION}, not ${billOfLading.schemaVersion}`,
      );
    }
    if (!DCSA_STATUSES.includes(status)) {
      throw new Error(`Not a DCSA 3.0 status: ${status}`);
    }
    return {
      transportDocumentStatus: status,
      ...structuredClone(billOfLading.document),
    };
  },
});
