/**
 * The new B/L form of the shipping app (CB-44): its fields, what is missing before it can be
 * sent, and the DCSA 3.0 transport document it sends. Only what a B/L in good weather needs: one
 * container and its cargo, the voyage, the shipper and, when not to order, the consignee; the rest
 * of the document takes fixed values (an electronic B/L, shipped on board, freight prepaid at the
 * port of loading, container yard to container yard, full loads). The record service checks the
 * document against DCSA and names every problem; this form only checks that nothing is missing.
 * Tested by bl-draft.test.ts (`npm run test:shipping`).
 */
import type {DraftVersion, PartyOrganisation} from './bl.model';

/** The B/L format the form writes (one of the record service's formats, `LRFE_BL_FORMATS`). */
export const DRAFT_FORMAT = 'dcsa-3.0';

/** The fields of the form, as typed. */
export interface DraftForm {
  /** The transport document reference: the B/L's number. */
  reference: string;
  /** The carrier's code (SMDG's list). */
  carrierCode: string;
  bookingReference: string;
  /** A B/L to order (negotiable), or to a named consignee (straight). */
  toOrder: boolean;
  /** The organisations of the shipper and of the consignee. */
  shipperId: string;
  consigneeId: string;
  /** Where the carrier issues it: its street, city and country code. */
  issuerStreet: string;
  issuerCity: string;
  issuerCountry: string;
  vesselName: string;
  voyageNumber: string;
  /** UN/LOCODEs. */
  portOfLoading: string;
  portOfDischarge: string;
  /** Planned dates, `yyyy-mm-dd`. */
  departureDate: string;
  arrivalDate: string;
  containerNumber: string;
  /** The container's ISO size and type code. */
  isoEquipmentCode: string;
  sealNumber: string;
  goods: string;
  hsCode: string;
  packages: number | null;
  packageDescription: string;
  grossWeightKg: number | null;
  termsAndConditions: string;
}

/** A field the form cannot send yet, and why. */
export interface DraftProblem {
  field: keyof DraftForm;
  message: string;
}

/** Who drafts the B/L, and the organisations it may name. */
export interface DraftContext {
  /** The carrier's name: the user's organisation. */
  carrierName: string;
  /** The person to contact about the B/L: the user. */
  contact: {name: string; email: string};
  organisations: readonly PartyOrganisation[];
}

/** What the record service is sent to create the B/L. */
export interface DraftRequest {
  format: string;
  document: Record<string, unknown>;
  partyOrganisations: Record<string, string>;
}

/** The text fields every B/L needs, each with its name in a message. */
const REQUIRED_TEXT: ReadonlyArray<[keyof DraftForm, string]> = [
  ['reference', 'the B/L number'],
  ['carrierCode', 'the carrier code'],
  ['bookingReference', 'the booking reference'],
  ['shipperId', 'the shipper'],
  ['issuerStreet', 'the street of the place of issue'],
  ['issuerCity', 'the city of the place of issue'],
  ['issuerCountry', 'the country of the place of issue'],
  ['vesselName', 'the vessel'],
  ['voyageNumber', 'the voyage'],
  ['portOfLoading', 'the port of loading'],
  ['portOfDischarge', 'the port of discharge'],
  ['departureDate', 'the departure date'],
  ['arrivalDate', 'the arrival date'],
  ['containerNumber', 'the container number'],
  ['isoEquipmentCode', 'the container type'],
  ['goods', 'the goods'],
  ['hsCode', 'the HS code'],
  ['packageDescription', 'the kind of packages'],
  ['termsAndConditions', 'the terms and conditions'],
];

/** The number fields, which must be more than zero. */
const POSITIVE_NUMBERS: ReadonlyArray<[keyof DraftForm, string]> = [
  ['packages', 'the number of packages'],
  ['grossWeightKg', 'the gross weight'],
];

/** The carrier's terms the form starts with, to be replaced by the carrier's own. */
const DEFAULT_TERMS =
  'Carried under the terms and conditions of the carrier, which are part of this bill of lading.';

/**
 * The shipment-specific fields left empty when copying a B/L into a new draft (CB-69):
 * B/L number, booking reference, container number and seal number.
 */
export const COPY_BLANK_FIELDS: ReadonlyArray<keyof DraftForm> = [
  'reference',
  'bookingReference',
  'containerNumber',
  'sealNumber',
];

