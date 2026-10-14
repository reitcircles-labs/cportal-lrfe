/**
 * Every text of the Anchorings screens and the small rules that pick between them (API-698, the
 * wording sheet of the design API-688). Plain TypeScript without Angular, so it is unit tested on
 * its own (`npm run test:audit`). The screens say "blockchain" and never name the network or a tool:
 * the network appears only in the explorer link's web address.
 */
import type {
  BatchDetail, BatchFilter, BatchStatus, CoveredVersion, FailReason, HistoryItem, ItemStatus, LookupResult
} from '../../api/anchorings.api';

/** A tone the screens show a label in. */
export type Tone = 'neutral' | 'info' | 'accent' | 'success' | 'warn' | 'danger';

/** A label, its tone and its explanation. */
export interface Status {
  label: string;
  tone: Tone;
  hint: string;
}

/** The statuses of a batch, in the order a batch goes through them, and Failed. */
export const BATCH_STATUS: Record<BatchStatus, Status> = {
  sent: { label: 'Sent to the blockchain', tone: 'info', hint: 'On its way, usually in a block within minutes.' },
  onChain: { label: 'On the blockchain', tone: 'accent', hint: 'Written into a block. What it covers can be audited.' },
  confirmed: { label: 'Confirmed', tone: 'accent', hint: '10 newer blocks on top of it. It can no longer be undone.' },
  failed: { label: 'Failed', tone: 'danger', hint: 'It never reached the blockchain. The next batch replaced it and covers the same fingerprints, so nothing is lost.' }
};

/** The statuses of a land record version, document or sign-off in a search result. */
export const ITEM_STATUS: Record<ItemStatus, Status> = {
  waiting: { label: 'Waiting for next batch', tone: 'neutral', hint: 'Sealed. Goes out with the next batch.' },
  sent: BATCH_STATUS.sent,
  onChain: BATCH_STATUS.onChain,
  confirmed: BATCH_STATUS.confirmed,
  notRecorded: { label: 'Not recorded', tone: 'warn', hint: 'No fingerprint of it is recorded yet.' }
};

/** The plain reason a batch failed, and its longer explanation. */
export const FAIL_REASON: Record<FailReason, { shown: string; text: string; step: string; note: string }> = {
  expired: {
    shown: 'Expired before it reached the blockchain',
    text: 'The blockchain accepts a transaction only for a limited time, about an hour, and this one wasn’t taken into a block in that time.',
    step: 'Expired',
    note: 'Not taken into a block in time'
  },
  rolledBackExpired: {
    shown: 'Dropped from the blockchain and expired before it got back in',
    text: 'It was in a block that the blockchain later replaced. It was sent again, but expired before it got into a new block.',
    step: 'Dropped and expired',
    note: 'Not back in a block in time'
  },
  refused: {
    shown: 'The blockchain refused the transaction',
    text: 'The blockchain did not accept the transaction when it was first sent.',
    step: 'Refused',
    note: 'Not accepted when first sent'
  }
};

