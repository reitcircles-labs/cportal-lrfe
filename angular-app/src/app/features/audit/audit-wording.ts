/**
 * Every text of the Audit screens and the small rules that pick between them (API-678's wording
 * sheet). Plain TypeScript without Angular, so it is unit tested on its own
 * (`npm run test:audit`). The screens say "blockchain" and never name the network or a tool.
 */

/** How far an item's anchoring has got, as the audit service reports it. */
export type AnchoringState = 'waiting' | 'sent' | 'onChain' | 'confirmed';

/** The automatic blockchain check of an item. */
export type MatchState = 'matches' | 'changed' | 'notOnChain' | 'unavailable';

/** A trail entry's proof status. */
export type ProofState = 'waiting' | 'anchored' | 'confirmed';

/** A tone the screens show a label in. */
export type Tone =
  'neutral' | 'info' | 'accent' | 'success' | 'warn' | 'danger';

/** A label and its tone. */
export interface Labelled {
  label: string;
  tone: Tone;
}

/** The proof status of an item, as the Proof column and the step 1 tags show it. */
export const ANCHORING: Record<
  AnchoringState,
  Labelled & {hint: string; canSignOff: boolean}
> = {
  waiting: {
    label: 'Waiting for next batch',
    tone: 'neutral',
    hint: 'Sealed. Goes out with the next hourly batch. Not ready to sign off yet.',
    canSignOff: false,
  },
  sent: {
    label: 'Sent to the blockchain',
    tone: 'info',
    hint: 'On its way, usually in a block within minutes. Not ready to sign off yet.',
    canSignOff: false,
  },
  onChain: {
    label: 'On the blockchain',
    tone: 'accent',
    hint: 'Written into a block. Can be signed off.',
    canSignOff: true,
  },
  confirmed: {
    label: 'Confirmed',
    tone: 'accent',
    hint: 'Settled under newer blocks, as almost every record soon is. Can be signed off.',
    canSignOff: true,
  },
};

/** The order a record goes through the proof statuses. */
export const ANCHORING_ORDER: AnchoringState[] = [
  'waiting',
  'sent',
  'onChain',
  'confirmed',
];

/** A trail entry's proof status in the same words. */
export function proofLabel(state: ProofState): Labelled {
  if (state === 'waiting') {
    return ANCHORING.waiting;
  }
  return state === 'confirmed' ? ANCHORING.confirmed : ANCHORING.onChain;
}

/** The automatic blockchain check of a document or version. */
export const MATCH: Record<MatchState, Labelled> = {
  matches: {label: 'Matches ✓', tone: 'success'},
  changed: {label: 'Changed since review ✕', tone: 'danger'},
  notOnChain: {label: 'Not on the blockchain yet', tone: 'neutral'},
  unavailable: {label: 'Couldn’t check', tone: 'warn'},
};

/** What the screens say when an item no longer matches the blockchain. */
export const CHANGED_SINCE_REVIEW =
  'This land record has changed since it was last reviewed and submitted, so its documents and details can’t be audited as true. It must be re-reviewed and submitted again before it can be audited.';

/** Why a version's changes cannot be checked yet: only data on the blockchain can be trusted. */
export function lockedNote(match: MatchState): string {
  switch (match) {
    case 'changed':
      return CHANGED_SINCE_REVIEW;
    case 'unavailable':
      return 'The blockchain couldn’t be reached. You can check the changes once the version is confirmed to match. Try again in a few minutes.';
    default:
      return 'This version goes to the blockchain with the next batch. You can check its changes once it is there and matches, because only what is on the blockchain can be trusted.';
  }
}

/** A version in the Versions card: how far the auditor has got with it. */
export function versionState(v: {
  match: MatchState;
  checked: boolean;
  signedOffAt?: string | null;
}): Labelled {
  if (v.signedOffAt) {
    return {label: `Signed off ${v.signedOffAt}`, tone: 'accent'};
  }
  if (v.match === 'changed') {
    return {label: 'Changed since review ✕', tone: 'danger'};
  }
  if (v.match !== 'matches') {
    return {label: 'Waiting for the blockchain', tone: 'neutral'};
  }
  return v.checked
    ? {label: '✓ Checked', tone: 'accent'}
    : {label: 'Not checked', tone: 'neutral'};
}

