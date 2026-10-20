/**
 * The words for checking an item against the blockchain now (API-675; POST /audit/verify). Plain
 * TypeScript without Angular, unit tested with the other audit wording (`npm run test:audit`). The
 * service's reasons are internal (they can name tools), so each check's result is put into one of
 * a few plain reasons here, and the raw text is never shown.
 */

/** One check as the audit service reports it. */
export interface VerifyCheck {
  ok: boolean | null;
  problem?: string;
}

/** The result of POST /audit/verify, as far as the screens use it. */
export interface VerifyResult {
  valid: boolean;
  status: 'waiting' | 'anchored' | 'confirmed' | string;
  checks: {
    item: VerifyCheck | null;
    path: VerifyCheck | null;
    chain: VerifyCheck | null;
  };
  explorerUrl: string | null;
  proof: {
    anchor: {tx: string; status?: 'submitted' | 'onChain' | 'confirmed'} | null;
  };
}

/** One line of the result: the check, its outcome and, when it did not pass, why. */
export interface CheckLine {
  label: string;
  outcome: 'passed' | 'failed' | 'unknown';
  text: string;
}

/** The three checks, in order, as the screen names them. */
const LABELS = {
  item: 'Fingerprint recomputed from the file and its metadata',
  path: 'Fingerprint is in the batch',
  chain: 'Batch is in the blockchain transaction',
} as const;

const TRY_AGAIN = 'It couldn’t be checked now. Try again in a minute.';

/** Plain reasons for the service's problems, matched on a part of its text; the first match wins. */
const REASONS: Array<{
  check: keyof typeof LABELS;
  match: RegExp;
  text: string;
}> = [
  {
    check: 'item',
    match: /no longer exists/,
    text: 'This version no longer exists.',
  },
  {
    check: 'item',
    match: /no longer matches its seal/,
    text: 'The file or its metadata changed after it was sealed.',
  },
  {
    check: 'item',
    match: /differs from the one in the tree/,
    text: 'The fingerprint differs from the one put on the blockchain.',
  },
  {
    check: 'item',
    match:
      /changed after it was recorded|does not reach the anchored checkpoint/,
    text: 'The entry changed after it was recorded.',
  },
  {
    check: 'chain',
    match: /no anchoring metadata/,
    text: 'The transaction doesn’t carry this batch.',
  },
  {
    check: 'chain',
    match: /not on (the )?chain/,
    text: 'The transaction is not on the blockchain.',
  },
  {
    check: 'chain',
    match: /root in the transaction is not/,
    text: 'The transaction carries a different combined fingerprint.',
  },
  {
    check: 'chain',
    match: /not signed by the anchoring wallet/,
    text: 'The transaction doesn’t carry this batch, or was not written by the registry’s anchoring wallet.',
  },
];

/** The batch was sent a moment ago: not in a block yet, which is normal, not a mismatch. */
const JUST_SENT =
  'The batch was just sent and is not in a block on the blockchain yet. Try again in a few minutes.';

/** Why a check did not pass, in plain words. */
function reasonOf(check: keyof typeof LABELS, result: VerifyCheck): string {
  if (result.ok === null) {
    return TRY_AGAIN;
  }
  if (check === 'path') {
    return 'The fingerprint is not part of the batch’s combined fingerprint.';
  }
  const found = REASONS.find(
    r => r.check === check && r.match.test(result.problem ?? ''),
  );
  return found ? found.text : 'It doesn’t match the blockchain.';
}

/**
 * Each check's line. While the item waits for the next batch, only its fingerprint is checked: it
 * is in no batch yet, so the other two are left out.
 */
export function checkLines(result: VerifyResult): CheckLine[] {
  const shown: Array<keyof typeof LABELS> =
    result.status === 'waiting' ? ['item'] : ['item', 'path', 'chain'];
  return shown
    .filter(check => result.checks[check])
    .map(check => {
      const c = result.checks[check]!;
      if (c.ok === true) {
        return {label: LABELS[check], outcome: 'passed', text: 'Matches'};
      }
      if (check === 'chain' && result.proof.anchor?.status === 'submitted') {
        return {label: LABELS[check], outcome: 'unknown', text: JUST_SENT};
      }
      return {
        label: LABELS[check],
        outcome: c.ok === false ? 'failed' : 'unknown',
        text: reasonOf(check, c),
      };
    });
}

/** The result in one line, and its tone. */
export function verifySummary(result: VerifyResult): {
  text: string;
  tone: 'success' | 'danger' | 'neutral' | 'warn';
} {
  if (result.valid) {
    return {text: 'Matches the blockchain ✓', tone: 'success'};
  }
  if (checkLines(result).some(l => l.outcome === 'failed')) {
    return {
      text:
        result.status === 'waiting'
          ? 'Doesn’t match its seal ✕'
          : 'Doesn’t match the blockchain ✕',
      tone: 'danger',
    };
  }
  if (result.status === 'waiting') {
    return {
      text: 'Waiting for next batch: this version can be checked against the blockchain once it is there.',
      tone: 'neutral',
    };
  }
  return {
    text: 'Couldn’t check against the blockchain now. Try again in a minute.',
    tone: 'warn',
  };
}

/** The (i) explanations of the two checks on a document, so it is clear which checks what. */
export const VERIFY_TIPS = {
  integrity:
    'Checks the stored file and its metadata against the fingerprint they were sealed with in the portal. It shows whether anything changed since filing.',
  blockchain:
    'Checks this version against the blockchain: its fingerprint is recomputed from the file and its metadata, found in its batch, and the batch found in the blockchain transaction. Nobody, not even the registry, can change what is on the blockchain.',
} as const;
