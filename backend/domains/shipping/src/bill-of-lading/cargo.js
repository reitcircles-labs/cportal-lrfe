/**
 * The cargo of a B/L, per container (CB-35, docs/title-states.md "Split"): what a split must
 * divide without losing or adding anything. Only container B/Ls are held (model.js), so every
 * cargo item is in one of the B/L's containers.
 */

/** How far two weights may differ and still add up (rounding of decimal weights). */
const WEIGHT_TOLERANCE = 1e-6;

/**
 * The cargo of one container: its packages and its gross weight per unit (`KGM`, `LBR`).
 *
 * @typedef {object} ContainerCargo
 * @property {number} packages the number of outer packages of its cargo items
 * @property {!Map<string, number>} weights the gross weight of its cargo items, per unit
 */

/**
 * A number of a document, or 0 when it gives none (the schema check names a missing one).
 *
 * @param {*} value
 * @return {number}
 */
function numberOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

/**
 * The cargo of a DCSA document per container, by equipment reference: every container it lists
 * (with no cargo when no item is in it) and the packages and gross weights of the cargo items in
 * each. Names from the document are only ever keys of a Map.
 *
 * @param {!Object} document a DCSA transport document
 * @return {!Map<string, !ContainerCargo>}
 */
export function cargoOf(document) {
  const cargo = new Map();
  /**
   * The cargo of a container, made empty the first time it is named.
   *
   * @param {string} reference
   * @return {!ContainerCargo}
   */
  const containerOf = reference => {
    if (!cargo.has(reference)) {
      cargo.set(reference, {packages: 0, weights: new Map()});
    }
    return cargo.get(reference);
  };
  for (const equipment of document?.utilizedTransportEquipments ?? []) {
    const reference = equipment?.equipment?.equipmentReference;
    if (typeof reference === 'string') {
      containerOf(reference);
    }
  }
  for (const item of document?.consignmentItems ?? []) {
    for (const cargoItem of item?.cargoItems ?? []) {
      const reference = cargoItem?.equipmentReference;
      if (typeof reference !== 'string') {
        continue;
      }
      const container = containerOf(reference);
      container.packages += numberOf(
        cargoItem.outerPackaging?.numberOfPackages,
      );
      const unit = String(cargoItem.cargoGrossWeight?.unit ?? '');
      const weight = numberOf(cargoItem.cargoGrossWeight?.value);
      container.weights.set(unit, (container.weights.get(unit) ?? 0) + weight);
    }
  }
  return cargo;
}

/**
 * Whether two weights per unit are the same, units with no weight aside.
 *
 * @param {!Map<string, number>} a
 * @param {!Map<string, number>} b
 * @return {boolean}
 */
function sameWeights(a, b) {
  const units = new Set([...a.keys(), ...b.keys()]);
  for (const unit of units) {
    const difference = (a.get(unit) ?? 0) - (b.get(unit) ?? 0);
    if (Math.abs(difference) > WEIGHT_TOLERANCE) {
      return false;
    }
  }
  return true;
}

/**
 * The weights per unit as a reader writes them: `12000 KGM`.
 *
 * @param {!Map<string, number>} weights
 * @return {string}
 */
function weightText(weights) {
  const parts = [];
  for (const [unit, weight] of weights) {
    parts.push(`${weight} ${unit}`.trim());
  }
  if (parts.length === 0) {
    return '0';
  }
  return parts.join(' + ');
}

/**
 * Why the cargo of the documents a B/L is split into does not add up to the B/L's own: the
 * children together name exactly the parent's containers (none missing, none added; a container
 * may be named by several children when its cargo is divided) and, per container, their packages
 * and gross weights add up to the parent's. Ports and every other field may differ.
 *
 * @param {!Object} parent the parent's DCSA document
 * @param {!Array<!Object>} children the children's DCSA documents
 * @return {!Array<string>} the reasons, one per container that does not add up; empty when the
 *     cargo adds up
 */
export function splitCargoProblems(parent, children) {
  const expected = cargoOf(parent);
  const given = new Map();
  for (const child of children) {
    for (const [reference, cargo] of cargoOf(child)) {
      const total = given.get(reference) ?? {packages: 0, weights: new Map()};
      total.packages += cargo.packages;
      for (const [unit, weight] of cargo.weights) {
        total.weights.set(unit, (total.weights.get(unit) ?? 0) + weight);
      }
      given.set(reference, total);
    }
  }
  const problems = [];
  for (const [reference, cargo] of expected) {
    const total = given.get(reference);
    if (total === undefined) {
      problems.push(
        `Container ${reference} of the B/L is in none of the new B/Ls`,
      );
      continue;
    }
    if (total.packages !== cargo.packages) {
      problems.push(
        `Container ${reference}: the new B/Ls carry ${total.packages} packages, ` +
          `the B/L ${cargo.packages}`,
      );
    }
    if (!sameWeights(total.weights, cargo.weights)) {
      problems.push(
        `Container ${reference}: the new B/Ls carry ${weightText(total.weights)}, ` +
          `the B/L ${weightText(cargo.weights)}`,
      );
    }
  }
  for (const reference of given.keys()) {
    if (!expected.has(reference)) {
      problems.push(
        `Container ${reference} is not one of the B/L's containers`,
      );
    }
  }
  return problems;
}
