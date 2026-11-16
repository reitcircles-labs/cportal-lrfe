/**
 * The carrier's split of a B/L held for a change into new B/Ls (CB-50, first version, from the
 * CB-14 design): the parent's cargo, one row per cargo item with its container, seal, packages
 * and weight; the parts (B/L A, B, and more with "Add a B/L"), each with its own number and its
 * share of each cargo item, so a container may be divided between parts, as the title engine
 * allows; their running totals; what must hold before the split is sent (each item adds up, each
 * part carries cargo and has its own number); and the documents sent: the parent's, each with its
 * part's number and only its cargo and containers. The record service checks it all again (the
 * cargo adds up to the parent's, the numbers are new). Tested by bl-split.test.ts
 * (`npm run test:shipping`).
 */

/** The longest B/L number DCSA allows. */
const MAX_NUMBER_LENGTH = 20;

/** How far two weights may differ and still add up (rounding of decimal weights). */
const WEIGHT_TOLERANCE = 1e-6;

/** A cargo item of the parent, as the panel lists it. */
export interface CargoRow {
  /** Its place in the document: the consignment item, then the cargo item in it. */
  consignment: number;
  item: number;
  container: string;
  /** The container's seals, '' for none. */
  seal: string;
  packages: number;
  weight: number;
  /** The weight's unit, e.g. `KGM`. */
  unit: string;
}

/** A part's share of a cargo item, as typed; null when a field is empty. */
export interface SplitShare {
  packages: number | null;
  weight: number | null;
}

/** A new B/L of the split: its number and its share of each of the parent's cargo items. */
export interface SplitPart {
  reference: string;
  /** One share per cargo row, in the rows' order. */
  shares: SplitShare[];
}

/** What the record service is sent to split a B/L: one document per new B/L. */
export interface SplitRequest {
  children: Array<{format: string; document: Record<string, unknown>}>;
}

/** How the panel writes numbers: with thousands separators. */
const NUMBERS = new Intl.NumberFormat('en-GB');

/**
 * The value at a key of an object, when it is one.
 * @param value the object
 * @param key the key
 * @return the value, undefined when there is none
 */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * The items of a list in a document, none when it is not a list.
 * @param value the list
 * @return its items
 */
function itemsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A number of a document, 0 when it gives none.
 * @param value the value
 * @return the number
 */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The seals of a container, by their numbers.
 * @param document the parent's document
 * @param container the container's reference
 * @return the seals, '' for none
 */
function sealsOf(document: Record<string, unknown>, container: string): string {
  for (const equipment of itemsOf(document['utilizedTransportEquipments'])) {
    const reference = field(
      field(equipment, 'equipment'),
      'equipmentReference',
    );
    if (reference !== container) {
      continue;
    }
    const numbers: string[] = [];
    for (const seal of itemsOf(field(equipment, 'seals'))) {
      const number = field(seal, 'number');
      if (typeof number === 'string') {
        numbers.push(number);
      }
    }
    return numbers.join(', ');
  }
  return '';
}

/**
 * The parent's cargo, one row per cargo item, in the document's order.
 * @param document the parent's document
 * @return the rows, none for a document without cargo
 */
export function cargoRows(document: Record<string, unknown>): CargoRow[] {
  const rows: CargoRow[] = [];
  for (const [consignment, entry] of itemsOf(
    document['consignmentItems'],
  ).entries()) {
    for (const [item, cargo] of itemsOf(field(entry, 'cargoItems')).entries()) {
      const reference = field(cargo, 'equipmentReference');
      const container = typeof reference === 'string' ? reference : '';
      const weight = field(cargo, 'cargoGrossWeight');
      const unit = field(weight, 'unit');
      rows.push({
        consignment,
        item,
        container,
        seal: sealsOf(document, container),
        packages: numberOf(
          field(field(cargo, 'outerPackaging'), 'numberOfPackages'),
        ),
        weight: numberOf(field(weight, 'value')),
        unit: typeof unit === 'string' ? unit : '',
      });
    }
  }
  return rows;
}

/**
 * The letter of a part: A, B, C…
 * @param index its place, from 0
 * @return the letter
 */
export function partLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/**
 * A part with no cargo yet.
 * @param rows the parent's cargo
 * @param reference its number
 * @return the part
 */
function emptyPart(rows: readonly CargoRow[], reference: string): SplitPart {
  return {
    reference,
    shares: rows.map(() => ({packages: 0, weight: 0})),
  };
}

/**
 * The two parts the panel starts with: A with all the cargo, B with none, numbered after the
 * parent (`<parent>-A`, `<parent>-B`).
 * @param rows the parent's cargo
 * @param parentNumber the parent's number
 * @return the parts
 */