/** The Open issues of a document: a mismatch with the blockchain and/or open findings. */
export function openIssues(
  changed: boolean,
  openFindingNumbers: string[],
): string[] {
  const reasons: string[] = [];
  if (changed) {
    reasons.push('On-chain data mismatch');
  }
  for (const n of openFindingNumbers) {
    reasons.push(`Auditor finding ${n}`);
  }
  return reasons;
}

/** A document's status under its title: open only for a reason. */
export function documentStatus(
  changed: boolean,
  openFindingNumbers: string[],
  match: MatchState | null,
): {open: boolean; title: string; reason: string} {
  const reasons = openIssues(changed, openFindingNumbers);
  if (reasons.length) {
    return {open: true, title: 'Open', reason: reasons.join(' · ')};
  }
  return {
    open: false,
    title: 'No issues',
    reason:
      match === 'matches'
        ? 'matches the blockchain, no open finding'
        : 'no open finding',
  };
}

/** A short, stable finding number for the screens (#A1B2), from its id. */
export function findingNumber(id: string): string {
  return '#' + id.replace(/-/g, '').slice(0, 4).toUpperCase();
}

/** The Audit column of the list. */
export function auditColumn(audit: {
  range: {from: number; to: number} | null;
  newDocuments: number;
  check: 'matches' | 'changed' | 'notOnChain';
  lastSignoff: {toVersion: number} | null;
}): {title: string; note: string; tone: Tone} {
  if (!audit.range) {
    return {
      title: `✓ Audit signed off up to v${audit.lastSignoff?.toVersion ?? '?'}`,
      note: '',
      tone: 'accent',
    };
  }
  const title = `${rangeLabel(audit.range)} · ${audit.newDocuments} new document${audit.newDocuments === 1 ? '' : 's'}`;
  if (audit.check === 'changed') {
    return {
      title,
      note: 'Changed since review ✕ · re-review needed',
      tone: 'danger',
    };
  }
  if (audit.check === 'notOnChain') {
    return {title, note: 'Not all on the blockchain yet', tone: 'neutral'};
  }
  return {title, note: 'All match the blockchain ✓', tone: 'success'};
}

/** A range of versions: "v3" or "v2–v3". */
export function rangeLabel(range: {from: number; to: number}): string {
  return range.from === range.to
    ? `v${range.to}`
    : `v${range.from}–v${range.to}`;
}

/**
 * Why the audit cannot be signed off now, or null. The server's reason comes first (it checks
 * everything again); then the changes the auditor still has to check on this screen.
 */
export function signoffBlock(
  check: {canSignOff: boolean; reason: string | null},
  uncheckedVersions: number[],
): string | null {
  if (!check.canSignOff) {
    return check.reason ?? 'The audit can’t be signed off now.';
  }
  if (uncheckedVersions.length) {
    return `Check the changes in every version first: ${uncheckedVersions.map(n => `v${n}`).join(', ')} still to check.`;
  }
  return null;
}

/** How a finding stands, as its thread shows it. */
export function findingState(f: {
  status: 'open' | 'resolved' | 'closed';
  outcome: 'agreed' | 'mistake' | null;
  resolvedByVersion?: number | null;
}): string {
  if (f.status === 'open') {
    return 'open';
  }
  if (f.status === 'resolved') {
    return f.resolvedByVersion
      ? `resolved by a corrected version (v${f.resolvedByVersion})`
      : 'resolved by a corrected version';
  }
  return f.outcome === 'agreed'
    ? 'resolved by agreement'
    : 'closed, raised by mistake';
}

