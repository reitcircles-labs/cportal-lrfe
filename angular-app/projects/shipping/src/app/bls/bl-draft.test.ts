// Unit tests for the new B/L form of the shipping app (CB-44): which fields it needs, and the
// DCSA transport document it sends (`npm run test:shipping`, Node's test runner).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  COPY_BLANK_FIELDS,
  copyFormOf,
  draftFormOf,
  draftProblems,
  draftRequest,
  emptyDraftForm,
  problemMessages,
  type DraftContext,
  type DraftForm,
} from './bl-draft.ts';

/** The organisations the clerk picks from. */
const EXPORTER = {id: 'org-exporter', code: 'EXP', name: 'Coffee Exporters'};
const BUYER = {id: 'org-buyer', code: 'BUY', name: 'Buyer Trading'};

/** Who drafts, and for which carrier. */
const CONTEXT: DraftContext = {
  carrierName: 'Nordsee Line',
  contact: {name: 'Lena Okafor', email: 'l.okafor@carrier.example'},
  organisations: [EXPORTER, BUYER],
};

/**
 * A form filled in as a clerk would, to order.
 * @param over the fields that differ
 * @return the form
 */
function filled(over: Partial<DraftForm> = {}): DraftForm {
  return {
    ...emptyDraftForm(),
    reference: ' CB44-0001 ',
    carrierCode: 'nsl',
    bookingReference: 'BKG-884120',
    toOrder: true,
    shipperId: EXPORTER.id,
    consigneeId: '',
    issuerStreet: 'Am Kai 4',
    issuerCity: 'Hamburg',
    issuerCountry: 'de',
    vesselName: 'Atlantic Crest',
    voyageNumber: '2611N',
    portOfLoading: 'brssz',
    portOfDischarge: 'NLRTM',
    departureDate: '2026-11-20',
    arrivalDate: '2026-12-08',
    containerNumber: 'msku7045123',
    sealNumber: 'SL220871',
    goods: '640 bags green coffee',
    hsCode: '090111',
    packages: 640,
    packageDescription: 'Bags',
    grossWeightKg: 38040,
    ...over,
  };
}

describe('the new B/L form: its first values', () => {
  it('starts to order, with a 20-foot container and the carrier terms to fill', () => {
    const form = emptyDraftForm();
    assert.equal(form.toOrder, true);
    assert.equal(form.isoEquipmentCode, '22G1');
    assert.equal(form.reference, '');
    assert.equal(form.shipperId, '');
    assert.ok(form.termsAndConditions.length > 0);
    assert.equal(form.packages, null);
  });
});

describe('the new B/L form: what is missing', () => {
  it('a filled form to order has no problem, without a consignee', () => {
    assert.deepEqual(draftProblems(filled()), []);
  });

  it('an empty form names every field it needs', () => {
    const fields = draftProblems(emptyDraftForm()).map(p => p.field);
    for (const field of [
      'reference',
      'carrierCode',
      'bookingReference',
      'shipperId',
      'issuerStreet',
      'issuerCity',
      'issuerCountry',
      'vesselName',
      'voyageNumber',
      'portOfLoading',
      'portOfDischarge',
      'departureDate',
      'arrivalDate',
      'containerNumber',
      'goods',
      'hsCode',
      'packages',
      'packageDescription',
      'grossWeightKg',
    ]) {
      assert.ok(fields.includes(field), `${field} is named`);
    }
    // to order: no consignee needed
    assert.ok(!fields.includes('consigneeId'));
  });

  it('a B/L that is not to order needs its consignee', () => {
    const problems = draftProblems(filled({toOrder: false}));
    assert.deepEqual(
      problems.map(p => p.field),
      ['consigneeId'],
    );
    assert.match(problems[0].message, /consignee/i);
  });

  it('text of spaces only is missing; packages and weight must be more than zero', () => {
    const fields = draftProblems(
      filled({reference: '   ', packages: 0, grossWeightKg: -1}),
    ).map(p => p.field);
    assert.deepEqual(fields, ['reference', 'packages', 'grossWeightKg']);
  });

  it('the arrival cannot be before the departure', () => {
    const problems = draftProblems(
      filled({departureDate: '2026-12-08', arrivalDate: '2026-11-20'}),
    );
    assert.deepEqual(
      problems.map(p => p.field),
      ['arrivalDate'],
    );
  });

  it('the shipper must be one of the organisations listed', () => {
    const problems = draftProblems(filled({shipperId: 'org-unknown'}), [
      EXPORTER,
    ]);
    assert.deepEqual(
      problems.map(p => p.field),
      ['shipperId'],
    );
  });
});