/**
 * A new, empty form: to order, a 20-foot general purpose container (22G1), the carrier's terms
 * to complete.
 * @return the form
 */
export function emptyDraftForm(): DraftForm {
  return {
    reference: '',
    carrierCode: '',
    bookingReference: '',
    toOrder: true,
    shipperId: '',
    consigneeId: '',
    issuerStreet: '',
    issuerCity: '',
    issuerCountry: '',
    vesselName: '',
    voyageNumber: '',
    portOfLoading: '',
    portOfDischarge: '',
    departureDate: '',
    arrivalDate: '',
    containerNumber: '',
    isoEquipmentCode: '22G1',
    sealNumber: '',
    goods: '',
    hsCode: '',
    packages: null,
    packageDescription: '',
    grossWeightKg: null,
    termsAndConditions: DEFAULT_TERMS,
  };
}

/**
 * A text field, trimmed.
 * @param value the field
 * @return the text
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The fields that are missing or wrong, in the form's order: an empty one, a number not above
 * zero, an arrival before the departure, a consignee missing from a B/L not to order, a party that
 * is not one of the organisations listed (when a list is given).
 * @param form the form
 * @param organisations the organisations it may name; not checked when not given
 * @return the problems, none when it can be sent
 */
export function draftProblems(
  form: DraftForm,
  organisations?: readonly PartyOrganisation[],
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  for (const [field, name] of REQUIRED_TEXT) {
    if (textOf(form[field]) === '') {
      problems.push({field, message: `Fill in ${name}.`});
    }
  }
  for (const [field, name] of POSITIVE_NUMBERS) {
    const value = form[field];
    if (typeof value !== 'number' || !(value > 0)) {
      problems.push({field, message: `Give ${name}, more than zero.`});
    }
  }
  const departure = textOf(form.departureDate);
  const arrival = textOf(form.arrivalDate);
  if (departure !== '' && arrival !== '' && arrival < departure) {
    problems.push({
      field: 'arrivalDate',
      message: 'The arrival cannot be before the departure.',
    });
  }
  if (!form.toOrder && textOf(form.consigneeId) === '') {
    problems.push({
      field: 'consigneeId',
      message: 'A B/L that is not to order names its consignee: pick one.',
    });
  }
  if (organisations !== undefined) {
    const known = new Set(organisations.map(o => o.id));
    const shipper = textOf(form.shipperId);
    if (shipper !== '' && !known.has(shipper)) {
      problems.push({
        field: 'shipperId',
        message: 'Pick the shipper from the organisations listed.',
      });
    }
    const consignee = textOf(form.consigneeId);
    if (!form.toOrder && consignee !== '' && !known.has(consignee)) {
      problems.push({
        field: 'consigneeId',
        message: 'Pick the consignee from the organisations listed.',
      });
    }
  }
  return problems;
}

/**
 * A party of the document: the organisation's name.
 * @param id the organisation
 * @param organisations the organisations listed
 * @return the party
 */
function partyOf(
  id: string,
  organisations: readonly PartyOrganisation[],
): {partyName: string} {
  const organisation = organisations.find(o => o.id === id);
  return {partyName: organisation?.name ?? id};
}

/**
 * The consignee of the document: the organisation's name, and its code on the platform as its
 * identifying code, which DCSA requires of a consignee (a code list agreed between the parties,
 * `ZZZ`).
 * @param id the organisation
 * @param organisations the organisations listed
 * @return the party
 */
function consigneeOf(
  id: string,
  organisations: readonly PartyOrganisation[],
): Record<string, unknown> {
  const organisation = organisations.find(o => o.id === id);
  return {
    ...partyOf(id, organisations),
    identifyingCodes: [
      {
        codeListProvider: 'ZZZ',
        codeListName: 'organisation',
        partyCode: organisation?.code ?? id,
      },
    ],
  };
}

/**
 * The request that creates the B/L: the DCSA 3.0 transport document of the form, and the
 * organisations of its shipper and (when not to order) its consignee. Codes are sent in capitals.
 * @param form the form, with no problem left
 * @param context who drafts it, and the organisations listed
 * @return the request
 */