/** The (i) explanations, one per audit term. */
export const TIPS = {
  proofStatus:
    'Every change in the portal is sealed with a fingerprint. Once an hour the new fingerprints go to a public blockchain as one batch, where nobody can change them afterwards, not even the registry.\n\n' +
    ANCHORING_ORDER.map(
      s => `${ANCHORING[s].label}: ${ANCHORING[s].hint}`,
    ).join('\n'),
  audit:
    'How far the open audit is. An audit covers every version committed since the last audit sign-off.\n' +
    'v2–v3 · y new documents: the versions in the audit and the documents they added, with the result of the automatic blockchain check.\n' +
    'Audit signed off: the audit is complete up to that version. The sign-off goes on the blockchain with the next batch, shown by its proof status.',
  findings:
    'Problems raised by an auditor that are not closed yet. While a finding is open, the audit can’t be signed off.',
  listFilters:
    'Changed since last audit: land records with versions committed since their last audit sign-off. Pick the records to audit from here.\n' +
    'Needs attention: changed since review (doesn’t match the blockchain, so it must be re-reviewed and submitted again), or an open finding.\n' +
    'All: every land record.',
  documentFilters:
    'Needs attention: documents that don’t match the blockchain, or have an open finding.\n' +
    'New in this audit: documents added by the versions in this audit.\n' +
    'All: every document in the version shown.',
  checkpoint:
    'An audit is a checkpoint. You review every version committed since the last sign-off, and every document they added, then sign off once for all of them. The next audit starts from the version after this one.',
  trailChain:
    'Every trail entry includes the fingerprint of the entry before it, like links in a chain. If an entry were changed or removed, the chain would break at that point and this check would show where.',
  evidencePack:
    'One zip file with this record’s versions, documents, trail, sign-offs, findings and proofs. Anyone can check it offline with the registry’s verifier, without access to the portal. The export itself is recorded in the trail.',
  batch:
    'A group of fingerprints written to the blockchain together, once an hour. The proof shows that this item’s fingerprint is part of the batch.',
  fingerprint:
    'A short code calculated from the file and its sealed metadata. Change a single letter and the fingerprint changes completely.',
  blockchainCheck:
    'When the item opens, its fingerprint is calculated and compared with the fingerprint written to the blockchain. If they are the same, it is exactly what was sealed: not one letter has changed.',
  auditTrail:
    'Every action on this record, in order: who did what, and when. Entries can’t be edited or deleted. Each entry has its own fingerprint and goes to the blockchain with the hourly batch.',
  signoff:
    'Documents need no sign-off: each one is checked against the blockchain automatically. You sign off once per audit, for all versions since the last audit. A sign-off is final, goes into the trail, and goes on the blockchain with the next batch.',
  findingThread:
    'A finding stays open until it is answered and closed. Any auditor can answer and close it, and must first answer the issue. Other roles can read it. Every answer, with who wrote it and when, goes into the audit trail of the document or land record, under “Findings”.',
} as const;

/** The "How audit works" panel on the list. */
export const HOW_AUDIT_WORKS = [
  {
    step: '1 · On the blockchain',
    title: 'Every change is sealed and goes public',
    body: 'Every capture, filing, approval and commit gets a fingerprint: a short code that changes completely if anything changes. Once an hour the new fingerprints go to a public blockchain as one batch. After that nobody, not even the registry, can change them without it showing.',
    note: 'The Proof column shows where a land record is:',
  },
  {
    step: '2 · You check and sign off',
    title: 'One sign-off per audit',
    body: 'Open a land record. An audit covers every version committed since the last audit sign-off. Every document is checked against the blockchain automatically. You check each version’s changes: the documents belong to this land record, nothing is missing, and the record’s details follow from the documents. Then sign off the audit once.',
    note: 'If something doesn’t match, the land record has changed since it was reviewed and must be re-reviewed and submitted again. For anything else that is wrong, raise a finding. The Audit column shows how far you are.',
  },
  {
    step: '3 · Your audit goes on the blockchain',
    title: 'The sign-off is sealed too',
    body: 'The audit sign-off is a checkpoint: it is sealed and goes to the blockchain with the next batch, so it can’t be changed later either. It goes through the same statuses as step 1. The next audit of the record starts from the version after it.',
    note: 'The Audit column shows it as: Audit signed off, with its proof status.',
  },
] as const;

