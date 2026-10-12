/**
 * The words of the Anchoring health panel (API-674). Plain TypeScript without Angular, unit tested
 * (`npm run test:audit`). Neutral wording: the panel says "blockchain" and names no tool (no
 * provider, key service or node software).
 */

/** A warning the audit service reports. */
export type HealthWarning = 'walletUnreadable' | 'lowFunds' | 'unreachable' | 'catchingUp' | 'overdue' | 'trailGap';

/** The health report, as far as the words need it. */
export interface HealthFacts {
  wallet: { funds: { ada: string; minimumAda: number } | null };
  lastAnchoring: { createdAt: string } | null;
  gaps: { count: number };
}

/** A warning in words, and how serious it is. */
export interface WarningLine {
  text: string;
  tone: 'danger' | 'warn';
}

/** A date and time: "12 Oct 2026, 13:10". */
function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Each warning in words. */
export function warningLine(warning: HealthWarning, facts: HealthFacts): WarningLine {
  switch (warning) {
    case 'walletUnreadable':
      return { text: 'The anchoring wallet’s key can’t be read, so no new batch can be written. Check the key service the audit service signs with.', tone: 'danger' };
    case 'lowFunds': {
      const f = facts.wallet.funds;
      return { text: f ? `The anchoring wallet is low on funds: ${f.ada} left, at least ${f.minimumAda} needed. Top it up, or anchoring will stop.` : 'The anchoring wallet is low on funds. Top it up, or anchoring will stop.', tone: 'danger' };
    }
    case 'unreachable':
      return { text: 'The blockchain can’t be reached. New batches wait until it can be; nothing is lost meanwhile.', tone: 'danger' };
    case 'catchingUp':
      return { text: 'The blockchain connection is still catching up. Anchoring waits until it is in sync.', tone: 'warn' };
    case 'overdue':
      return { text: `Anchoring is overdue: fingerprints are waiting, and the last batch was made ${facts.lastAnchoring ? dateTime(facts.lastAnchoring.createdAt) : 'long ago'}.`, tone: 'danger' };
    case 'trailGap':
      return { text: `The trail has ${facts.gaps.count === 1 ? 'a recorded gap' : `${facts.gaps.count} recorded gaps`}: events were lost before they could be recorded. See Trail gaps below.`, tone: 'warn' };
  }
}

/** A broadcast warning that arrived while the audit service ran, in words. */
export function liveLine(live: { kind: 'lowFunds' | 'trailGap'; at: string; missing: number | null }): string {
  const when = dateTime(live.at);
  return live.kind === 'lowFunds'
    ? `${when}: the anchoring wallet reported low funds.`
    : `${when}: a gap was recorded in the trail${live.missing ? ` (${live.missing} event${live.missing === 1 ? '' : 's'} lost)` : ''}.`;
}

/** The (i) explanations of the panel. */
export const HEALTH_TIPS = {
  wallet: 'The wallet that pays for every batch written to the blockchain. Its address is published, so anyone checking a proof can see that the registry wrote the batch.',
  funds: 'Each batch costs a small fee, paid from the wallet. When the funds fall below the minimum, the wallet must be topped up, or anchoring stops.',
  chain: 'Whether the portal can reach the blockchain to write batches and follow them, and whether its connection is in step with the latest block.',
  last: 'The newest batch and how far it has got.',
  next: 'When the next batch is due, and how many fingerprints wait for it. Anchoring is overdue when fingerprints wait and the last batch is more than two periods old.',
  gaps: 'Events the audit service lost before it could record them. Each gap is recorded in the trail itself, so the trail is never passed off as complete.',
  live: 'Warnings sent while the audit service runs: low funds, and gaps found in the trail. This page checks for new ones every 30 seconds while it is open.'
} as const;
