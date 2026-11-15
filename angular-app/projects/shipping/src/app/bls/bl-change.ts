/**
 * The change of a B/L on its page (CB-50, first version, from the CB-14 design): the holder asks
 * the carrier for a change (the title engine's surrender for amendment), the carrier holds the B/L
 * until it amends or splits it, and the page says so; an amended B/L shows its versions to those
 * who hold it, while earlier holders are told only that it was amended or split after they held
 * it, never the new values. The refusals of the record service are said in plain words. What
 * the page says while the carrier holds the B/L, and the versions, are in bl-format.ts, with the
 * names of the organisations. The record service checks everything again; these only decide what
 * the page offers and says. Tested by bl-change.test.ts (`npm run test:shipping`).
 */
import type {
  BlLink,
  ChainEntry,
  PartyRole,
  TitleSummary,
  Viewer,
} from './bl.model';

/** The title commands of a change: the holder's request, the carrier's amendment and split. */
const ASK_COMMAND = 'surrender-for-amendment';
const AMEND_COMMAND = 'amend';
const SPLIT_COMMAND = 'split';

/** What a request for a change says: its button, confirmation and toast (CB-14 wording). */
export interface ChangeRequestWording {
  label: string;
  body: string;
  confirmLabel: string;
  done: string;
}

/** The holder's request for a change. */
export const ASK_FOR_CHANGE: Readonly<ChangeRequestWording> = Object.freeze({
  label: 'Ask for a change',
  body: 'The carrier will hold the B/L to change it and give it back to you. You cannot endorse or surrender it until then.',
  confirmLabel: 'Send to the carrier',
  done: 'B/L sent to the carrier for a change',
});

/** What the page says of a B/L it does not find. */
const NOT_FOUND =
  'B/L not found. It does not exist, or your organisation is not party to it.';

/** What the page says when the B/L changed since it was read. */
const CHANGED_MEANWHILE =
  'This B/L changed meanwhile. The page now shows it as it is.';

/** The refusals after which the page reads the B/L again: it moved on since it was read. */
const RELOAD_CODES: ReadonlySet<string> = new Set([
  'changed-meanwhile',
  'wrong-state',
  'closed',
  'not-holder',
  'not-carrier',
]);

/** What an earlier holder is told of a change after it held the B/L. */
export interface PastHolderNote {
  message: string;
  at: string;
}

/** A refusal of the record service as the page shows it. */
export interface Refusal {
  message: string;
  /** Each problem the refusal names, one line each. */
  problems: string[];
  /** Whether the page reads the B/L again: it moved on since it was read. */
  reload: boolean;
}

/** A refusal as the API client gives it. */
export interface RefusalSource {
  status: number;
  message: string;
  details?: unknown;
}

/**
 * Whether the page offers the holder "Ask for a change": the title read lists it.
 * @param allowed the title read's allowedCommands
 * @return true when it is offered
 */
export function mayAskForChange(allowed: readonly string[]): boolean {
  return allowed.includes(ASK_COMMAND);
}

/**
 * Whether the page offers the carrier "Amend": the title read lists it.
 * @param allowed the title read's allowedCommands
 * @return true when it is offered
 */
export function mayAmend(allowed: readonly string[]): boolean {
  return allowed.includes(AMEND_COMMAND);
}

/**
 * Whether the page offers the carrier "Split": the title read lists it.
 * @param allowed the title read's allowedCommands
 * @return true when it is offered
 */
export function maySplit(allowed: readonly string[]): boolean {
  return allowed.includes(SPLIT_COMMAND);
}

/**
 * The question the holder's confirmation asks.
 * @param label the B/L's label, '' when it is not known
 * @return the question
 */
export function askForChangeQuestion(label: string): string {
  const bl = label === '' ? 'this B/L' : label;
  return `Ask the carrier to change or split ${bl}?`;
}

