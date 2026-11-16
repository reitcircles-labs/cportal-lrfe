/**
 * The full chain of title of a B/L for auditors and disputes (CB-53, first version from the CB-16
 * design): every step of its proof file, the steps of the B/L it was split from first, each with
 * what happened (exceptions marked), who and when, its signature as checked in the browser, and how
 * it stands on the blockchain: the latest step is recorded there, and every earlier step is linked
 * to it by the hash each step carries of the one before.
 */

import type {ProofStatus, SignedEntry, StepResult} from './bl-check';
import type {ChainRow, OrganisationNames} from './bl-format';

/** One step of the full chain of title. */
export interface HistoryRow {
  /** A key unique on the page: the B/L's part and the step's number. */
  key: string;
  seq: number;
  /** "this" for the B/L itself, "parent" for the B/L it was split from. */
  part: 'this' | 'parent';
  step: string;
  /** An exception to the plain journey (amendment, split, switch to paper, void, blank, transfer). */
  exception: boolean;
  from: string;
  to: string;
  /** The person and their organisation. */
  by: string;
  at: string;
  signature: string;
  check: StepResult['check'];
  /** How the step stands on the blockchain. */
  blockchain: string;
}

/** The commands that are exceptions to a B/L's plain journey (CB-40). */
const EXCEPTION_COMMANDS: ReadonlySet<string> = new Set([
  'surrender-for-amendment',
  'amend',
  'split',
  'issue-from-split',
  'switch-to-paper',
  'void',
  'transfer',
]);

/**
 * Whether a step is an exception to the plain journey: an amendment, a split, a switch to paper, a
 * void, a transfer or a blank endorsement.
 * @param entry the step
 * @return true for an exception
 */
export function isException(entry: SignedEntry): boolean {
  return (
    EXCEPTION_COMMANDS.has(entry.command) ||
    (entry.command === 'endorse' && entry.endorsement === 'blank')
  );
}

/**
 * How the latest step stands on the blockchain, in the table's words.
 * @param status the proof's blockchain status
 * @param date formats a date for people
 * @return the words
 */
function latestWords(
  status: ProofStatus,
  date: (at: string) => string,
): string {
  if (status.state === 'confirmed') {
    return status.at
      ? `On the blockchain, confirmed ${date(status.at)}`
      : 'On the blockchain, confirmed';
  }
  if (status.state === 'recorded') {
    return 'Written to the blockchain, waiting for confirmation';
  }
  return 'Pending: not on the blockchain yet';
}

/** A part of the chain: the B/L's own steps, or those of the B/L it was split from. */
export interface HistoryPart {
  part: HistoryRow['part'];
  entries: readonly SignedEntry[];
  /** The steps as the B/L's page words them (chainRows). */
  words: readonly ChainRow[];
  /** The browser's checks of the steps. */
  results: readonly StepResult[];
}

/**
 * The full chain of title: the steps of the B/L it was split from, then its own, oldest first.
 * A step is covered by the latest step's record on the blockchain when no signature from it to
 * the latest fails: a step that fails breaks the link for every step before it.
 * @param parts the parent's steps (none for a B/L of its own), then the B/L's
 * @param status the latest step's standing on the blockchain
 * @param context the organisations' names, how dates and signature checks read
 * @return one row per step
 */
export function historyRows(
  parts: readonly HistoryPart[],
  status: ProofStatus,
  context: {
    names: OrganisationNames;
    date: (at: string) => string;
    signature: (check: StepResult['check']) => string;
  },
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const {part, entries, words, results} of parts) {
    const bySeq = new Map(entries.map(entry => [entry.seq, entry]));
    const checkBySeq = new Map(results.map(result => [result.seq, result]));
    for (const row of words) {
      const entry = bySeq.get(row.seq);
      if (entry === undefined) {
        continue;
      }
      const check = checkBySeq.get(row.seq)?.check ?? 'unchecked';
      const org = entry.actor.org ? context.names[entry.actor.org] : undefined;
      rows.push({
        key: `${part}-${row.seq}`,
        seq: row.seq,
        part,
        step: row.step,
        exception: isException(entry),
        from: row.from,
        to: row.to,
        by: org ? `${row.by}, ${org}` : row.by,
        at: row.at,
        signature: context.signature(check),
        check,
        blockchain: '',
      });
    }
  }
  // from the latest step back: covered until a signature fails
  let broken: HistoryRow | null = null;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (index === rows.length - 1) {
      row.blockchain =
        row.check === 'failed'
          ? 'Not proven: its signature does not match'
          : latestWords(status, context.date);
    } else if (broken !== null) {
      row.blockchain = `Not proven: the link breaks at step ${broken.seq}`;
    } else {
      row.blockchain =
        status.state === 'pending'
          ? 'Linked to the latest step, which is not on the blockchain yet'
          : 'Linked to the latest step on the blockchain';
    }
    if (row.check === 'failed' && broken === null) {
      broken = row;
    }
  }
  return rows;
}

/**
 * The sentence above the table.
 * @param rows the rows
 * @param status the latest step's standing on the blockchain
 * @return the words
 */
export function historySummary(
  rows: readonly HistoryRow[],
  status: ProofStatus,
): string {
  if (rows.length === 0) {
    return 'This B/L has no steps yet: it is not issued.';
  }
  const failed = rows.filter(row => row.check === 'failed').length;
  if (failed > 0) {
    return `${failed} of ${rows.length} steps do not match the platform's signature: this chain of title cannot be trusted.`;
  }
  if (rows.some(row => row.check === 'unchecked')) {
    return 'This browser cannot check signatures (the page is not served securely): use the offline check.';
  }
  const chain =
    status.state === 'pending'
      ? 'The latest step is not on the blockchain yet: check again in a few minutes.'
      : 'The latest step is on the blockchain, and every earlier step is linked to it.';
  return `All ${rows.length} steps carry the platform's signature, checked in your browser. ${chain}`;
}
