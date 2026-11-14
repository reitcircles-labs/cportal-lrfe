import {identity} from './identity.js';
import {recordKind} from './record-kind.js';

/**
 * The shipping domain pack (CB-3), filled in by the bill-of-lading features of epic CB-1. With
 * `LRFE_DOMAIN=shipping` the shared services start with no document types, workflows or product
 * wording; identity adds the B/L permissions, the B/L documentation role and the demo data, and
 * the record kind names the B/L record service (`shipping-records`, CB-28). The B/L model itself is
 * `@lrfe/domain-shipping/bill-of-lading`.
 * @type {import('@lrfe/domain-pack').DomainPack}
 */
export const pack = {
  name: 'shipping',
  documents: {},
  identity,
  workflows: {},
  recordKind,
  wording: {edrms: {}, identity: {}, audit: {}, extracts: {}},
};
