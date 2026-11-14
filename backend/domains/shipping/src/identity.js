/**
 * The shipping product's `identity` section: the B/L permissions (CB-27; issuing and endorsing,
 * CB-34), the roles (CB-44: `bld` the carrier's staff, who draft, approve and issue; `blt` the
 * trade staff of shippers, banks and buyers, who move the B/Ls they hold), and the demo data
 * (CB-28). The permission and role ids are stored in databases and tokens: they never change.
 * An install seeded before CB-44 keeps the stored permissions of `bld` and gets `blt` at start.
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
    {
      id: 'bl.issue',
      group: 'Bills of lading',
      label: 'Issue bills of lading',
      desc: "As the carrier: issue your organisation's B/Ls, void, release and deliver them",
    },
    {
      id: 'bl.endorse',
      group: 'Bills of lading',
      label: 'Endorse bills of lading',
      desc: 'As the holder: endorse, transfer, surrender or switch to paper the B/Ls your organisation holds',
    },
  ],

  roles: [
    {
      id: 'bld',
      label: 'B/L documentation (carrier)',
      desc: "A carrier's staff: drafts the organisation's B/Ls and submits them for approval, approves another person's draft (never their own) and issues it.",
      home: '/',
      perms: ['bl.read', 'bl.draft', 'bl.issue'],
    },
    {
      id: 'blt',
      label: 'B/L trade (shipper, bank, buyer)',
      desc: 'The staff of a shipper, bank or buyer: sees the B/Ls the organisation is party to, endorses, transfers and surrenders the ones it holds.',
      home: '/',
      perms: ['bl.read', 'bl.endorse'],
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
   * Fictitious. The shipping e2e tests sign in as them: two carrier B/L clerks, so that one
   * submits and the other approves (four eyes); the trade staff are made by the tests in their
   * own organisations.
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
