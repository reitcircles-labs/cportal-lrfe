/**
 * The surrender and the release on a B/L's page (CB-46, from the CB-13 design, good weather):
 * the holder surrenders the B/L to the carrier, which then holds it; the carrier releases the
 * goods, and the B/L is accomplished, with no holder. Each is confirmed before it is done. The
 * record service checks each again (the holder only, the carrier only, a surrendered B/L only);
 * these only decide what the page offers and says. Tested by bl-surrender.test.ts
 * (`npm run test:shipping`).
 */

/** The names of the two title commands that end a B/L's journey. */
export type SettlementName = 'surrender' | 'release';

/** A command the page offers, with what its button, confirmation and toast say. */
export interface SettlementCommand {
  name: SettlementName;
  /** The button on the page. */
  label: string;
  /** What the confirmation says happens. */
  body: string;
  /** The confirmation's button. */
  confirmLabel: string;
  /** What the toast says once it is done. */
  done: string;
}

/** The commands, in the order the page shows them. */
const SETTLEMENT_COMMANDS: readonly SettlementCommand[] = [
  {
    name: 'surrender',
    label: 'Surrender to the carrier',
    body: 'The carrier will hold the B/L to release the goods; you can no longer endorse it.',
    confirmLabel: 'Surrender',
    done: 'B/L surrendered to the carrier',
  },
  {
    name: 'release',
    label: 'Release the goods',
    body: 'The B/L becomes accomplished: nobody holds it any more and its chain of title is complete.',
    confirmLabel: 'Release',
    done: 'Goods released: the B/L is accomplished',
  },
];

/** What the page says about a B/L at the end of its journey, by title state. */
const TITLE_NOTES: ReadonlyMap<string, string> = new Map([
  [
    'surrendered',
    'Surrendered: the carrier holds the B/L to release the goods.',
  ],
  [
    'accomplished',
    'Accomplished: the goods are released, nobody holds the B/L any more and its chain of title is complete.',
  ],
]);

/**
 * The surrender and the release, of the commands the user may run now: the surrender for the
 * holder, the release for the carrier of a surrendered B/L. Each call gives a new list.
 * @param allowed the title read's allowedCommands
 * @return the ones offered, in the page's order
 */
export function settlementCommands(
  allowed: readonly string[],
): SettlementCommand[] {
  const offered: SettlementCommand[] = [];
  for (const command of SETTLEMENT_COMMANDS) {
    if (allowed.includes(command.name)) {
      offered.push({...command});
    }
  }
  return offered;
}

/**
 * The question a confirmation asks.
 * @param name the command
 * @param label the B/L's label, '' when it is not known
 * @return the question
 */
export function settlementQuestion(
  name: SettlementName,
  label: string,
): string {
  const bl = label === '' ? 'this B/L' : label;
  if (name === 'surrender') {
    return `Surrender ${bl} to the carrier?`;
  }
  return `Release the goods of ${bl}?`;
}

/**
 * What the page says about where a B/L stands once it is surrendered or accomplished.
 * @param state the title's state, null before issue
 * @return the text, '' for the other states
 */
export function titleNote(state: string | null): string {
  if (state === null) {
    return '';
  }
  return TITLE_NOTES.get(state) ?? '';
}
