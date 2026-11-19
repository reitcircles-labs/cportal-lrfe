// Unit tests for the carrier's split of a B/L into new B/Ls (CB-50, from the CB-14 design): the
// parent's cargo per container, the parts it is assigned to with their running totals, what must
// hold before it can be sent (the cargo adds up, each part its own number) and the documents sent
// (`npm run test:shipping`).
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  DEFAULT_MAX_SPLIT_PARTS,
  addPart,
  cargoRows,
  firstParts,
  partLetter,
  partSummary,
  removeLastPart,
  rowAssigned,
  setPartCount,
  splitConfirmation,
  splitDone,
  splitLabel,
  splitProblems,
  splitQuestion,
  splitRequest,
  type SplitPart,
} from './bl-split.ts';

/**
 * A B/L to order with two containers: A 400 bags, 12 000 kg; B 200 bags, 6 000 kg.
 * @return the document
 */
function parent(): Record<string, unknown> {
  return {
    transportDocumentReference: 'OCEAN-1001',
    carrierCode: 'OCL',
    isToOrder: true,
    transports: {portOfDischarge: {UNLocationCode: 'DEBRV'}},
    consignmentItems: [
      {
        carrierBookingReference: 'BK-1',
        descriptionOfGoods: ['Coffee beans'],
        cargoItems: [
          {
            equipmentReference: 'CONT-A',
            cargoGrossWeight: {value: 12000, unit: 'KGM'},
            outerPackaging: {numberOfPackages: 400, description: 'Bags'},
          },
          {
            equipmentReference: 'CONT-B',
            cargoGrossWeight: {value: 6000, unit: 'KGM'},
            outerPackaging: {numberOfPackages: 200, description: 'Bags'},
          },
        ],
      },
    ],
    utilizedTransportEquipments: [
      {seals: [{number: 'SEAL-1'}], equipment: {equipmentReference: 'CONT-A'}},
      {equipment: {equipmentReference: 'CONT-B'}},
    ],
  };
}

/**
 * Two parts by container: A takes CONT-A, B takes CONT-B.
 * @return the parts
 */
function byContainer(): SplitPart[] {
  return [
    {
      reference: 'OCEAN-1001-A',
      shares: [
        {packages: 400, weight: 12000},
        {packages: 0, weight: 0},
      ],
    },
    {
      reference: 'OCEAN-1001-B',
      shares: [
        {packages: 0, weight: 0},
        {packages: 200, weight: 6000},
      ],
    },
  ];
}

describe("the parent's cargo", () => {
  it('one row per cargo item: its container, seal, packages and weight', () => {
    assert.deepEqual(cargoRows(parent()), [
      {
        consignment: 0,
        item: 0,
        container: 'CONT-A',
        seal: 'SEAL-1',
        packages: 400,
        weight: 12000,
        unit: 'KGM',
      },
      {
        consignment: 0,
        item: 1,
        container: 'CONT-B',
        seal: '',
        packages: 200,
        weight: 6000,
        unit: 'KGM',
      },
    ]);
  });

  it('none for a document without cargo', () => {
    assert.deepEqual(cargoRows({}), []);
  });
});

