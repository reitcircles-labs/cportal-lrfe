// Unit tests for the carrier's amendment of a B/L (CB-50, from the CB-14 design): the fields it may
// change, the changes marked against the version before, the document sent (the same reference and
// carrier code, the rest kept) and what the confirmation and the toast say (`npm run
// test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  AMEND_FIELDS,
  amendChanges,
  amendConfirmation,
  amendDone,
  amendFormOf,
  amendProblems,
  amendQuestion,
  amendRequest,
  amendedDocument,
} from './bl-amend.ts';

/**
 * A B/L to order with the fields the panel edits, two containers and parties.
 * @return the document
 */
function document(): Record<string, unknown> {
  return {
    transportDocumentReference: 'OCEAN-1001',
    carrierCode: 'OCL',
    isToOrder: true,
    termsAndConditions: 'Carried under the terms of the carrier.',
    transports: {
      plannedDepartureDate: '2026-11-20',
      plannedArrivalDate: '2026-12-10',
      portOfLoading: {UNLocationCode: 'NAWVB'},
      portOfDischarge: {UNLocationCode: 'DEBRV'},
      vesselVoyages: [
        {vesselName: 'Ocean Star', carrierExportVoyageNumber: '402E'},
      ],
    },
    documentParties: {shipper: {partyName: 'Coffee Exporters'}},
    consignmentItems: [
      {
        carrierBookingReference: 'BK-1',
        descriptionOfGoods: ['Coffee beans'],
        HSCodes: ['090111'],
        cargoItems: [
          {
            equipmentReference: 'NARU3472484',
            cargoGrossWeight: {value: 12000, unit: 'KGM'},
            outerPackaging: {numberOfPackages: 400, description: 'Bags'},
          },
        ],
      },
    ],
    utilizedTransportEquipments: [
      {equipment: {equipmentReference: 'NARU3472484'}},
    ],
  };
}

describe('the fields the carrier may change', () => {
  it('the voyage, the ports, the dates, the goods, the booking and the terms; never the number or the carrier code', () => {
    assert.deepEqual(
      AMEND_FIELDS.map(f => f.label),
      [
        'Vessel',
        'Voyage',
        'Port of loading',
        'Port of discharge',
        'Departure date',
        'Arrival date',
        'Goods',
        'HS code',
        'Booking reference',
        'Terms and conditions',
      ],
    );
    const keys = AMEND_FIELDS.map(f => f.key);
    assert.equal(keys.includes('reference'), false);
    assert.equal(keys.includes('carrierCode'), false);
  });

  it('the form starts from the version before', () => {
    const form = amendFormOf(document());
    assert.equal(form['portOfDischarge'], 'DEBRV');
    assert.equal(form['vesselName'], 'Ocean Star');
    assert.equal(form['goods'], 'Coffee beans');
    assert.equal(form['bookingReference'], 'BK-1');
    assert.equal(
      form['termsAndConditions'],
      'Carried under the terms of the carrier.',
    );
  });

  it('a field the document lacks starts empty', () => {
    const form = amendFormOf({transportDocumentReference: 'X'});
    assert.equal(form['portOfDischarge'], '');
    assert.equal(form['goods'], '');
  });
});

describe('the changes, marked against the version before', () => {
  it('none for the form as it starts', () => {
    assert.deepEqual(amendChanges(document(), amendFormOf(document())), []);
  });

  it('each changed field with its old and new value; codes in capitals; spaces around ignored', () => {
    const form = {
      ...amendFormOf(document()),
      portOfDischarge: ' nlrtm ',
      vesselName: 'Ocean Star ',
    };
    assert.deepEqual(amendChanges(document(), form), [
      {
        key: 'portOfDischarge',
        label: 'Port of discharge',
        before: 'DEBRV',
        after: 'NLRTM',
      },
    ]);
  });
});

describe('what the carrier cannot send', () => {
  it('nothing changed', () => {
    assert.deepEqual(amendProblems(document(), amendFormOf(document())), [
      'Change at least one field.',
    ]);
  });

  it('a field emptied that had a value', () => {
    const form = {...amendFormOf(document()), portOfDischarge: '  '};
    assert.deepEqual(amendProblems(document(), form), [
      'Fill in the port of discharge.',
    ]);
  });

  it('an arrival before the departure', () => {
    const form = {...amendFormOf(document()), plannedArrivalDate: '2026-11-01'};
    assert.deepEqual(amendProblems(document(), form), [
      'The arrival cannot be before the departure.',
    ]);
  });

  it('a change it may send', () => {
    const form = {...amendFormOf(document()), portOfDischarge: 'NLRTM'};
    assert.deepEqual(amendProblems(document(), form), []);
  });
});

describe('the document sent', () => {
  it('the version before with the changed fields; the number, carrier code, cargo and parties kept', () => {
    const before = document();
    const form = {
      ...amendFormOf(before),
      portOfDischarge: 'nlrtm',
      goods: 'Green coffee beans',
    };
    const after = amendedDocument(before, form);
    const transports = after['transports'] as Record<string, unknown>;
    assert.deepEqual(transports['portOfDischarge'], {UNLocationCode: 'NLRTM'});
    const items = after['consignmentItems'] as Array<Record<string, unknown>>;
    assert.deepEqual(items[0]['descriptionOfGoods'], ['Green coffee beans']);
    assert.equal(after['transportDocumentReference'], 'OCEAN-1001');
    assert.equal(after['carrierCode'], 'OCL');
    assert.equal(after['isToOrder'], true);
    assert.deepEqual(
      after['utilizedTransportEquipments'],
      before['utilizedTransportEquipments'],
    );
    assert.deepEqual(after['documentParties'], before['documentParties']);
    assert.deepEqual(
      items[0]['cargoItems'],
      (before['consignmentItems'] as Array<Record<string, unknown>>)[0][
        'cargoItems'
      ],
    );
  });

  it('the version before is not changed', () => {
    const before = document();
    const copy = structuredClone(before);
    amendedDocument(before, {...amendFormOf(before), portOfDischarge: 'NLRTM'});
    assert.deepEqual(before, copy);
  });

  it('a field the document lacked is added when given', () => {
    const before: Record<string, unknown> = {transportDocumentReference: 'X'};
    const after = amendedDocument(before, {
      ...amendFormOf(before),
      portOfDischarge: 'NLRTM',
    });
    assert.deepEqual(after['transports'], {
      portOfDischarge: {UNLocationCode: 'NLRTM'},
    });
  });

  it('the request: its format and document, no party links (the version before keeps them)', () => {
    const request = amendRequest('dcsa-3.0', document(), {
      ...amendFormOf(document()),
      portOfDischarge: 'NLRTM',
    });
    assert.equal(request.format, 'dcsa-3.0');
    assert.deepEqual(Object.keys(request).sort(), ['document', 'format']);
  });
});

describe('the confirmation and the toast', () => {
  it('the question names the B/L', () => {
    assert.equal(amendQuestion('OCEAN-1001'), 'Amend OCEAN-1001?');
  });

  it('names the next version and the holder it goes to', () => {
    assert.equal(
      amendConfirmation(1, 'OCEAN-1001', 'Volta Bank'),
      'Version 2 of OCEAN-1001 goes to Volta Bank. Version 1 is kept as superseded.',
    );
  });

  it('the toast says which version is with whom', () => {
    assert.equal(
      amendDone(2, 'Volta Bank'),
      'B/L amended: version 3 is with Volta Bank',
    );
  });
});
