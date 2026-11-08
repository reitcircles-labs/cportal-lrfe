import {landRecordReview} from './workflows/land-record-review.js';

/**
 * The land registry's `workflows` section (CB-3): its own process definitions, and what the
 * platform's audit workflows need from it. The node names, role ids and keys are stored in the
 * processes already started, so they never change.
 */
export const workflows = {
  // deployed by bpm as they are, beside the platform's definitions
  definitions: [landRecordReview],
  // who acknowledges an audit finding or a change since review (bpm's audit-finding and
  // audit-rereview): the records officers and the registrars, one task each, in parallel
  auditAcknowledgers: [
    {task: 'officer', role: 'rec'},
    {task: 'registrar', role: 'sup'},
  ],
  // the platform's definitions described in the registry's words
  descriptions: {
    'audit-finding':
      'An auditor raised a finding on a land record version or a document version. The records officers and the registrars see it in their task inbox and acknowledge it. The finding stays open in the audit service until a newer reviewed version resolves it or the auditor closes it; then the audit service withdraws this process if it is still open. Started by the audit service (API-659).',
    'audit-rereview':
      'A land record version or a document version in it no longer matches the blockchain: the land record changed since it was reviewed and submitted, so it cannot be audited as true. The records officers and the registrars see it in their task inbox and acknowledge it; the records office then opens a new draft, corrects what changed and submits it for review. Started by the audit service once per changed item (API-680).',
  },
};
