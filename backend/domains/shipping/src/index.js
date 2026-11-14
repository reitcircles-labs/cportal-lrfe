/**
 * The shipping domain pack (CB-3), filled in by the bill-of-lading features of epic CB-1. With
 * `LRFE_DOMAIN=shipping` the shared services start with no document types, no product roles or
 * workflows, no record kind and no product wording; identity adds the B/L permissions (CB-27).
 * @type {import('@lrfe/domain-pack').DomainPack}
 */
export const pack = {
  name: 'shipping',
  documents: {},
  identity: {
    permissionGroups: ['Bills of lading'],
    // The ids are stored in databases and tokens: they never change.
    permissions: [
      {
        id: 'bl.read',
        group: 'Bills of lading',
        label: 'View bills of lading',
        desc: 'The B/Ls of your organisation and their versions',
      },
      {
        id: 'bl.draft',
        group: 'Bills of lading',
        label: 'Draft bills of lading',
        desc: 'Create, change and submit draft B/Ls of your organisation',
      },
    ],
  },
  workflows: {},
  recordKind: null,
  wording: {edrms: {}, identity: {}, audit: {}, extracts: {}},
};
