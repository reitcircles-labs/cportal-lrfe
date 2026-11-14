/**
 * The shipping product's `identity` section: the B/L permissions (CB-27), the role that drafts
 * B/Ls, and the demo data (CB-28). The permission and role ids are stored in databases and tokens:
 * they never change.
 * @type {import('@lrfe/domain-pack').DomainPack['identity']}
 */
export const identity = {
  permissionGroups: ['Bills of lading'],

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

  roles: [
    {
      id: 'bld',
      label: 'B/L documentation',
      desc: 'Drafts the B/Ls of the organisation and submits them for review.',
      home: '/',
      perms: ['bl.read', 'bl.draft'],
    },
  ],

  /** The office created when a database has none and the site sets none (development, demos). */
  offices: [
    {
      code: 'HQ',
      name: 'Head office',
      type: 'registry',
      address: '',
      contact: '',
    },
  ],

  /**
   * The demo users identity creates when the site sets a demo password (SEED_DEMO_PASSWORD).
   * Fictitious. The shipping e2e tests sign in as them: two B/L clerks, so that one submits and
   * the other approves (four eyes).
   */
  demoUsers: [
    {
      name: 'Alex Morgan',
      email: 'a.morgan@shipping.example',
      office: 'Head office',
      roles: ['adm'],
      status: 'Active',
    },
    {
      name: 'Sam Carter',
      email: 's.carter@shipping.example',
      office: 'Head office',
      roles: ['bld'],
      status: 'Active',
    },
    {
      name: 'Robin Lee',
      email: 'r.lee@shipping.example',
      office: 'Head office',
      roles: ['bld'],
      status: 'Active',
    },
  ],
};
