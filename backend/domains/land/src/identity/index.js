import {DEMO_USERS} from './demo-users.js';

/**
 * The land registry's `identity` section (CB-3): what identity adds to the platform's own
 * permissions and roles (dashboard, capture, verification, audit, administration and the system
 * administrator). The role and permission ids are stored in databases and tokens: they never
 * change. Order matters: the groups come between the platform's Verification and Audit groups, the
 * roles before the system administrator, as the administration screens list them.
 */
export const identity = {
  permissionGroups: ['Land records'],

  permissions: [
    {
      id: 'record.view',
      group: 'Land records',
      label: 'View land records',
      desc: 'ERP records, linked documents, owners',
    },
    {
      id: 'record.create',
      group: 'Land records',
      label: 'Create land records',
      desc: 'Open a new erf or farm record',
    },
    {
      id: 'record.link',
      group: 'Land records',
      label: 'Add documents to records',
      desc: 'Link EDRMS documents to a record',
    },
    {
      id: 'record.unlink',
      group: 'Land records',
      label: 'Remove documents from records',
      desc: 'Return a document to the unlinked pool',
    },
    {
      id: 'record.comment',
      group: 'Land records',
      label: 'Comment on records',
      desc: 'Post to the record discussion thread',
    },
    {
      id: 'record.finalize',
      group: 'Land records',
      label: 'Finalize records',
      desc: 'Commit a version for tokenization',
    },
    {
      id: 'extract.issue',
      group: 'Land records',
      label: 'Issue ownership extracts',
      desc: 'Issue an extract of a record for its owner, revoke one',
      since: 4,
    },
  ],

  roles: [
    {
      id: 'sup',
      label: 'Registrar (supervisor)',
      desc: 'Oversees the registry. Finalizes records and reviews audit evidence.',
      home: '/',
      perms: [
        'dashboard.view',
        'capture.view',
        'verify.view',
        'record.view',
        'record.comment',
        'record.finalize',
        'audit.view',
        'audit.export',
        'anchors.view',
        'admin.users',
      ],
    },
    {
      id: 'scan',
      label: 'Scan operator',
      desc: 'Captures deeds, grants and SG diagrams at the scan station.',
      home: '/capture',
      perms: [
        'dashboard.view',
        'capture.view',
        'capture.scan',
        'capture.rescan',
        'anchors.view',
      ],
    },
    {
      id: 'rev',
      label: 'Metadata reviewer',
      desc: 'Verifies extracted metadata against the image and files to the EDRMS.',
      home: '/verify',
      perms: [
        'dashboard.view',
        'capture.view',
        'capture.rescan',
        'verify.view',
        'verify.edit',
        'verify.file',
        'record.view',
        'record.comment',
        'anchors.view',
      ],
    },
    {
      id: 'rec',
      label: 'Records officer',
      desc: 'Creates land records, links documents and prepares them for finalization.',
      home: '/link',
      perms: [
        'dashboard.view',
        'verify.view',
        'record.view',
        'record.create',
        'record.link',
        'record.unlink',
        'record.comment',
        'record.finalize',
        'extract.issue',
        'anchors.view',
      ],
    },
    {
      id: 'aud',
      label: 'Auditor · read-only',
      desc: 'Office of the Auditor-General. Inspects evidence and signs off; cannot change records.',
      home: '/audit',
      perms: [
        'dashboard.view',
        'capture.view',
        'verify.view',
        'record.view',
        'audit.view',
        'audit.signoff',
        'audit.export',
        'anchors.view',
      ],
    },
  ],

  /** Separation-of-duty rules on land permissions; the platform has its own (sod1, sod4). */
  separationOfDuties: [
    {
      id: 'sod2',
      a: 'record.finalize',
      b: 'audit.signoff',
      label: 'Whoever finalizes records cannot sign off audits',
      on: true,
    },
    {
      id: 'sod3',
      a: 'admin.roles',
      b: 'record.finalize',
      label: 'Administrators cannot finalize land records',
      on: true,
    },
  ],

  /**
   * Offices created when a database has none and the site sets none (development): Namibia's two
   * deeds offices, as listed by the Directorate of Deeds Registration (checked 1 October 2026).
   * Windhoek registers land everywhere except Rehoboth; Rehoboth registers title in Rehoboth town
   * and constituency and the surrounding farmland.
   */
  offices: [
    {
      code: 'WDH',
      name: 'Deeds Registry · Windhoek',
      type: 'registry',
      address: 'Robert Mugabe Avenue, Windhoek',
      contact: '',
    },
    {
      code: 'REH',
      name: 'Deeds Registry · Rehoboth',
      type: 'registry',
      address: '',
      contact: '',
    },
  ],

  demoUsers: DEMO_USERS,
};
