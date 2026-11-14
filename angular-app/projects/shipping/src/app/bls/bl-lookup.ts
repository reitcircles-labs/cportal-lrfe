/**
 * "Check a B/L by number" on the shipping app's home (CB-47): what is asked of the service for
 * what the user typed, and what the box does with the answer. The service finds the B/L only
 * among those the user's organisation is party to, so "not found" says the same whether the B/L
 * does not exist or belongs to others. Tested by bl-lookup.test.ts (`npm run test:shipping`).
 */
import type {BlListItem} from './bl.model';

/** The longest B/L number the box takes, as the service. */
export const MAX_NUMBER_LENGTH = 100;

/** What the box says when no B/L is found. */
export const LOOKUP_NOT_FOUND =
  'No B/L found with that number. It does not exist, or your organisation is not party to it.';

/** What the box does with the answer. */
export type LookupOutcome =
  | {kind: 'open'; id: string}
  | {kind: 'choose'; items: BlListItem[]}
  | {kind: 'not-found'};

/**
 * The number to ask for: what was typed without the spaces around it; null for a blank box or a
 * number too long to be one.
 * @param typed what the user typed
 * @return the number, or null
 */
export function numberQuery(typed: string): string | null {
  const number = typed.trim();
  if (number === '' || number.length > MAX_NUMBER_LENGTH) {
    return null;
  }
  return number;
}

/**
 * Why nothing is asked for what was typed.
 * @param typed what the user typed
 * @return the problem, or null when the number can be looked for
 */
export function numberProblem(typed: string): string | null {
  const number = typed.trim();
  if (number === '') {
    return 'Type the B/L number.';
  }
  if (number.length > MAX_NUMBER_LENGTH) {
    return `A B/L number has at most ${MAX_NUMBER_LENGTH} characters.`;
  }
  return null;
}

/**
 * What the box does with the B/Ls found: open the one, let the user pick when two carriers used
 * the number, or say not found.
 * @param items the B/Ls found
 * @return the outcome
 */
export function lookupOutcome(items: BlListItem[]): LookupOutcome {
  if (items.length === 0) {
    return {kind: 'not-found'};
  }
  if (items.length === 1) {
    return {kind: 'open', id: items[0].id};
  }
  return {kind: 'choose', items};
}