describe('the new B/L form: the document it sends', () => {
  it('a B/L to order: DCSA 3.0, the shipper linked to its organisation, no consignee', () => {
    const {format, document, partyOrganisations} = draftRequest(
      filled(),
      CONTEXT,
    );
    assert.equal(format, 'dcsa-3.0');
    assert.deepEqual(partyOrganisations, {shipper: EXPORTER.id});
    assert.equal(document['transportDocumentReference'], 'CB44-0001');
    assert.equal(document['carrierCode'], 'NSL');
    assert.equal(document['carrierCodeListProvider'], 'SMDG');
    assert.equal(document['transportDocumentTypeCode'], 'BOL');
    assert.equal(document['isToOrder'], true);
    assert.equal(document['isElectronic'], true);
    assert.equal(document['isShippedOnBoardType'], true);
    assert.equal(document['freightPaymentTermCode'], 'PRE');
    assert.equal(document['transportDocumentStatus'], undefined);
    const parties = document['documentParties'] as Record<string, unknown>;
    assert.deepEqual(parties['shipper'], {partyName: 'Coffee Exporters'});
    assert.equal(parties['consignee'], undefined);
    assert.deepEqual(parties['issuingParty'], {
      partyName: 'Nordsee Line',
      address: {street: 'Am Kai 4', city: 'Hamburg', countryCode: 'DE'},
    });
  });

  it('a straight B/L: not to order, its consignee named and linked', () => {
    const {document, partyOrganisations} = draftRequest(
      filled({toOrder: false, consigneeId: BUYER.id}),
      CONTEXT,
    );
    assert.equal(document['isToOrder'], false);
    assert.deepEqual(partyOrganisations, {
      shipper: EXPORTER.id,
      consignee: BUYER.id,
    });
    const parties = document['documentParties'] as Record<string, unknown>;
    // DCSA requires a consignee's identifying codes: the platform organisation's code
    assert.deepEqual(parties['consignee'], {
      partyName: 'Buyer Trading',
      identifyingCodes: [
        {
          codeListProvider: 'ZZZ',
          codeListName: 'organisation',
          partyCode: 'BUY',
        },
      ],
    });
  });

  it('to order, a consignee picked before is left out', () => {
    const {document, partyOrganisations} = draftRequest(
      filled({toOrder: true, consigneeId: BUYER.id}),
      CONTEXT,
    );
    assert.deepEqual(partyOrganisations, {shipper: EXPORTER.id});
    const parties = document['documentParties'] as Record<string, unknown>;
    assert.equal(parties['consignee'], undefined);
  });

  it('the voyage, ports and dates; freight payable at the port of loading; the drafter as contact', () => {
    const {document} = draftRequest(filled(), CONTEXT);
    assert.deepEqual(document['transports'], {
      plannedDepartureDate: '2026-11-20',
      plannedArrivalDate: '2026-12-08',
      portOfLoading: {UNLocationCode: 'BRSSZ'},
      portOfDischarge: {UNLocationCode: 'NLRTM'},
      vesselVoyages: [
        {vesselName: 'Atlantic Crest', carrierExportVoyageNumber: '2611N'},
      ],
    });
    assert.deepEqual(document['invoicePayableAt'], {UNLocationCode: 'BRSSZ'});
    assert.deepEqual(document['partyContactDetails'], [
      {name: 'Lena Okafor', email: 'l.okafor@carrier.example'},
    ]);
    assert.equal(document['receiptTypeAtOrigin'], 'CY');
    assert.equal(document['deliveryTypeAtDestination'], 'CY');
    assert.equal(document['cargoMovementTypeAtOrigin'], 'FCL');
    assert.equal(document['cargoMovementTypeAtDestination'], 'FCL');
    assert.equal(
      document['termsAndConditions'],
      emptyDraftForm().termsAndConditions,
    );
  });

  it('one container with its seal, and its cargo in it', () => {
    const {document} = draftRequest(filled(), CONTEXT);
    assert.deepEqual(document['utilizedTransportEquipments'], [
      {
        isShipperOwned: false,
        seals: [{number: 'SL220871'}],
        equipment: {
          ISOEquipmentCode: '22G1',
          equipmentReference: 'MSKU7045123',
        },
      },
    ]);
    assert.deepEqual(document['consignmentItems'], [
      {
        carrierBookingReference: 'BKG-884120',
        descriptionOfGoods: ['640 bags green coffee'],
        HSCodes: ['090111'],
        cargoItems: [
          {
            equipmentReference: 'MSKU7045123',
            cargoGrossWeight: {value: 38040, unit: 'KGM'},
            outerPackaging: {numberOfPackages: 640, description: 'Bags'},
          },
        ],
      },
    ]);
  });

  it('a container without a seal number has no seals list', () => {
    const {document} = draftRequest(filled({sealNumber: ' '}), CONTEXT);
    const [equipment] = document['utilizedTransportEquipments'] as Array<
      Record<string, unknown>
    >;
    assert.equal(equipment['seals'], undefined);
  });

  it('fills the form back from a saved draft (CB-70)', () => {
    const negotiable = filled();
    const negReq = draftRequest(negotiable, CONTEXT);
    const roundTripped = draftFormOf({
      versionNumber: 1,
      state: 'draft',
      data: {
        document: negReq.document,
        partyOrganisations: negReq.partyOrganisations,
      },
    });
    assert.deepEqual(roundTripped, {
      ...negotiable,
      reference: 'CB44-0001',
      carrierCode: 'NSL',
      issuerCountry: 'DE',
      portOfLoading: 'BRSSZ',
      portOfDischarge: 'NLRTM',
      containerNumber: 'MSKU7045123',
    });

    const straight = filled({
      toOrder: false,
      consigneeId: BUYER.id,
      sealNumber: '',
    });
    const strReq = draftRequest(straight, CONTEXT);
    assert.deepEqual(
      draftFormOf({
        versionNumber: 1,
        state: 'in_review',
        data: {
          document: strReq.document,
          partyOrganisations: strReq.partyOrganisations,
        },
      }),
      {
        ...straight,
        reference: 'CB44-0001',
        carrierCode: 'NSL',
        issuerCountry: 'DE',
        portOfLoading: 'BRSSZ',
        portOfDischarge: 'NLRTM',
        containerNumber: 'MSKU7045123',
      },
    );
  });
});