/** What a trail entry's event means, in words. */
const ACTIONS: Record<string, string> = {
  'intake.document.captured': 'Captured a scan',
  'intake.document.extracted': 'Read the scan’s details',
  'intake.document.filed': 'Sent the scan for filing',
  'edrms.document.filed': 'Filed document',
  'edrms.document.amended': 'Corrected document',
  'records.record.created': 'Created land record',
  'records.draft.changed': 'Changed the draft',
  'records.draft.submitted': 'Submitted for review',
  'records.draft.withdrawn': 'Withdrew from review',
  'records.draft.rejected': 'Returned the version',
  'records.record.committed': 'Committed version',
  'records.record.flagged': 'Flagged: a document was corrected',
  'extracts.extract.issued': 'Issued ownership extract',
  'extracts.extract.revoked': 'Revoked ownership extract',
  'bpm.instance.started': 'Started a review',
  'bpm.instance.completed': 'Finished a review',
  'bpm.instance.cancelled': 'Cancelled a review',
  'bpm.instance.failed': 'A review stopped with an error',
  'bpm.task.created': 'Created a task',
  'bpm.task.completed': 'Completed a task',
  'identity.user.invited': 'Invited a user',
  'audit.signoff.recorded': 'Signed off audit',
  'audit.finding.raised': 'Raised finding',
  'audit.finding.answered': 'Answered finding',
  'audit.finding.closed': 'Closed finding',
  'audit.item.changed': 'Found changed since review',
  'audit.evidence.exported': 'Exported evidence pack',
  'audit.trail.gap': 'Gap in the trail',
};

/**
 * A trail entry's event in words. Sign-in and user administration events (identity.*) carry their
 * action in words already ("Signed in", "Roles changed"); an event without a label is shown as it
 * is named.
 */
export function actionLabel(
  type: string,
  data: Record<string, unknown> = {},
): string {
  if (ACTIONS[type]) {
    return ACTIONS[type];
  }
  return type.startsWith('identity.') && typeof data['action'] === 'string'
    ? data['action']
    : type;
}

/** The families of events the trail search filters on, by where they come from. */
export const EVENT_GROUPS: Array<{prefix: string; label: string}> = [
  {prefix: 'intake.', label: 'Capture and verify'},
  {prefix: 'edrms.', label: 'Documents'},
  {prefix: 'records.', label: 'Land records'},
  {prefix: 'bpm.', label: 'Reviews and tasks'},
  {prefix: 'identity.', label: 'Users and sign-in'},
  {prefix: 'audit.', label: 'Audit'},
];

/** Where an entry came from, as the trail search shows it. */
export function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    intake: 'Capture',
    edrms: 'Documents',
    'land-records': 'Land records',
    extracts: 'Ownership extracts',
    bpm: 'Reviews and tasks',
    identity: 'Users',
    audit: 'Audit',
  };
  return labels[source] ?? source;
}

/** A recorded gap in words: how many events were lost before they could be recorded. */
export function gapText(missing: number): string {
  return `${missing} event${missing === 1 ? ' was' : 's were'} lost before the audit service could record ${missing === 1 ? 'it' : 'them'}. The gap is recorded so that the trail is never passed off as complete.`;
}

/** The result of checking the whole trail's chain. */
export function chainResult(r: {intact: boolean; brokenAt?: number}): {
  text: string;
  tone: Tone;
} {
  return r.intact
    ? {
        text: 'The trail is intact: every entry links to the one before it.',
        tone: 'success',
      }
    : {
        text: `The trail is broken at entry ${r.brokenAt}. Entries from there on can’t be trusted from the chain alone. Tell the registry’s system administrator.`,
        tone: 'danger',
      };
}

/** The (i) explanations of the trail search. */
export const SEARCH_TIPS = {
  subject:
    'A person: everything they did. A document: everything that happened to it, by its document number, from capture to corrections. A land record: everything on it and on the documents it is made of, by its land record number.',
  type: 'One kind of event, or a family of them, such as everything about documents.',
  dates: 'When the event happened, in local time. Both days are included.',
  source:
    'The part of the portal that recorded the event: capture, documents, land records, reviews and tasks, users or audit.',
} as const;

/** The CSS tag class for a tone (the app's tag styles). */
export function toneClass(tone: Tone): string {
  const classes: Record<Tone, string> = {
    neutral: 'tag tag-neutral',
    info: 'tag tag-accent-2',
    accent: 'tag tag-accent',
    success: 'tag tag-accent',
    warn: 'tag tag-outline',
    danger: 'tag tag-danger',
  };
  return classes[tone];
}

/** A date as the screens show it: "10 Oct 2026". */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** A date and time as the screens show it: "10 Oct 2026, 09:20". */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  return `${shortDate(iso)}, ${d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}`;
}
