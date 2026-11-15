/**
 * The shipping product's `identity` section: the B/L permissions (CB-27; issuing and endorsing,
 * CB-34), the roles (CB-44: `bld` the carrier's staff, who draft, approve and issue; `blt` the
 * trade staff of shippers, banks and buyers, who move the B/Ls they hold), and the demo data
 * (CB-28; the demo's organisations and a user per persona, CB-48). The permission and role ids
 * are stored in databases and tokens: they never change. An install seeded before CB-44 keeps the
 * stored permissions of `bld` and gets `blt` at start.
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
   * The organisation running a shipping install when the site does not name it (LRFE_ORG_*): a
   * neutral operator that carriers, banks and traders join (CB-9, decision 4), named as the
   * shipping app names it (angular-app/projects/shipping/public/config.json). It names the default
   * organisation, of the platform administrator, and the authenticator app's entry (CB-48).
   */
  defaultOrganisation: {
    name: 'Shipping Registry',
    subtitle: '',
    parent: '',
    place: '',
  },

  /**
   * The organisations of the demo's journey (CB-48): a carrier, the shipper (an exporter), the
   * exporter's bank, the buyer's bank and the buyer, in the order a negotiable B/L travels. Made
   * up, of no country. Created with the demo users, each with one office of the same code and
   * name, as the onboarding screens make one (CB-43).
   */
  demoOrganisations: [
    {code: 'BWML', name: 'Bluewater Meridian Lines'},
    {code: 'HCEX', name: 'Highland Coffee Exporters'},
    {code: 'HTB', name: 'Harbour Trust Bank'},
    {code: 'NGCB', name: 'Northgate Commercial Bank'},
    {code: 'RCI', name: 'Roastery Collective Imports'},
  ],

  /**
   * The demo users identity creates when the site sets a demo password (SEED_DEMO_PASSWORD),
   * one per persona of the CB-9 map, in the organisation they work for (CB-48). Fictitious. The
   * platform administrator, who admits organisations and never moves a B/L; the carrier's
   * documentation clerk and its release manager (two people: one drafts, the other approves,
   * four eyes); and the trade staff of the shipper, both banks and the buyer. The shipping e2e
   * tests sign in as them (demo/SHIPPING-STORYLINE.md follows them).
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
      name: 'Lena Okafor',
      email: 'l.okafor@bluewater-lines.example',
      office: 'Bluewater Meridian Lines',
      organisation: 'BWML',
      roles: ['bld'],
      status: 'Active',
    },
    {
      name: 'Ravi Menon',
      email: 'r.menon@bluewater-lines.example',
      office: 'Bluewater Meridian Lines',
      organisation: 'BWML',
      roles: ['bld'],
      status: 'Active',
    },
    {
      name: 'Ana Ribeiro',
      email: 'a.ribeiro@highland-coffee.example',
      office: 'Highland Coffee Exporters',
      organisation: 'HCEX',
      roles: ['blt'],
      status: 'Active',
    },
    {
      name: 'Grace Mensah',
      email: 'g.mensah@harbour-trust.example',
      office: 'Harbour Trust Bank',
      organisation: 'HTB',
      roles: ['blt'],
      status: 'Active',
    },
    {
      name: 'Mei Tanaka',
      email: 'm.tanaka@northgate-bank.example',
      office: 'Northgate Commercial Bank',
      organisation: 'NGCB',
      roles: ['blt'],
      status: 'Active',
    },
    {
      name: 'Yusuf Demir',
      email: 'y.demir@roastery-collective.example',
      office: 'Roastery Collective Imports',
      organisation: 'RCI',
      roles: ['blt'],
      status: 'Active',
    },
  ],
};
