import {BadRequestError, canonicalJson, sha256Hex} from '@lrfe/common';

import {LEFT_OUT_FIELDS, transportDocumentValidator} from './dcsa-schema.js';

/**
 * The internal model of a bill of lading (CB-25, docs/dcsa-field-map.md). A B/L is held as
 *
 *     {schemaVersion: 'dcsa-ebl/3.0', document: {...}, partyOrganisations: {shipper: 'org-…'}}
 *
 * - `document`: DCSA eBL 3.0's TransportDocument with DCSA's own names and rules, without
 *   `transportDocumentStatus` (the title engine's) and `feedbacks` (API messages).
 * - `schemaVersion`: the model the document follows; a later DCSA version gets its own value.
 * - `partyOrganisations`: optional, the platform organisation (CB-18) of a party of the document,
 *   by its place in `documentParties` (`shipper`, `notifyParties.0`). Kept outside the document so
 *   the document stays exactly DCSA's.
 *
 * Only container B/Ls (decided 2026-11-14): every cargo item is in one of the B/L's containers.
 */

/** The schema version of every B/L of this model. */
export const SCHEMA_VERSION = 'dcsa-ebl/3.0';

/** The single parties of `documentParties`, which `partyOrganisations` may name. */
const SINGLE_PARTIES = [
  'shipper',
  'onBehalfOfShipper',
  'consignee',
  'onBehalfOfConsignee',
  'endorsee',
  'issuingParty',
  'carriersAgentAtDestination',
];

/** A list index in a path. */
const INDEX = /^\d+$/;

/** Where a document lists its containers. */
const CONTAINER_LIST = 'utilizedTransportEquipments';

/** The lists of parties of `documentParties`, named with their index (`notifyParties.0`). */
const LISTED_PARTIES = ['notifyParties', 'other'];

/**
 * A path in a document as a reader writes it: `/consignmentItems/0/cargoItems/1` →
 * `consignmentItems[0].cargoItems[1]`.
 *
 * @param {string} pointer a JSON pointer ('' for the document itself)
 * @return {string} the path, or "the document"
 */
function readablePath(pointer) {
  if (!pointer) {
    return 'the document';
  }
  let path = '';
  for (const encoded of pointer.slice(1).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (INDEX.test(part)) {
      path += `[${part}]`;
    } else if (path === '') {
      path = part;
    } else {
      path += `.${part}`;
    }
  }
  return path;
}

/**
 * Whether the document has the party a link names: a single party (`shipper`) or one of a list
 * (`notifyParties.0`).
 *
 * @param {object} parties the document's `documentParties`
 * @param {string} name the party's name in `partyOrganisations`
 * @return {boolean}
 */
function hasParty(parties, name) {
  if (SINGLE_PARTIES.includes(name)) {
    return Boolean(parties[name]);
  }
  const [list, index, ...rest] = name.split('.');
  if (!LISTED_PARTIES.includes(list) || !INDEX.test(index ?? '')) {
    return false;
  }
  return rest.length === 0 && Boolean(parties[list]?.[Number(index)]);
}

/**
 * One validator error as a problem a person can act on.
 *
 * @param {import('ajv').ErrorObject} error
 * @return {{path: string, message: string}}
 */
function problemOf(error) {
  const path = readablePath(error.instancePath);
  if (error.keyword === 'required') {
    const field = error.params.missingProperty;
    const where = error.instancePath ? `${path}.${field}` : field;
    return {path: where, message: `${where} is missing (DCSA requires it)`};
  }
  if (error.keyword === 'enum') {
    const allowed = error.params.allowedValues.join(', ');
    return {path, message: `${path} must be one of: ${allowed}`};
  }
  return {path, message: `${path} ${error.message}`};
}

/**
 * The containers-only rule: at least one container, each listed once, and every cargo item in one
 * of them.
 *
 * @param {object} document
 * @return {Array<{path: string, message: string}>}
 */
function containerProblems(document) {
  const equipments = document.utilizedTransportEquipments;
  if (!Array.isArray(equipments) || equipments.length === 0) {
    return [
      {
        path: CONTAINER_LIST,
        message:
          'This platform holds B/Ls for goods in containers only: ' +
          'list at least one container in utilizedTransportEquipments',
      },
    ];
  }
  const problems = [];
  const containers = new Set();
  equipments.forEach((equipment, i) => {
    const reference = equipment?.equipment?.equipmentReference;
    if (typeof reference !== 'string') {
      return; // the schema check names the missing reference
    }
    if (containers.has(reference)) {
      problems.push({
        path: `utilizedTransportEquipments[${i}]`,
        message: `Container ${reference} is listed more than once`,
      });
    }
    containers.add(reference);
  });
  (document.consignmentItems ?? []).forEach((item, i) => {
    (item?.cargoItems ?? []).forEach((cargo, j) => {
      const reference = cargo?.equipmentReference;
      if (typeof reference === 'string' && !containers.has(reference)) {
        const path = `consignmentItems[${i}].cargoItems[${j}]`;
        problems.push({
          path,
          message:
            `This platform holds B/Ls for goods in containers only: ${path} is in ` +
            `container ${reference}, which is not one of this B/L's containers`,
        });
      }
    });
  });
  return problems;
}

