import type {Perm} from '@lrfe/platform';

/**
 * Permission catalogue. The identity service is the source of truth (GET /api/catalogue returns
 * the same list); it is mirrored here so the admin screens can group and label permissions.
 */
export const PERM_GROUPS: readonly string[] = [
  'General',
  'Capture',
  'Verification',
  'Land records',
  'Audit',
  'Administration',
];
export const PERMS: readonly Perm[] = [
  {
    id: 'dashboard.view',
    group: 'General',
    label: 'View dashboard',
    desc: 'KPIs, land records register, recent activity',
  },
  {
    id: 'capture.view',
    group: 'Capture',
    label: 'View capture station',
    desc: 'Batches, incoming pages, scanner status',
  },
  {
    id: 'capture.scan',
    group: 'Capture',
    label: 'Run scans & imports',
    desc: 'Start the scanner or ingest the hot folder',
  },
  {
    id: 'capture.rescan',
    group: 'Capture',
    label: 'Flag pages for rescan',
    desc: 'Mark poor captures for the operator',
  },
  {
    id: 'verify.view',
    group: 'Verification',
    label: 'View review queue',
    desc: 'Open documents and extracted metadata',
  },
  {
    id: 'verify.edit',
    group: 'Verification',
    label: 'Accept & correct metadata',
    desc: 'Change extracted field values',
  },
  {
    id: 'verify.file',
    group: 'Verification',
    label: 'File documents to EDRMS',
    desc: 'Approve a document as a record',
  },
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
  },
  {
    id: 'audit.view',
    group: 'Audit',
    label: 'View audit trail & evidence',
    desc: 'Provenance, hashes, full trail',
  },
  {
    id: 'audit.signoff',
    group: 'Audit',
    label: 'Sign off & raise findings',
    desc: 'Record the auditor’s conclusion',
  },
  {
    id: 'audit.export',
    group: 'Audit',
    label: 'Export evidence packs',
    desc: 'Download images, metadata and trail',
  },
  {
    id: 'anchors.view',
    group: 'Audit',
    label: 'View anchorings',
    desc: 'Batches put on the blockchain, their status and explorer links',
  },
  {
    id: 'admin.users',
    group: 'Administration',
    label: 'Manage users',
    desc: 'Invite, assign roles, suspend',
  },
  {
    id: 'admin.roles',
    group: 'Administration',
    label: 'Manage roles & permissions',
    desc: 'Edit the permission matrix',
  },
  {
    id: 'admin.policies',
    group: 'Administration',
    label: 'Manage security policies',
    desc: 'MFA, sessions, segregation of duties',
  },
  {
    id: 'admin.offices',
    group: 'Administration',
    label: 'Manage offices',
    desc: 'Add, rename and suspend office locations',
  },
];