/**
 * Whether the page shows the B/L's versions: to its carrier, its holder and, while the carrier
 * holds it for a change, the one it goes back to; never to earlier holders.
 * @param roles the viewer's organisation's roles on the B/L
 * @param title the title, null before issue
 * @param viewer who looks at the B/L
 * @return true when they are shown
 */
export function seesVersions(
  roles: readonly PartyRole[],
  title: TitleSummary | null,
  viewer: Viewer,
): boolean {
  if (title === null) {
    return false;
  }
  if (roles.includes('carrier') || roles.includes('holder')) {
    return true;
  }
  return !!viewer.organisationId && title.returnTo === viewer.organisationId;
}

/**
 * What an earlier holder is told when the B/L was amended or split after it last handed it on:
 * that it was, and when; never what changed.
 * @param chain the chain-of-title entries
 * @param roles the viewer's organisation's roles on the B/L
 * @param viewer who looks at the B/L
 * @param splitInto the B/Ls it was split into
 * @return the note, null for anyone else or when nothing changed since
 */
export function pastHolderNote(
  chain: readonly ChainEntry[],
  roles: readonly PartyRole[],
  viewer: Viewer,
  splitInto: readonly BlLink[],
): PastHolderNote | null {
  const org = viewer.organisationId;
  const current = roles.includes('holder') || roles.includes('carrier');
  if (!org || current || !roles.includes('past-holder')) {
    return null;
  }
  const ordered = [...chain].sort((a, b) => a.seq - b.seq);
  let left = 0;
  for (const entry of ordered) {
    if (entry.from === org) {
      left = entry.seq;
    }
  }
  const after = ordered.filter(entry => entry.seq > left);
  const split = after.find(entry => entry.command === SPLIT_COMMAND);
  if (split !== undefined) {
    const numbers = splitInto.map(link => link.recordNo).join(', ');
    const into = numbers === '' ? 'new B/Ls' : numbers;
    return {message: `Split into ${into} after you held it`, at: split.at};
  }
  const amendments = after.filter(entry => entry.command === AMEND_COMMAND);
  const latest = amendments.at(-1);
  if (latest === undefined) {
    return null;
  }
  return {message: 'Amended after you held it', at: latest.at};
}

/**
 * The problems a refusal names (`details.problems`): text as it is, a document's problem with
 * its place in the document.
 * @param details the refusal's details
 * @return one line per problem
 */
function problemsOf(details: unknown): string[] {
  if (details === null || typeof details !== 'object') {
    return [];
  }
  const problems = (details as {problems?: unknown}).problems;
  if (!Array.isArray(problems)) {
    return [];
  }
  const lines: string[] = [];
  for (const problem of problems as unknown[]) {
    if (typeof problem === 'string') {
      lines.push(problem);
      continue;
    }
    const {path, message} = (problem ?? {}) as {
      path?: unknown;
      message?: unknown;
    };
    const where = typeof path === 'string' ? path : '';
    const what = typeof message === 'string' ? message : '';
    lines.push(where === '' ? what : `${where}: ${what}`);
  }
  return lines;
}

/**
 * The code of a refusal (`details.code`), '' when it has none.
 * @param details the refusal's details
 * @return the code
 */
function codeOf(details: unknown): string {
  if (details === null || typeof details !== 'object') {
    return '';
  }
  const code = (details as {code?: unknown}).code;
  return typeof code === 'string' ? code : '';
}

/**
 * A refusal of the record service in plain words: the reason it gives (the record service words
 * each refusal for people), with each problem it names; a B/L not found, or one that moved on
 * since it was read, is read again.
 * @param error the refusal
 * @return what the page shows
 */
export function refusalOf(error: RefusalSource): Refusal {
  const problems = problemsOf(error.details);
  if (error.status === 404) {
    return {message: NOT_FOUND, problems, reload: true};
  }
  const code = codeOf(error.details);
  if (code === 'changed-meanwhile') {
    return {message: CHANGED_MEANWHILE, problems, reload: true};
  }
  return {message: error.message, problems, reload: RELOAD_CODES.has(code)};
}