describe('the parts', () => {
  it('lettered A..Z, then AA, AB…', () => {
    assert.deepEqual([0, 1, 2, 25, 26, 27].map(partLetter), [
      'A',
      'B',
      'C',
      'Z',
      'AA',
      'AB',
    ]);
  });

  it('sets the output count flexibly (min 2, default max 10, configurable), dropping the last parts on shrink (CB-73)', () => {
    assert.equal(DEFAULT_MAX_SPLIT_PARTS, 10);
    const rows = cargoRows(parent());
    const two = firstParts(rows, 'OCEAN-1001');
    const four = setPartCount(two, 4, rows, 'OCEAN-1001', 10);
    assert.deepEqual(
      four.map(p => p.reference),
      ['OCEAN-1001-A', 'OCEAN-1001-B', 'OCEAN-1001-C', 'OCEAN-1001-D'],
    );
    // Custom maxParts respected; adding past max stops at max
    const capped = setPartCount(four, 8, rows, 'OCEAN-1001', 5);
    assert.equal(capped.length, 5);
    assert.equal(addPart(capped, rows, 'OCEAN-1001', 5).length, 5);

    // Shrinking drops the last part(s) with all their entries
    four[2].shares[0] = {packages: 50, weight: 1500};
    four[3].shares[1] = {packages: 20, weight: 600};
    const shrunk = setPartCount(four, 2, rows, 'OCEAN-1001', 10);
    assert.deepEqual(
      shrunk.map(p => p.reference),
      ['OCEAN-1001-A', 'OCEAN-1001-B'],
    );
    assert.equal(removeLastPart(four).length, 3);
    assert.equal(removeLastPart(two).length, 2);
  });

  it('two to start: A with all the cargo, B with none, numbered after the parent', () => {
    const rows = cargoRows(parent());
    assert.deepEqual(firstParts(rows, 'OCEAN-1001'), [
      {
        reference: 'OCEAN-1001-A',
        shares: [
          {packages: 400, weight: 12000},
          {packages: 200, weight: 6000},
        ],
      },
      {
        reference: 'OCEAN-1001-B',
        shares: [
          {packages: 0, weight: 0},
          {packages: 0, weight: 0},
        ],
      },
    ]);
  });

  it('"Add a B/L" adds an empty part, the next letter; the parts given are not changed', () => {
    const rows = cargoRows(parent());
    const two = firstParts(rows, 'OCEAN-1001');
    const three = addPart(two, rows, 'OCEAN-1001');
    assert.equal(two.length, 2);
    assert.equal(three.length, 3);
    assert.deepEqual(three[2], {
      reference: 'OCEAN-1001-C',
      shares: [
        {packages: 0, weight: 0},
        {packages: 0, weight: 0},
      ],
    });
  });

  it("a part's running total", () => {
    const rows = cargoRows(parent());
    const [a, b] = firstParts(rows, 'OCEAN-1001');
    assert.equal(partSummary(rows, a), '600 packages, 18,000 KGM');
    assert.equal(partSummary(rows, b), '0 packages, 0 KGM');
  });

  it('per cargo item, what the parts hold together', () => {
    const rows = cargoRows(parent());
    const parts = byContainer();
    parts[1].shares[0] = {packages: 20, weight: 600};
    assert.deepEqual(rowAssigned(parts, 0), {packages: 420, weight: 12600});
    assert.deepEqual(rowAssigned(parts, 1), {packages: 200, weight: 6000});
    assert.equal(rows.length, 2);
  });
});

describe('what must hold before the split is sent', () => {
  it('nothing more for parts whose cargo adds up', () => {
    const rows = cargoRows(parent());
    assert.deepEqual(splitProblems(rows, byContainer(), 'OCEAN-1001'), []);
  });

  it('a container divided between parts adds up too', () => {
    const rows = cargoRows(parent());
    const parts = byContainer();
    parts[0].shares[0] = {packages: 250, weight: 7500};
    parts[1].shares[0] = {packages: 150, weight: 4500};
    assert.deepEqual(splitProblems(rows, parts, 'OCEAN-1001'), []);
  });

  it("cargo that does not add up: the parts' total against the B/L's, per container", () => {
    const rows = cargoRows(parent());
    const parts = byContainer();
    parts[1].shares[1] = {packages: 180, weight: 5400};
    assert.deepEqual(splitProblems(rows, parts, 'OCEAN-1001'), [
      'CONT-B: the parts hold 180 packages; the B/L holds 200.',
      'CONT-B: the parts hold 5,400 KGM; the B/L holds 6,000 KGM.',
    ]);
  });

  it('a part with no cargo', () => {
    const rows = cargoRows(parent());
    assert.deepEqual(
      splitProblems(rows, firstParts(rows, 'OCEAN-1001'), 'OCEAN-1001'),
      ['B/L B carries no cargo.'],
    );
  });

  it("a number missing, too long, the parent's, or given twice", () => {
    const rows = cargoRows(parent());
    const cases: Array<[string, string, string]> = [
      ['', 'OCEAN-1001-B', 'Give B/L A its number.'],
      [
        'OCEAN-1001-AAAAAAAAAA',
        'OCEAN-1001-B',
        'The number of B/L A has more than 20 characters.',
      ],
      [
        'OCEAN-1001',
        'OCEAN-1001-B',
        "B/L A needs its own number, not the B/L's.",
      ],
      [
        'OCEAN-1001-X',
        ' OCEAN-1001-X ',
        'B/L A and B/L B have the same number.',
      ],
    ];
    for (const [first, second, problem] of cases) {
      const parts = byContainer();
      parts[0].reference = first;
      parts[1].reference = second;
      assert.deepEqual(
        splitProblems(rows, parts, 'OCEAN-1001'),
        [problem],
        first,
      );
    }
  });

  it('packages and weights are numbers, zero or more; packages whole', () => {
    const rows = cargoRows(parent());
    const parts = byContainer();
    parts[0].shares[1] = {packages: -1, weight: 0};
    parts[1].shares[1] = {packages: 201, weight: 6000};
    assert.ok(
      splitProblems(rows, parts, 'OCEAN-1001').includes(
        'B/L A: packages and weights are numbers, zero or more; packages are whole.',
      ),
    );
    const empty = byContainer();
    empty[1].shares[1] = {packages: null, weight: 6000};
    assert.ok(
      splitProblems(rows, empty, 'OCEAN-1001').includes(
        'B/L B: packages and weights are numbers, zero or more; packages are whole.',
      ),
    );
    const fraction = byContainer();
    fraction[1].shares[1] = {packages: 199.5, weight: 6000};
    assert.ok(
      splitProblems(rows, fraction, 'OCEAN-1001').includes(
        'B/L B: packages and weights are numbers, zero or more; packages are whole.',
      ),
    );
  });

  it('rejects exceeding the configured maximum number of B/Ls (CB-73)', () => {
    const rows = cargoRows(parent());
    const four = setPartCount(
      firstParts(rows, 'OCEAN-1001'),
      4,
      rows,
      'OCEAN-1001',
      10,
    );
    assert.ok(
      splitProblems(rows, four, 'OCEAN-1001', 3).includes(
        'Split into at most 3 B/Ls.',
      ),
    );
  });
});