export function draftRequest(
  form: DraftForm,
  context: DraftContext,
): DraftRequest {
  const shipperId = textOf(form.shipperId);
  const consigneeId = form.toOrder ? '' : textOf(form.consigneeId);
  const container = textOf(form.containerNumber).toUpperCase();
  const portOfLoading = {
    UNLocationCode: textOf(form.portOfLoading).toUpperCase(),
  };
  const documentParties: Record<string, unknown> = {
    shipper: partyOf(shipperId, context.organisations),
    issuingParty: {
      partyName: context.carrierName,
      address: {
        street: textOf(form.issuerStreet),
        city: textOf(form.issuerCity),
        countryCode: textOf(form.issuerCountry).toUpperCase(),
      },
    },
  };
  const partyOrganisations: Record<string, string> = {shipper: shipperId};
  if (consigneeId !== '') {
    documentParties['consignee'] = consigneeOf(
      consigneeId,
      context.organisations,
    );
    partyOrganisations['consignee'] = consigneeId;
  }
  const equipment: Record<string, unknown> = {isShipperOwned: false};
  const seal = textOf(form.sealNumber);
  if (seal !== '') {
    equipment['seals'] = [{number: seal}];
  }
  equipment['equipment'] = {
    ISOEquipmentCode: textOf(form.isoEquipmentCode).toUpperCase(),
    equipmentReference: container,
  };
  const document: Record<string, unknown> = {
    transportDocumentReference: textOf(form.reference),
    transportDocumentTypeCode: 'BOL',
    isShippedOnBoardType: true,
    freightPaymentTermCode: 'PRE',
    isElectronic: true,
    isToOrder: form.toOrder,
    termsAndConditions: textOf(form.termsAndConditions),
    receiptTypeAtOrigin: 'CY',
    deliveryTypeAtDestination: 'CY',
    cargoMovementTypeAtOrigin: 'FCL',
    cargoMovementTypeAtDestination: 'FCL',
    carrierCode: textOf(form.carrierCode).toUpperCase(),
    carrierCodeListProvider: 'SMDG',
    transports: {
      plannedDepartureDate: textOf(form.departureDate),
      plannedArrivalDate: textOf(form.arrivalDate),
      portOfLoading,
      portOfDischarge: {
        UNLocationCode: textOf(form.portOfDischarge).toUpperCase(),
      },
      vesselVoyages: [
        {
          vesselName: textOf(form.vesselName),
          carrierExportVoyageNumber: textOf(form.voyageNumber),
        },
      ],
    },
    invoicePayableAt: {...portOfLoading},
    partyContactDetails: [
      {name: context.contact.name, email: context.contact.email},
    ],
    documentParties,
    consignmentItems: [
      {
        carrierBookingReference: textOf(form.bookingReference),
        descriptionOfGoods: [textOf(form.goods)],
        HSCodes: [textOf(form.hsCode)],
        cargoItems: [
          {
            equipmentReference: container,
            cargoGrossWeight: {value: form.grossWeightKg, unit: 'KGM'},
            outerPackaging: {
              numberOfPackages: form.packages,
              description: textOf(form.packageDescription),
            },
          },
        ],
      },
    ],
    utilizedTransportEquipments: [equipment],
  };
  return {format: DRAFT_FORMAT, document, partyOrganisations};
}

/**
 * Reads an object property as a record, or an empty object.
 * @param value the parent value
 * @param key the property name
 * @return the nested record
 */
function obj(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return {};
  }
  const child = (value as Record<string, unknown>)[key];
  return child !== null && typeof child === 'object'
    ? (child as Record<string, unknown>)
    : {};
}

/**
 * Reads a positive number from an unknown value, or null.
 * @param value the value
 * @return the number, or null
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Fills the B/L form from a saved draft version (CB-70).
 * @param version the draft version
 * @return the form
 */