/** The (i) explanations, one per term. */
export const TIPS = {
  batch: 'The anchoring’s number. It goes up by one with every anchoring, failed ones included, and is written on the blockchain with it.',
  created: 'When the portal made the batch from the fingerprints sealed so far.',
  covers: 'How many new fingerprints this batch put on the blockchain since the last batch that got there: land record versions, documents and audit sign-offs. It also covers the audit trail up to the time it was made.',
  status: (Object.keys(BATCH_STATUS) as BatchStatus[]).map(s => `${BATCH_STATUS[s].label}: ${BATCH_STATUS[s].hint}`).join('\n'),
  transaction: 'The transaction that carries this batch. The link opens it on a public blockchain explorer, a website run independently of the registry, where anyone can read what it holds.',
  block: 'The block of the blockchain the transaction is in, and how many newer blocks are on top of it. At 10 the batch is Confirmed.',
  filters: 'All: every anchoring, newest first.\n'
    + 'In progress: sent or in a block, not confirmed yet. There is never more than one at a time.\n'
    + 'Failed: anchorings that never reached the blockchain, each with the batch that replaced it.',
  nextBatch: 'Fingerprints made since the last batch wait in the portal, sealed. They go out together with the next batch, about an hour after the last one. Until then their status is Waiting for next batch.',
  onChain: 'Exactly what the transaction holds. Nothing else goes on the blockchain: no names, ID numbers, parcels or document content. You can compare every value below with the explorer.',
  factBatch: 'The anchoring’s number, written on the blockchain as "batch".',
  root: 'One fingerprint made from every fingerprint the portal has sealed up to this batch. If any of them changed, this value would be different.',
  size: 'How many fingerprints, from the very first, the combined fingerprint is made from.',
  prev: 'The combined fingerprint of the last batch that reached the blockchain. It links the batches into a chain, so none can be removed or replaced unnoticed.',
  factTransaction: 'The transaction that carries this batch. Open it on the explorer to see the values above.',
  factBlock: 'The block of the blockchain the transaction is in.',
  confirmations: 'How many newer blocks are on top of it. At 10 it is Confirmed and can no longer be undone.',
  covered: 'The fingerprints this batch put on the blockchain for the first time: everything sealed since the last batch that got there. Each land record version is shown with everything its fingerprint stands for: its documents and the versions before it.',
  madeOf: 'Everything this version’s fingerprint stands for: its documents (each with its own fingerprint and file) and, through the previous version’s fingerprint, every earlier version. Documents already on the blockchain from earlier batches are still covered: if any of them changed, this version’s fingerprint would no longer match.',
  documents: 'Every document version this batch put on the blockchain for the first time: newly filed documents and corrected ones. A document a land record version in this batch is made of says so; the others are covered on their own, and later by the land record version that uses them.',
  replacedBy: 'The batch that took this one’s place. It was made from the same starting point, the last batch on the blockchain, and the blockchain can accept only one of the two, never both.',
  preparedTransaction: 'The transaction that would have carried this batch. It never reached the blockchain, so an explorer won’t find it.',
  lastConfirmed: 'The newest batch with 10 newer blocks on top of it. It can no longer be undone.',
  inProgress: 'The batch on its way: sent, or in a block and not confirmed yet. There is never more than one at a time.',
  prepared: 'The values this batch would have written. They never reached the blockchain, so an explorer won’t find this transaction. They are kept so that nothing about the anchoring history is hidden.'
} as const;

/** The "How anchoring works" panel. Step 3 lists the statuses. */
export const HOW_ANCHORING_WORKS = [
  {
    step: '1 · One batch an hour',
    title: 'New fingerprints are combined into one',
    body: 'Every land record version, document and audit sign-off is sealed with a fingerprint. Once an hour, all new fingerprints are combined into one combined fingerprint, and that one value is written to a public blockchain. That is an anchoring. Only fingerprints go on the blockchain: no names, numbers or content.'
  },
  {
    step: '2 · A chain of batches',
    title: 'Each batch points to the one before',
    body: 'Every anchoring also carries the previous batch’s combined fingerprint. The batches form an unbroken chain on the blockchain, so nobody, not even the registry, can quietly remove or rewrite one.'
  },
  {
    step: '3 · Sent, in a block, confirmed',
    title: 'Where each batch is',
    body: ''
  }
] as const;

/** Step 3 of "How anchoring works": each status with what it means for a batch. */
export const JOURNEY: { status: BatchStatus; text: string }[] = [
  { status: 'sent', text: 'On its way. Usually in a block within minutes.' },
  { status: 'onChain', text: 'Written into a block. What it covers can be audited.' },
  { status: 'confirmed', text: '10 newer blocks on top. It can no longer be undone. Almost every batch gets here within minutes.' },
  { status: 'failed', text: 'Rare: it didn’t get into a block in time. The next batch replaces it and covers the same fingerprints.' }
];

/** The list filters, in the order the screen shows them. */
export const FILTERS: { id: BatchFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'progress', label: 'In progress' },
  { id: 'failed', label: 'Failed' }
];