describe("the backend's refusal, for people", () => {
  it('lists every problem the record service gives, with its place', () => {
    assert.deepEqual(
      problemMessages({
        problems: [
          {path: 'transports.portOfLoading', message: 'is not a UN/LOCODE'},
          {path: '', message: 'The document is not valid'},
        ],
      }),
      [
        'transports.portOfLoading: is not a UN/LOCODE',
        'The document is not valid',
      ],
    );
  });

  it('nothing for an answer without problems', () => {
    assert.deepEqual(problemMessages(undefined), []);
    assert.deepEqual(problemMessages({code: 'x'}), []);
    assert.deepEqual(problemMessages({problems: 'oops'}), []);
  });
});

describe('copying a B/L into the new B/L form (CB-69)', () => {
  it('clears only the four shipment-specific fields and preserves every other field', () => {
    assert.deepEqual(
      [...COPY_BLANK_FIELDS],
      ['reference', 'bookingReference', 'containerNumber', 'sealNumber'],
    );
    const source = filled({toOrder: false, consigneeId: BUYER.id});
    const req = draftRequest(source, CONTEXT);
    const copied = copyFormOf({
      versionNumber: 2,
      state: 'committed',
      data: {
        document: req.document,
        partyOrganisations: req.partyOrganisations,
      },
    });
    assert.deepEqual(copied, {
      ...source,
      reference: '',
      bookingReference: '',
      containerNumber: '',
      sealNumber: '',
      carrierCode: 'NSL',
      issuerCountry: 'DE',
      portOfLoading: 'BRSSZ',
      portOfDischarge: 'NLRTM',
    });
    assert.deepEqual(
      draftProblems(copied, CONTEXT.organisations).map(p => p.field),
      ['reference', 'bookingReference', 'containerNumber'],
    );
  });
});

describe('carrier code validation against the SMDG list (CB-68)', () => {
  const smdg = [
    {code: 'MSC', name: 'Mediterranean Shipping Company'},
    {code: 'MSK', name: 'Maersk'},
  ];

  it('refuses a carrier code that is not on the SMDG list when carriers are provided', () => {
    const problems = draftProblems(
      filled({carrierCode: 'BWML'}),
      CONTEXT.organisations,
      smdg,
    );
    assert.deepEqual(
      problems.map(p => p.field),
      ['carrierCode'],
    );
    assert.match(problems[0].message, /list/i);
    assert.deepEqual(
      draftProblems(filled({carrierCode: 'MSC'}), CONTEXT.organisations, smdg),
      [],
    );
  });
});