export function draftFormOf(
  version: DraftVersion | null | undefined,
): DraftForm {
  const doc = version?.data?.document ?? {};
  const parties = version?.data?.partyOrganisations ?? {};
  const docParties = obj(doc, 'documentParties');
  const issuingAddress = obj(obj(docParties, 'issuingParty'), 'address');
  const transports = obj(doc, 'transports');
  const voyages = Array.isArray(transports['vesselVoyages'])
    ? (transports['vesselVoyages'] as unknown[])
    : [];
  const voyage =
    voyages[0] !== null && typeof voyages[0] === 'object'
      ? (voyages[0] as Record<string, unknown>)
      : {};
  const equipments = Array.isArray(doc['utilizedTransportEquipments'])
    ? (doc['utilizedTransportEquipments'] as unknown[])
    : [];
  const equipEntry =
    equipments[0] !== null && typeof equipments[0] === 'object'
      ? (equipments[0] as Record<string, unknown>)
      : {};
  const equipment = obj(equipEntry, 'equipment');
  const seals = Array.isArray(equipEntry['seals'])
    ? (equipEntry['seals'] as unknown[])
    : [];
  const firstSeal =
    seals[0] !== null && typeof seals[0] === 'object'
      ? (seals[0] as Record<string, unknown>)
      : {};
  const consignments = Array.isArray(doc['consignmentItems'])
    ? (doc['consignmentItems'] as unknown[])
    : [];
  const consignment =
    consignments[0] !== null && typeof consignments[0] === 'object'
      ? (consignments[0] as Record<string, unknown>)
      : {};
  const goods = Array.isArray(consignment['descriptionOfGoods'])
    ? (consignment['descriptionOfGoods'] as unknown[])
    : [];
  const hsCodes = Array.isArray(consignment['HSCodes'])
    ? (consignment['HSCodes'] as unknown[])
    : [];
  const cargoItems = Array.isArray(consignment['cargoItems'])
    ? (consignment['cargoItems'] as unknown[])
    : [];
  const cargo =
    cargoItems[0] !== null && typeof cargoItems[0] === 'object'
      ? (cargoItems[0] as Record<string, unknown>)
      : {};
  const grossWeight = obj(cargo, 'cargoGrossWeight');
  const packaging = obj(cargo, 'outerPackaging');
  const defaults = emptyDraftForm();
  const toOrder = doc['isToOrder'] !== false;
  return {
    reference: textOf(doc['transportDocumentReference']),
    carrierCode: textOf(doc['carrierCode']),
    bookingReference: textOf(consignment['carrierBookingReference']),
    toOrder,
    shipperId: textOf(parties['shipper']),
    consigneeId: toOrder ? '' : textOf(parties['consignee']),
    issuerStreet: textOf(issuingAddress['street']),
    issuerCity: textOf(issuingAddress['city']),
    issuerCountry: textOf(issuingAddress['countryCode']),
    vesselName: textOf(voyage['vesselName']),
    voyageNumber: textOf(voyage['carrierExportVoyageNumber']),
    portOfLoading: textOf(obj(transports, 'portOfLoading')['UNLocationCode']),
    portOfDischarge: textOf(
      obj(transports, 'portOfDischarge')['UNLocationCode'],
    ),
    departureDate: textOf(transports['plannedDepartureDate']),
    arrivalDate: textOf(transports['plannedArrivalDate']),
    containerNumber: textOf(equipment['equipmentReference']),
    isoEquipmentCode:
      textOf(equipment['ISOEquipmentCode']) || defaults.isoEquipmentCode,
    sealNumber: textOf(firstSeal['number']),
    goods: textOf(goods[0]),
    hsCode: textOf(hsCodes[0]),
    packages: numberOrNull(packaging['numberOfPackages']),
    packageDescription: textOf(packaging['description']),
    grossWeightKg: numberOrNull(grossWeight['value']),
    termsAndConditions:
      textOf(doc['termsAndConditions']) || defaults.termsAndConditions,
  };
}

/**
 * Fills the B/L form from an existing B/L version for a new copy (CB-69), leaving the
 * shipment-specific fields empty so the clerk supplies them.
 * @param version the original B/L's latest version
 * @return the pre-filled form
 */
export function copyFormOf(
  version: DraftVersion | null | undefined,
): DraftForm {
  return {
    ...draftFormOf(version),
    reference: '',
    bookingReference: '',
    containerNumber: '',
    sealNumber: '',
  };
}

/**
 * The problems a refusal of the record service names (`details.problems`), each with its place in
 * the document when it has one.
 * @param details the refusal's details
 * @return one line per problem, none when it names none
 */
export function problemMessages(details: unknown): string[] {
  if (details === null || typeof details !== 'object') {
    return [];
  }
  const problems = (details as {problems?: unknown}).problems;
  if (!Array.isArray(problems)) {
    return [];
  }
  const lines: string[] = [];
  for (const problem of problems as unknown[]) {
    const {path: where, message: what} = (problem ?? {}) as {
      path?: unknown;
      message?: unknown;
    };
    const path = textOf(where);
    const message = textOf(what);
    lines.push(path === '' ? message : `${path}: ${message}`);
  }
  return lines;
}
