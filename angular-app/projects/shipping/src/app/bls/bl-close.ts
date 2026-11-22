/**
 * The two ways an electronic B/L is closed before its goods are released (CB-51, first version,
 * from the CB-8/CB-14 blueprint): the holder switches it to paper, and the paper B/L takes over;
 * the carrier voids it while the shipper still holds it. Each is confirmed first, and the page
 * then shows the end state to everyone party to the B/L. A blank-endorsed B/L becomes a bearer
 * document on paper, so its confirmation says so and confirms it. The record service checks
 * everything again; these only decide what the page offers and says. Tested by bl-close.test.ts
 * (`npm run test:shipping`).
 */

/** The names of the two title commands that close an electronic B/L. */
export type CloseName = 'switch-to-paper' | 'void';

/** A command the page offers, with what its button, confirmation and toast say. */
export interface CloseCommand {
  name: CloseName;
  /** The button on the page. */
  label: string;
  /** What the toast says once it is done. */
  done: string;
}

/** What a confirmation asks and says. */
export interface CloseConfirmation {
  title: string;
  body: string;
  confirmLabel: string;
}

/** The commands, in the order the page shows them. */
const CLOSE_COMMANDS: readonly CloseCommand[] = [
  {
    name: 'switch-to-paper',
    label: 'Switch to paper',
    done: 'B/L switched to paper',
  },
  {
    name: 'void',
    label: 'Void',
    done: 'B/L voided',
  },
];

/** What the switch to paper does, said in its confirmation. */
const SWITCH_BODY =
  'The electronic B/L is closed for good and the paper B/L takes over: nobody can endorse, surrender or change it here any more.';

/** What the switch of a blank-endorsed B/L adds: the paper becomes a bearer document. */
const BEARER_BODY =
  'It is endorsed in blank, so the paper B/L is a bearer document: whoever holds the paper holds the goods.';

/** What the void does, said in its confirmation. */
const VOID_BODY =
  'The B/L is cancelled for good: the shipper can no longer endorse or surrender it, and it cannot be issued again.';

/** What the page says about a closed B/L, by title state. */
const CLOSE_NOTES: ReadonlyMap<string, string> = new Map([
  [
    'switched-to-paper',
    'Switched to paper: the electronic B/L is closed and the paper B/L takes over. Nothing more can be done with it here.',
  ],
  [
    'void',
    'Void: the carrier cancelled this B/L. Nothing more can be done with it.',
  ],
]);

/**
 * The switch to paper and the void, of the commands the user may run now: the switch for the
 * holder, the void for the carrier while the shipper still holds the B/L. Each call gives a new
 * list.
 * @param allowed the title read's allowedCommands
 * @return the ones offered, in the page's order
 */
export function closeCommands(allowed: readonly string[]): CloseCommand[] {
  const offered: CloseCommand[] = [];
  for (const command of CLOSE_COMMANDS) {
    if (allowed.includes(command.name)) {
      offered.push({...command});
    }
  }
  return offered;
}

/**
 * Whether the switch to paper must confirm the bearer document: the B/L is endorsed in blank.
 * @param endorsement the title's endorsement, null before issue
 * @return true when it must
 */
export function needsBearerConfirmation(endorsement: string | null): boolean {
  return endorsement === 'blank';
}

/**
 * What a confirmation asks and says: what happens, and for a blank-endorsed B/L switched to
 * paper, that the paper is a bearer document.
 * @param name the command
 * @param label the B/L's label, '' when it is not known
 * @param endorsement the title's endorsement, null before issue
 * @return the confirmation
 */
export function closeConfirmation(
  name: CloseName,
  label: string,
  endorsement: string | null,
): CloseConfirmation {
  const bl = label === '' ? 'this B/L' : label;
  if (name === 'void') {
    return {
      title: `Void ${bl}?`,
      body: VOID_BODY,
      confirmLabel: 'Void the B/L',
    };
  }
  if (needsBearerConfirmation(endorsement)) {
    return {
      title: `Switch ${bl} to paper?`,
      body: `${SWITCH_BODY} ${BEARER_BODY}`,
      confirmLabel: 'Switch to a bearer paper B/L',
    };
  }
  return {
    title: `Switch ${bl} to paper?`,
    body: SWITCH_BODY,
    confirmLabel: 'Switch to paper',
  };
}

/**
 * The body of the command sent: the bearer confirmation for a blank-endorsed B/L switched to
 * paper, nothing else.
 * @param name the command
 * @param endorsement the title's endorsement, null before issue
 * @return the body, undefined when the command needs none
 */
export function closeRequest(
  name: CloseName,
  endorsement: string | null,
): {confirmBearer: true} | undefined {
  if (name === 'switch-to-paper' && needsBearerConfirmation(endorsement)) {
    return {confirmBearer: true};
  }
  return undefined;
}

/**
 * What the page says about a B/L switched to paper or voided, to everyone party to it.
 * @param state the title's state, null before issue
 * @return the text, '' for the other states
 */
export function closeNote(state: string | null): string {
  if (state === null) {
    return '';
  }
  return CLOSE_NOTES.get(state) ?? '';
}

/** Minimal shape of a title view needed to check printable paper B/L access (CB-86). */
export interface PaperPrintView {
  title: {state: string} | null;
  roles: readonly string[];
  chain: ReadonlyArray<{command: string; from: string | null}>;
}

/**
 * Whether the viewer can download or print a paper B/L PDF copy (CB-86): only once the B/L is
 * `switched-to-paper`, and only for the carrier or the holder that switched it to paper.
 * @param view the title view, null while loading
 * @param viewerOrganisationId the viewer's organisation id
 * @return true when the printable paper B/L copy should be offered
 */
export function canPrintPaper(
  view: PaperPrintView | null,
  viewerOrganisationId: string | null,
): boolean {
  if (
    view === null ||
    view.title === null ||
    view.title.state !== 'switched-to-paper' ||
    !viewerOrganisationId
  ) {
    return false;
  }
  if (view.roles.includes('carrier')) {
    return true;
  }
  let switchFrom: string | null = null;
  for (const entry of view.chain) {
    if (entry.command === 'switch-to-paper') {
      switchFrom = entry.from;
    }
  }
  return switchFrom === viewerOrganisationId;
}

/**
 * Builds the default PDF filename when saving the printable paper B/L copy (CB-86).
 * @param recordNo the transport document reference
 * @param issuedVersion the issued version number when known
 * @return sanitized filename ending in `.pdf`
 */
export function paperFilename(
  recordNo: string,
  issuedVersion?: number,
): string {
  const safeRef = String(recordNo || 'bl')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const versionTag =
    typeof issuedVersion === 'number' && Number.isFinite(issuedVersion)
      ? `-v${issuedVersion}`
      : '';
  return `bl-${safeRef || 'document'}${versionTag}-paper.pdf`;
}

/**
 * Explains the printable paper B/L copy on the B/L page, highlighting bearer risk when
 * endorsed in blank (CB-86).
 * @param endorsement the title's endorsement, null before issue
 * @return explanation text for the paper copy callout
 */
export function paperCopyNote(endorsement: string | null): string {
  if (endorsement === 'blank') {
    return 'Generate a printable PDF copy of this B/L for the paper originals. Because it was endorsed in blank, the paper B/L is a bearer document: whoever holds the paper holds the goods.';
  }
  return 'Generate a printable PDF copy of this B/L with its full particulars, cargo details, terms, and electronic chain of title.';
}