/**
 * DCSA's conditions written in its field descriptions, which a schema cannot say: who the goods
 * are consigned to, and that a sea waybill is never to order.
 *
 * @param {object} document
 * @return {Array<{path: string, message: string}>}
 */
function partyProblems(document) {
  const problems = [];
  const parties = document.documentParties ?? {};
  if (
    document.transportDocumentTypeCode === 'SWB' &&
    document.isToOrder === true
  ) {
    problems.push({
      path: 'isToOrder',
      message:
        'A sea waybill (SWB) cannot be to order: isToOrder must be false',
    });
  }
  if (document.isToOrder === false && !parties.consignee) {
    problems.push({
      path: 'documentParties.consignee',
      message: 'A B/L that is not to order must name its consignee',
    });
  }
  if (document.isToOrder === false && parties.endorsee) {
    problems.push({
      path: 'documentParties.endorsee',
      message: 'Only a B/L to order can have an endorsee',
    });
  }
  if (parties.consignee && parties.endorsee) {
    problems.push({
      path: 'documentParties',
      message: 'A B/L names a consignee or an endorsee, not both',
    });
  }
  return problems;
}

/**
 * The links of parties to platform organisations: each names a party the document has.
 *
 * @param {*} links the record's `partyOrganisations`
 * @param {object} document
 * @return {Array<{path: string, message: string}>}
 */
function organisationProblems(links, document) {
  if (links === undefined) {
    return [];
  }
  if (!links || typeof links !== 'object' || Array.isArray(links)) {
    return [
      {
        path: 'partyOrganisations',
        message: 'partyOrganisations must be an object',
      },
    ];
  }
  const parties = document.documentParties ?? {};
  const problems = [];
  for (const [party, organisationId] of Object.entries(links)) {
    const path = `partyOrganisations.${party}`;
    if (!hasParty(parties, party)) {
      problems.push({
        path,
        message: `${path}: the document has no party ${party}`,
      });
    }
    if (typeof organisationId !== 'string' || organisationId.trim() === '') {
      problems.push({path, message: `${path} must be an organisation id`});
    }
  }
  return problems;
}

/**
 * Everything wrong with a B/L, or nothing. Checks the schema version, DCSA's schema (required
 * fields, formats, code lists), the containers-only rule, DCSA's party conditions and the
 * organisation links.
 *
 * @param {*} billOfLading a B/L of this model
 * @return {Array<{path: string, message: string}>} the problems, empty when the B/L is valid
 */
export function checkBillOfLading(billOfLading) {
  if (
    !billOfLading ||
    typeof billOfLading !== 'object' ||
    Array.isArray(billOfLading)
  ) {
    return [{path: '', message: 'A B/L must be an object'}];
  }
  const {schemaVersion, document, partyOrganisations} = billOfLading;
  const problems = [];
  if (schemaVersion !== SCHEMA_VERSION) {
    problems.push({
      path: 'schemaVersion',
      message: `schemaVersion must be ${SCHEMA_VERSION}`,
    });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    problems.push({
      path: 'document',
      message: 'document must be a DCSA transport document',
    });
    return problems;
  }
  for (const field of LEFT_OUT_FIELDS) {
    if (field in document) {
      problems.push({
        path: field,
        message: `${field} is not part of a stored B/L (the platform keeps it apart)`,
      });
    }
  }
  problems.push(...containerProblems(document));
  const validate = transportDocumentValidator();
  if (!validate(document)) {
    const listExplained = problems.some(p => p.path === CONTAINER_LIST);
    for (const problem of validate.errors.map(problemOf)) {
      // The containers-only rule already explains a missing or empty container list.
      if (!(listExplained && problem.path === CONTAINER_LIST)) {
        problems.push(problem);
      }
    }
  }
  problems.push(...partyProblems(document));
  problems.push(...organisationProblems(partyOrganisations, document));
  return problems;
}

/**
 * The B/L when it is valid; a 400 error listing every problem otherwise.
 *
 * @param {*} billOfLading a B/L of this model
 * @return {object} the same B/L
 * @throws {BadRequestError} with `details.problems`
 */
export function assertBillOfLading(billOfLading) {
  const problems = checkBillOfLading(billOfLading);
  if (problems.length > 0) {
    const more =
      problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    throw new BadRequestError(
      `This B/L is not valid: ${problems[0].message}${more}`,
      {
        problems,
      },
    );
  }
  return billOfLading;
}

/**
 * The canonical form of a B/L: its schema version and document as JSON with object keys sorted at
 * every level (the platform's `canonicalJson`, as the audit trail uses). The same B/L always gives
 * the same text, whatever the order its fields came in. `partyOrganisations` is not part of it:
 * linking a party to an organisation does not change the document.
 *
 * @param {{schemaVersion: string, document: object}} billOfLading
 * @return {string}
 */
export function canonicalBillOfLading({schemaVersion, document}) {
  return canonicalJson({schemaVersion, document});
}

/**
 * The SHA-256 of a B/L's canonical form, as lowercase hex: what a version of the B/L is known by
 * on the audit trail and in the chain of title.
 *
 * @param {{schemaVersion: string, document: object}} billOfLading
 * @return {string}
 */
export function billOfLadingHash(billOfLading) {
  return sha256Hex(canonicalBillOfLading(billOfLading));
}
