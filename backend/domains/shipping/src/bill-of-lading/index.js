/**
 * The bill-of-lading model of the shipping pack (epic CB-23), published as
 * `@lrfe/domain-shipping/bill-of-lading`. Unlike the pack itself (`src/index.js`), this entry may
 * use `@lrfe/common`: common loads the pack, never this entry. The shipping record service uses it.
 */
export {
  SCHEMA_VERSION,
  assertBillOfLading,
  billOfLadingHash,
  canonicalBillOfLading,
  checkBillOfLading,
} from './model.js';
