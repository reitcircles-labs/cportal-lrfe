import {readFileSync} from 'node:fs';

/**
 * CB-35: the DCSA documents of an amendment and a split, shared by the shipping records tests,
 * the audit service's title proof tests and the e2e spec of the shipping product. It needs nothing
 * but Node, so the e2e suite can import it too.
 *
 * The parent B/L carries two containers, each with one cargo item of the same consignment:
 *   CONTAINER_A  400 packages, 12 000 kg
 *   CONTAINER_B  200 packages,  6 000 kg
 * A child names the containers it carries and its share of each one's cargo; the children
 * together carry exactly the parent's containers and cargo (CB-35, Jira comment 11580).
 */

const EXAMPLE = new URL(
  '../../../domains/shipping/dcsa/3.0.3/examples/td-regular.json',
  import.meta.url,
);

/** The parent's first container: the example's own. */
export const CONTAINER_A = 'NARU3472484';
/** The parent's second container. */
export const CONTAINER_B = 'MSKU9070323';

/** The parent's cargo: packages and gross weight (kg) per container. */
export const PARENT_CARGO = Object.freeze({
  [CONTAINER_A]: Object.freeze({packages: 400, weight: 12000}),
  [CONTAINER_B]: Object.freeze({packages: 200, weight: 6000}),
});

/** The port of discharge of the parent: Bremerhaven, the example's own. */
export const PARENT_PORT = 'DEBRV';
/** Another port of discharge, for a child going elsewhere: Rotterdam. */
export const OTHER_PORT = 'NLRTM';

/**
 * DCSA's example transport document (a B/L to order).
 * @return {!Object}
 */
function example() {
  return JSON.parse(readFileSync(EXAMPLE, 'utf8'));
}

/**
 * A container of the documents: the example's equipment with another reference.
 * @param {!Object} template the example's utilized transport equipment
 * @param {string} reference
 * @return {!Object}
 */
function equipmentOf(template, reference) {
  return {
    ...structuredClone(template),
    equipment: {...template.equipment, equipmentReference: reference},
  };
}

/**
 * A cargo item of the documents.
 * @param {!Object} template the example's cargo item
 * @param {{container: string, packages: number, weight: number}} share
 * @return {!Object}
 */
function cargoItemOf(template, {container, packages, weight}) {
  return {
    ...structuredClone(template),
    equipmentReference: container,
    cargoGrossWeight: {value: weight, unit: 'KGM'},
    outerPackaging: {...template.outerPackaging, numberOfPackages: packages},
  };
}

/**
 * A B/L to order with the given reference, port of discharge and cargo: its containers are those
 * the cargo names, in the order first named.
 * @param {string} reference the transport document reference (at most 20 characters)
 * @param {{
 *   port?: string,
 *   cargo: !Array<{container: string, packages: number, weight: number}>,
 * }} contents
 * @return {!Object} a DCSA 3.0 transport document
 */
export function blWithCargo(reference, {port = PARENT_PORT, cargo}) {
  const document = example();
  const equipmentTemplate = document.utilizedTransportEquipments[0];
  const item = document.consignmentItems[0];
  const containers = [...new Set(cargo.map(share => share.container))];
  return {
    ...document,
    transportDocumentReference: reference,
    transports: {
      ...document.transports,
      portOfDischarge: {UNLocationCode: port},
    },
    utilizedTransportEquipments: containers.map(c =>
      equipmentOf(equipmentTemplate, c),
    ),
    consignmentItems: [
      {
        ...item,
        cargoItems: cargo.map(share => cargoItemOf(item.cargoItems[0], share)),
      },
    ],
  };
}

/**
 * The parent B/L of a split: two containers, the cargo of PARENT_CARGO, discharged at
 * PARENT_PORT.
 * @param {string} reference
 * @return {!Object}
 */
export function twoContainerBl(reference) {
  return blWithCargo(reference, {
    cargo: Object.entries(PARENT_CARGO).map(([container, c]) => ({
      container,
      packages: c.packages,
      weight: c.weight,
    })),
  });
}

/**
 * The two children of a split by container: the first carries CONTAINER_A to PARENT_PORT, the
 * second CONTAINER_B to OTHER_PORT. Together they carry exactly the parent's cargo.
 * @param {string} firstReference
 * @param {string} secondReference
 * @return {!Array<!Object>}
 */
export function splitByContainer(firstReference, secondReference) {
  return [
    blWithCargo(firstReference, {
      port: PARENT_PORT,
      cargo: [{container: CONTAINER_A, ...PARENT_CARGO[CONTAINER_A]}],
    }),
    blWithCargo(secondReference, {
      port: OTHER_PORT,
      cargo: [{container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]}],
    }),
  ];
}

/**
 * The two children of a split dividing CONTAINER_A's cargo: the first carries 250 packages
 * (7 500 kg) of it, the second the other 150 (4 500 kg) and all of CONTAINER_B. Together they
 * carry exactly the parent's cargo; CONTAINER_A is named by both.
 * @param {string} firstReference
 * @param {string} secondReference
 * @return {!Array<!Object>}
 */
export function splitDividingContainer(firstReference, secondReference) {
  return [
    blWithCargo(firstReference, {
      cargo: [{container: CONTAINER_A, packages: 250, weight: 7500}],
    }),
    blWithCargo(secondReference, {
      port: OTHER_PORT,
      cargo: [
        {container: CONTAINER_A, packages: 150, weight: 4500},
        {container: CONTAINER_B, ...PARENT_CARGO[CONTAINER_B]},
      ],
    }),
  ];
}

/**
 * The body of a split as the API takes it: one `{format, document}` per child.
 * @param {!Array<!Object>} documents
 * @return {{children: !Array<{format: string, document: !Object}>}}
 */
export function splitBody(documents) {
  return {
    children: documents.map(document => ({format: 'dcsa-3.0', document})),
  };
}