export function firstParts(
  rows: readonly CargoRow[],
  parentNumber: string,
): SplitPart[] {
  const first: SplitPart = {
    reference: `${parentNumber}-${partLetter(0)}`,
    shares: rows.map(row => ({packages: row.packages, weight: row.weight})),
  };
  return [first, emptyPart(rows, `${parentNumber}-${partLetter(1)}`)];
}

/**
 * The parts with one more, empty, after them ("Add a B/L"). The parts given are not changed.
 * @param parts the parts
 * @param rows the parent's cargo
 * @param parentNumber the parent's number
 * @return the new list
 */
export function addPart(
  parts: readonly SplitPart[],
  rows: readonly CargoRow[],
  parentNumber: string,
): SplitPart[] {
  const reference = `${parentNumber}-${partLetter(parts.length)}`;
  return [...parts, emptyPart(rows, reference)];
}

/**
 * A share's number, 0 when it is empty.
 * @param value as typed
 * @return the number
 */
function shareNumber(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Weights per unit as the panel writes them: `18,000 KGM`.
 * @param weights the weights, by unit, in the order first met
 * @return the text
 */
function weightsText(weights: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  for (const [unit, weight] of weights) {
    parts.push(`${NUMBERS.format(weight)} ${unit}`.trim());
  }
  return parts.length === 0 ? '0' : parts.join(' + ');
}

/**
 * A part's running total: its packages and weights.
 * @param rows the parent's cargo
 * @param part the part
 * @return e.g. "600 packages, 18,000 KGM"
 */
export function partSummary(
  rows: readonly CargoRow[],
  part: SplitPart,
): string {
  let packages = 0;
  const weights = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const share = part.shares[i] ?? {packages: 0, weight: 0};
    packages += shareNumber(share.packages);
    weights.set(
      row.unit,
      (weights.get(row.unit) ?? 0) + shareNumber(share.weight),
    );
  }
  return `${NUMBERS.format(packages)} packages, ${weightsText(weights)}`;
}

/**
 * What the parts hold together of a cargo item.
 * @param parts the parts
 * @param row the cargo item's place among the rows
 * @return its packages and weight, empty shares as 0
 */
export function rowAssigned(
  parts: readonly SplitPart[],
  row: number,
): {packages: number; weight: number} {
  let packages = 0;
  let weight = 0;
  for (const part of parts) {
    const share = part.shares[row];
    packages += shareNumber(share?.packages ?? null);
    weight += shareNumber(share?.weight ?? null);
  }
  return {packages, weight};
}

/**
 * Whether a share is one the split can send: numbers, zero or more, its packages whole.
 * @param share the share
 * @return true when it is
 */
function validShare(share: SplitShare): boolean {
  const {packages, weight} = share;
  if (typeof packages !== 'number' || typeof weight !== 'number') {
    return false;
  }
  if (!Number.isInteger(packages) || packages < 0) {
    return false;
  }
  return Number.isFinite(weight) && weight >= 0;
}

/**
 * Whether a part carries any cargo.
 * @param part the part
 * @return true when one of its shares has packages or weight
 */
function carriesCargo(part: SplitPart): boolean {
  return part.shares.some(
    share => shareNumber(share.packages) > 0 || shareNumber(share.weight) > 0,
  );
}

/**
 * The problems of the parts' numbers: missing, too long, the parent's, or given twice.
 * @param parts the parts
 * @param parentNumber the parent's number
 * @return the problems
 */
function numberProblems(
  parts: readonly SplitPart[],
  parentNumber: string,
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [partIndex, part] of parts.entries()) {
    const letter = partLetter(partIndex);
    const number = part.reference.trim();
    if (number === '') {
      problems.push(`Give B/L ${letter} its number.`);
    } else if (number.length > MAX_NUMBER_LENGTH) {
      problems.push(
        `The number of B/L ${letter} has more than ${MAX_NUMBER_LENGTH} characters.`,
      );
    } else if (number === parentNumber.trim()) {
      problems.push(`B/L ${letter} needs its own number, not the B/L's.`);
    } else if (seen.has(number)) {
      problems.push(
        `B/L ${seen.get(number)} and B/L ${letter} have the same number.`,
      );
    } else {
      seen.set(number, letter);
    }
  }
  return problems;
}

/**
 * Why the split cannot be sent yet: a number missing, too long, the parent's or given twice; a
 * share that is not a number; a cargo item whose shares do not add up to the parent's; a part
 * with no cargo.
 * @param rows the parent's cargo
 * @param parts the parts
 * @param parentNumber the parent's number
 * @return the problems, none when it can be sent
 */