/** Messages of the screens. */
export const MESSAGES = {
  searchIntro: 'Look up a land record or document to see whether it is on the blockchain, since when, and in which batch.',
  tooLong: 'That is too long to be a number or an Erf. Shorten it to 100 characters at most.',
  searchLabel: 'Land record number, document number, Erf or deed number',
  searchPlaceholder: 'e.g. LR-NA-2026-000001, EDR-NA-2026-000412, Erf 1873 or T 2210/2008',
  empty: 'Nothing has been put on the blockchain yet. The first batch goes out about an hour after the first record is sealed.',
  unreadable: 'The anchorings could not be read. Try again in a minute.',
  explorer: 'View on a blockchain explorer ↗',
  notOnChain: 'Not on the blockchain: an explorer won’t find it',
  recordFootnote: 'Each batch shows exactly what went on the blockchain, with a link to check it on a public blockchain explorer.',
  waitingFootnote: 'Fingerprints wait in the portal, sealed, until the next hourly batch. They can’t be changed while they wait without it showing.',
  documentFootnote: 'A corrected document gets a new version with its own fingerprint and batch. The earlier version stays on the blockchain.'
} as const;

/** "Nothing found" for a search. */
export function notFoundText(query: string): string {
  return `Nothing found for “${query}”. Check the number, or search by Erf and township, for example Erf 1873.`;
}

/** The CSS tag class for a tone (the app's tag styles). */
export function toneClass(tone: Tone): string {
  const classes: Record<Tone, string> = {
    neutral: 'tag tag-neutral', info: 'tag tag-accent-2', accent: 'tag tag-accent',
    success: 'tag tag-accent', warn: 'tag tag-outline', danger: 'tag tag-danger'
  };
  return classes[tone];
}

/** A number as the screens show it: "1,412". */
export function count(n: number): string {
  return n.toLocaleString('en');
}

/** "1 document", "4 documents". */
export function plural(n: number, word: string): string {
  return `${count(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** A transaction's short form: "9f3a…c21e". */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 4)}…${hash.slice(-4)}`;
}

