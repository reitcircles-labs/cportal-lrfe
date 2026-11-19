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

/**
 * The page's own words for each refusal of the title engine and the record service (CB-54), by
 * its code: shown when the service gives no reason, or when its reason is meant for developers.
 * Every code the engine or the service can give has words here (bl-change.test.ts checks it).
 */
export const REFUSAL_REASONS: Readonly<Record<string, string>> = Object.freeze({
  // the title engine
  'unknown-command': 'This action is not offered for B/Ls.',
  'module-off': 'This kind of action is not enabled on this platform.',
  'not-issued': 'This B/L has not been issued yet: it can only be issued.',
  'already-issued': 'This B/L is already issued.',
  'no-organisation':
    'Your account is not linked to an organisation, so it cannot act on B/Ls. Ask your administrator.',
  'wrong-kind': 'This kind of B/L does not allow this action.',
  closed: 'Nothing more can be done with this B/L.',
  'wrong-state': 'This B/L no longer allows this action in its current state.',
  'not-carrier': 'Only the carrier that issued this B/L may do this.',
  'not-holder': 'Only the current holder of this B/L may do this.',
  'not-endorsed-in-blank':
    'This B/L is endorsed to a named organisation: it moves only by endorsement, not by transfer.',
  'unknown-kind': 'This kind of B/L is not known.',
  'missing-shipper':
    'A negotiable B/L needs its shipper, its first holder: name the shipper.',
  'missing-recipient': 'Pick the organisation that is to receive the B/L.',
  'same-holder': 'This B/L is already held by that organisation.',
  'invalid-argument':
    'Say whether the B/L is endorsed in blank or to the organisation picked.',
  'partial-release':
    'A B/L is released whole: to release part of its cargo, split it into new B/Ls first.',
  'too-few-children': 'A split needs at least two new B/Ls.',
  'too-many-children': 'Too many new B/Ls requested for a single split.',
  'bearer-unconfirmed':
    'Switching a blank-endorsed B/L to paper makes the paper a bearer document: confirm it to go on.',
  // the record service
  'not-committed':
    'This B/L has no approved version yet: it can be issued once a version is approved.',
  'in-review':
    'A new version of this B/L is waiting for approval: it can be issued once that is decided.',
  'unregistered-organisation':
    'That organisation is not registered or not active on this platform.',
  'organisations-unavailable':
    'The organisations cannot be checked now: try again later.',
  'changed-meanwhile': CHANGED_MEANWHILE,
  'not-set-up':
    'B/L actions are not available yet on this platform. Tell your administrator.',
  'draft-open':
    'A new version of this B/L is being drafted or waits for approval: finish or archive it first.',
  'draft-archived': 'This B/L is archived and can no longer be changed.',
  'cannot-archive':
    'Only a draft B/L that has not been approved or issued can be archived.',
  'missing-document': 'The new document of the B/L is missing.',
  'different-reference':
    'The new document must keep the carrier code and the reference of this B/L.',
  'kind-changed':
    'The new document must stay a negotiable B/L (a B/L to order).',
  'child-reference': 'Each new B/L needs its own reference.',
  'cargo-mismatch': "The cargo of the new B/Ls must add up to the B/L's.",
  'reference-taken': 'The carrier already has a B/L with that reference.',
  'duplicate-cargo':
    'These containers and seals are already on an issued B/L of this carrier.',
  'reading-unavailable':
    'Automatic reading is not configured on this server yet.',
  'own-draft':
    'You drafted or changed this version, so another person must approve it.',
  'not-author': 'Only the person who created this draft may edit it.',
  'proof-unavailable':
    'The proof on the blockchain cannot be read now: try again later.',
  'no-number': 'Give the number of the B/L to look for.',
  'unknown-port':
    'A port of the B/L is not a sea port of the port list: pick it from the list.',
});

/**
 * The refusals whose reason, as the service words it, is meant for developers: the page says
 * them in its own words.
 */
const OWN_WORDS: ReadonlySet<string> = new Set([
  'unknown-command',
  'unknown-kind',
  'no-organisation',
  'invalid-argument',
  'not-set-up',
  'own-draft',
]);

/** What the page says of a refusal it has no words for, when the service gives no reason. */
const REFUSED = 'This action could not be done. Nothing was changed.';

/** What the page says of a failure of the service it has no words for. */
const UNAVAILABLE =
  'This action could not be done now: try again later. Nothing was changed.';

/** The refusals after which the page reads the B/L again: it moved on since it was read. */
const RELOAD_CODES: ReadonlySet<string> = new Set([
  'changed-meanwhile',
  'already-issued',
  'wrong-state',
  'closed',
  'not-holder',
  'not-carrier',
  'draft-archived',
  'cannot-archive',
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
 * The reason a refusal gives, in plain words: the service's reason, which names the state, the
 * organisation or the reference (the service words its refusals for people); the page's own
 * words when the service gives none, or one meant for developers; a plain fallback for a
 * refusal the page has no words for.
 * @param code the refusal's code, '' when it has none
 * @param error the refusal
 * @return the reason
 */
function reasonOf(code: string, error: RefusalSource): string {
  const own = Object.hasOwn(REFUSAL_REASONS, code)
    ? REFUSAL_REASONS[code]
    : null;
  const given = error.message.trim();
  if (own !== null && (OWN_WORDS.has(code) || given === '')) {
    return own;
  }
  if (own === null && error.status >= 500) {
    return UNAVAILABLE;
  }
  if (given !== '') {
    return given;
  }
  return own ?? REFUSED;
}

/**
 * A refusal of the record service in plain words, with each problem it names; a B/L not found,
 * or one that moved on since it was read, is read again.
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
  return {
    message: reasonOf(code, error),
    problems,
    reload: RELOAD_CODES.has(code),
  };
}