describe('the documents sent', () => {
  it("one per part: the parent's document with the part's number and only its cargo and containers", () => {
    const document = parent();
    const rows = cargoRows(document);
    const request = splitRequest('dcsa-3.0', document, rows, byContainer());
    assert.equal(request.children.length, 2);
    const [a, b] = request.children.map(c => c.document);
    assert.equal(a['transportDocumentReference'], 'OCEAN-1001-A');
    assert.equal(b['transportDocumentReference'], 'OCEAN-1001-B');
    for (const child of [a, b]) {
      assert.equal(child['carrierCode'], 'OCL');
      assert.equal(child['isToOrder'], true);
      assert.deepEqual(child['transports'], document['transports']);
    }
    const equipments = (child: Record<string, unknown>) =>
      (
        child['utilizedTransportEquipments'] as Array<{
          equipment: {equipmentReference: string};
        }>
      ).map(e => e.equipment.equipmentReference);
    assert.deepEqual(equipments(a), ['CONT-A']);
    assert.deepEqual(equipments(b), ['CONT-B']);
    const items = (child: Record<string, unknown>) =>
      (
        child['consignmentItems'] as Array<{
          cargoItems: Array<Record<string, unknown>>;
        }>
      )[0].cargoItems;
    assert.equal(items(a).length, 1);
    assert.deepEqual(items(b)[0]['cargoGrossWeight'], {
      value: 6000,
      unit: 'KGM',
    });
    assert.deepEqual(items(b)[0]['outerPackaging'], {
      numberOfPackages: 200,
      description: 'Bags',
    });
    assert.equal(request.children[0].format, 'dcsa-3.0');
    assert.deepEqual(Object.keys(request.children[0]).sort(), [
      'document',
      'format',
    ]);
  });

  it('a divided container: both parts carry it, each with its share', () => {
    const document = parent();
    const rows = cargoRows(document);
    const parts = byContainer();
    parts[0].shares[0] = {packages: 250, weight: 7500};
    parts[1].shares[0] = {packages: 150, weight: 4500};
    const [, b] = splitRequest('dcsa-3.0', document, rows, parts).children.map(
      c => c.document,
    );
    const cargo = (
      b['consignmentItems'] as Array<{
        cargoItems: Array<{
          equipmentReference: string;
          outerPackaging: {numberOfPackages: number};
        }>;
      }>
    )[0].cargoItems;
    assert.deepEqual(
      cargo.map(c => [c.equipmentReference, c.outerPackaging.numberOfPackages]),
      [
        ['CONT-A', 150],
        ['CONT-B', 200],
      ],
    );
  });

  it('numbers trimmed; the parent document is not changed', () => {
    const document = parent();
    const copy = structuredClone(document);
    const parts = byContainer();
    parts[0].reference = ' OCEAN-1001-A ';
    const request = splitRequest(
      'dcsa-3.0',
      document,
      cargoRows(document),
      parts,
    );
    assert.equal(
      request.children[0].document['transportDocumentReference'],
      'OCEAN-1001-A',
    );
    assert.deepEqual(document, copy);
  });
});

describe('the button, the confirmation and the toast', () => {
  it('say how many B/Ls', () => {
    assert.equal(splitLabel(2), 'Split into 2 B/Ls');
    assert.equal(
      splitQuestion('OCEAN-1001', 3),
      'Split OCEAN-1001 into 3 B/Ls?',
    );
    assert.equal(
      splitConfirmation('OCEAN-1001', 2, 'Volta Bank'),
      'OCEAN-1001 is closed and 2 new B/Ls are issued to Volta Bank, each with its own number.',
    );
    assert.equal(splitDone(2), 'B/L split into 2 new B/Ls');
  });
});