export function splitProblems(
  rows: readonly CargoRow[],
  parts: readonly SplitPart[],
  parentNumber: string,
): string[] {
  const problems = numberProblems(parts, parentNumber);
  for (const [i, part] of parts.entries()) {
    if (!part.shares.every(validShare)) {
      problems.push(
        `B/L ${partLetter(i)}: packages and weights are numbers, zero or more; packages are whole.`,
      );
    }
  }
  for (const [rowIndex, row] of rows.entries()) {
    const assigned = rowAssigned(parts, rowIndex);
    if (assigned.packages !== row.packages) {
      problems.push(
        `${row.container}: the parts hold ${NUMBERS.format(assigned.packages)} packages; the B/L holds ${NUMBERS.format(row.packages)}.`,
      );
    }
    if (Math.abs(assigned.weight - row.weight) > WEIGHT_TOLERANCE) {
      const unit = row.unit === '' ? '' : ` ${row.unit}`;
      problems.push(
        `${row.container}: the parts hold ${NUMBERS.format(assigned.weight)}${unit}; the B/L holds ${NUMBERS.format(row.weight)}${unit}.`,
      );
    }
  }
  for (const [i, part] of parts.entries()) {
    if (!carriesCargo(part)) {
      problems.push(`B/L ${partLetter(i)} carries no cargo.`);
    }
  }
  return problems;
}

/**
 * The document of one new B/L: the parent's, with the part's number, only the cargo items it has
 * a share of (with its packages and weight) and only their containers.
 * @param document the parent's document
 * @param rows the parent's cargo
 * @param part the part
 * @return the document
 */
function partDocument(
  document: Record<string, unknown>,
  rows: readonly CargoRow[],
  part: SplitPart,
): Record<string, unknown> {
  const child = structuredClone(document);
  child['transportDocumentReference'] = part.reference.trim();
  const containers = new Set<string>();
  const consignments: unknown[] = [];
  for (const [consignmentIndex, entry] of itemsOf(
    child['consignmentItems'],
  ).entries()) {
    const cargoItems: unknown[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      const share = part.shares[rowIndex];
      const packages = shareNumber(share?.packages ?? null);
      const weight = shareNumber(share?.weight ?? null);
      if (
        row.consignment !== consignmentIndex ||
        (packages === 0 && weight === 0)
      ) {
        continue;
      }
      const cargo = itemsOf(field(entry, 'cargoItems'))[row.item] as Record<
        string,
        unknown
      >;
      cargoItems.push({
        ...cargo,
        cargoGrossWeight: {
          ...(cargo['cargoGrossWeight'] as Record<string, unknown>),
          value: weight,
        },
        outerPackaging: {
          ...(cargo['outerPackaging'] as Record<string, unknown>),
          numberOfPackages: packages,
        },
      });
      containers.add(row.container);
    }
    if (cargoItems.length > 0) {
      consignments.push({...(entry as Record<string, unknown>), cargoItems});
    }
  }
  child['consignmentItems'] = consignments;
  child['utilizedTransportEquipments'] = itemsOf(
    child['utilizedTransportEquipments'],
  ).filter(equipment => {
    const reference = field(
      field(equipment, 'equipment'),
      'equipmentReference',
    );
    return typeof reference === 'string' && containers.has(reference);
  });
  return child;
}

/**
 * The request that splits the B/L: one document per part, in the parts' order. No party links:
 * each new B/L keeps the parent's. The parent's document is not changed.
 * @param format the documents' format
 * @param document the parent's document
 * @param rows the parent's cargo
 * @param parts the parts
 * @return the request
 */
export function splitRequest(
  format: string,
  document: Record<string, unknown>,
  rows: readonly CargoRow[],
  parts: readonly SplitPart[],
): SplitRequest {
  return {
    children: parts.map(part => ({
      format,
      document: partDocument(document, rows, part),
    })),
  };
}

/**
 * The button that sends the split.
 * @param count how many new B/Ls
 * @return its label
 */
export function splitLabel(count: number): string {
  return `Split into ${count} B/Ls`;
}

/**
 * The question the confirmation asks.
 * @param parentNumber the parent's number
 * @param count how many new B/Ls
 * @return the question
 */
export function splitQuestion(parentNumber: string, count: number): string {
  return `Split ${parentNumber} into ${count} B/Ls?`;
}

/**
 * What the confirmation says happens.
 * @param parentNumber the parent's number
 * @param count how many new B/Ls
 * @param holder the name of the holder they are issued to
 * @return the sentence
 */
export function splitConfirmation(
  parentNumber: string,
  count: number,
  holder: string,
): string {
  return `${parentNumber} is closed and ${count} new B/Ls are issued to ${holder}, each with its own number.`;
}

/**
 * What the toast says once the B/L is split.
 * @param count how many new B/Ls
 * @return the text
 */
export function splitDone(count: number): string {
  return `B/L split into ${count} new B/Ls`;
}