/** A time as the screens show it: "13:10". */
function time(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** A date and time: "Today 13:10", or "10 Oct 2026, 13:10" on another day. */
export function when(iso: string | null | undefined, now = new Date()): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    return `Today ${time(d)}`;
  }
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${time(d)}`;
}

/** When the next batch is due: "about 15:10" today, else with its date. */
export function aboutTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? `about ${time(d)}` : `about ${when(iso, now)}`;
}

/** The Covers column: "52 fingerprints", or a dash for a failed batch. */
export function coversText(covers: number | null): string {
  return covers === null ? '—' : plural(covers, 'fingerprint');
}

/** How deep a batch is: "4 of 10 confirmations", "10+ confirmations", or nothing. */
export function depthText(confirmations: number | null, needed: number): string {
  if (confirmations === null) {
    return '';
  }
  return confirmations >= needed ? `${needed}+ confirmations` : `${confirmations} of ${needed} confirmations`;
}

/** A range of versions: "v3" or "v1–v2". */
export function rangeLabel(from: number, to: number): string {
  return from === to ? `v${to}` : `v${from}–v${to}`;
}

/** What a land record version is made of: "4 documents · v1–v2 before it", and a note on its documents. */
export function madeOf(v: CoveredVersion): { text: string; note: string } {
  const parts: string[] = [];
  if (v.documents) {
    parts.push(plural(v.documents, 'document'));
  }
  if (v.versionsBefore) {
    parts.push(`${rangeLabel(1, v.versionsBefore)} before it`);
  }
  const text = parts.join(' · ') || 'No documents';
  let note = '';
  if (v.documents && v.documentsEarlier === v.documents) {
    note = v.documents === 1 ? 'Already on the blockchain' : `All ${v.documents} already on the blockchain`;
  } else if (v.documents && v.documentsEarlier === 0) {
    note = v.documents === 1 ? '1 document new in this batch' : `All ${v.documents} new in this batch`;
  } else if (v.documents) {
    note = `${plural(v.documentsEarlier, 'document')} already on the blockchain`;
  }
  return { text, note };
}

/** A document version: "v1", or "v2 (corrected)". */
export function documentVersionText(version: number): string {
  return version === 1 ? 'v1' : `v${version} (corrected)`;
}

/** The land record versions in the batch made of a document, or that there are none. */
export function usedInText(usedIn: { recordNo: string | null; label: string | null; versionNumber: number }[]): string {
  if (!usedIn.length) {
    return 'Not in a land record version in this batch';
  }
  return usedIn.map(u => `${u.label ?? u.recordNo ?? 'A land record'} · v${u.versionNumber}`).join('; ');
}

/** "a, b and c". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The note on gaps in batch numbers, naming the failed batches shown and how many more there are. */
export function gapNote(failed: number[], total: number): string {
  const names = failed.map(count);
  const more = total - failed.length;
  if (more > 0) {
    names.push(more === 1 ? 'one other' : `${count(more)} others`);
  }
  const subject = total === 1 ? `batch ${names[0]} failed, so its number never appears there. It was` : `batches ${listOf(names)} failed, so their numbers never appear there. Each was`;
  return `${subject} replaced by the next batch, which points back to the last batch that did get there, so the chain has no break.`;
}

/** Under the list: "Newest 1–25 of 1,413 anchorings", or how many match a filter. */
export function rangeText(filter: BatchFilter, page: number, size: number, total: number): string {
  if (!total) {
    return 'No anchorings';
  }
  const first = (page - 1) * size + 1;
  const last = Math.min(first + size - 1, total);
  if (filter === 'all') {
    return `Newest ${first}–${last} of ${plural(total, 'anchoring')}`;
  }
  if (total <= size) {
    return total === 1 ? '1 anchoring matches' : `${count(total)} anchorings match`;
  }
  return `${first}–${last} of ${count(total)} matching anchorings`;
}

/** A search's answer in plain words, and whether it is a yes. */
export function answerText(result: Extract<LookupResult, { kind: 'record' | 'document' }>, now = new Date()): { text: string; good: boolean } {
  const { answer } = result;
  const subject = result.kind === 'record' ? `v${answer.version}` : 'This document';
  switch (answer.status) {
    case 'yes':
      return { text: result.kind === 'record' ? `Yes. Everything up to v${answer.version} is on the blockchain.` : 'Yes. This document is on the blockchain.', good: true };
    case 'sent':
      return { text: `On its way. ${subject} was sent to the blockchain with batch ${count(answer.batch ?? 0)}, usually in a block within minutes.`, good: false };
    case 'waiting': {
      const due = answer.nextDueAt ? `, ${aboutTime(answer.nextDueAt, now)}` : '';
      const before = result.kind === 'record' && earlierOnChain(result.history, answer.version) ? ' Everything before it is on the blockchain.' : '';
      return { text: `Not yet. ${subject} goes out with the next batch${due}.${before}`, good: false };
    }
    default:
      return { text: 'Not on the blockchain. No fingerprint of it is recorded yet.', good: false };
  }
}

/** Whether every land record version before `version` is in a block. */
function earlierOnChain(history: HistoryItem[], version: number | null): boolean {
  const earlier = history.filter(h => h.kind === 'version' && (h.versionNumber ?? 0) < (version ?? 0));
  return earlier.length > 0 && earlier.every(h => h.status === 'onChain' || h.status === 'confirmed');
}

/** The status shown with a search's answer. */
export function answerStatus(result: Extract<LookupResult, { kind: 'record' | 'document' }>): Status {
  const current = result.history.find(h => (result.kind === 'record' ? h.kind === 'version' && h.versionNumber === result.answer.version : h.kind === 'document' && h.version === result.answer.version));
  return ITEM_STATUS[current?.status ?? (result.answer.status === 'notRecorded' ? 'notRecorded' : 'waiting')];
}

/** One line of a search result's history: what happened and when. */
export function historyLine(h: HistoryItem, typeLabel: (id: string | null | undefined) => string, now = new Date()): { what: string; when: string } {
  switch (h.kind) {
    case 'version':
      return { what: `Version v${h.versionNumber} committed`, when: when(h.at, now) };
    case 'signoff':
      return { what: `Audit signed off, ${rangeLabel(h.from ?? 0, h.to ?? 0)}`, when: when(h.at, now) };
    case 'usedIn':
      return { what: `Used in land record ${h.recordNo ?? h.label ?? ''}, v${h.versionNumber}`, when: when(h.at, now) };
    default: {
      const done = h.version === 1 ? 'Filed' : 'Corrected';
      if (!h.documentId) {
        return { what: `Version ${h.version} ${done.toLowerCase()}`, when: when(h.at, now) };
      }
      const type = [typeLabel(h.docType), h.ref].filter(Boolean).join(' ');
      return { what: `Document ${h.edrmsNo ?? ''}${type ? ` · ${type}` : ''}, v${h.version}`, when: h.at ? `${done} ${inSentence(h.at, now)}` : '' };
    }
  }
}

/** One step of a batch's progress. */
export interface Step {
  title: string;
  when: string;
  note: string;
  state: 'done' | 'todo' | 'failed';
}

/** A batch's progress, from created to confirmed, or for a failed one to its replacement. */
export function batchSteps(d: BatchDetail, now = new Date()): Step[] {
  const s = d.steps;
  const sends = s.sends === 1 ? 'Sent once' : s.sends > 1 ? `Sent ${s.sends} times` : '';
  const from = d.prev?.batch ? `From batch ${count(d.prev.batch)}, the last on the blockchain` : 'The first batch';
  if (d.status === 'failed') {
    const reason = FAIL_REASON[d.reason ?? 'refused'];
    return [
      { title: 'Created', when: when(s.createdAt, now), note: from, state: 'done' },
      { title: 'Sent to the blockchain', when: when(s.sentAt, now), note: sends, state: s.sentAt ? 'done' : 'todo' },
      { title: reason.step, when: when(s.failedAt, now), note: reason.note, state: 'failed' },
      d.replacement
        ? { title: 'Replaced', when: when(d.replacement.createdAt, now), note: `By batch ${count(d.replacement.batch)}`, state: 'done' }
        : { title: 'Replaced', when: '', note: 'By the next batch, within minutes', state: 'todo' }
    ];
  }
  return [
    { title: 'Created', when: when(s.createdAt, now), note: d.covers === null ? '' : `${plural(d.covers, 'new fingerprint')} combined`, state: 'done' },
    { title: 'Sent to the blockchain', when: when(s.sentAt, now), note: sends, state: s.sentAt ? 'done' : 'todo' },
    { title: 'On the blockchain', when: when(s.onChainAt, now), note: d.block ? `In block ${count(d.block)}` : '', state: s.onChainAt ? 'done' : 'todo' },
    { title: 'Confirmed', when: when(s.confirmedAt, now), note: s.confirmedAt ? `${d.confirmationsNeeded} newer blocks on top` : depthText(d.confirmations, d.confirmationsNeeded), state: s.confirmedAt ? 'done' : 'todo' }
  ];
}

/** The line under a batch's heading: "Created today at 13:10 · confirmed at 13:16 · 52 new fingerprints". */
export function batchSummary(d: BatchDetail, now = new Date()): string {
  const parts = [`Created ${inSentence(d.steps.createdAt, now)}`];
  if (d.status === 'failed') {
    if (d.steps.failedAt) {
      parts.push(`given up ${inSentence(d.steps.failedAt, now)}`);
    }
    return parts.join(' · ');
  }
  if (d.steps.confirmedAt) {
    parts.push(`confirmed ${inSentence(d.steps.confirmedAt, now)}`);
  }
  if (d.covers !== null) {
    parts.push(plural(d.covers, 'new fingerprint'));
  }
  return parts.join(' · ');
}

/** A date and time in the middle of a sentence: "today at 13:10", or "on 10 Oct 2026, 13:10". */
export function inSentence(iso: string | null | undefined, now = new Date()): string {
  if (!iso) {
    return '';
  }
  const text = when(iso, now);
  return text.startsWith('Today ') ? `today at ${text.slice(6)}` : `on ${text}`;
}
