/**
 * The shipping domain pack (CB-3): empty until the bill-of-lading features of epic CB-1. With
 * `LRFE_DOMAIN=shipping` the shared services start with no document types, no product roles or
 * workflows, no record kind and no product wording.
 * @type {import('@lrfe/domain-pack').DomainPack}
 */
export const pack = {
  name: 'shipping',
  documents: {},
  identity: {},
  workflows: {},
  recordKind: null,
  wording: {edrms: {}, identity: {}, audit: {}, extracts: {}},
};
