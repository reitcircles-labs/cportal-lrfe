/**
 * The endorsement of a B/L to a named organisation on its page (CB-45, from the CB-12 design,
 * good weather): the holder picks a registered organisation, confirms, and that organisation
 * becomes the holder at once. The record service checks everything again (the holder only, an
 * active organisation, never the holder itself); these only decide what the page offers and says.
 * Tested by bl-endorse.test.ts (`npm run test:shipping`).
 */
import type {PartyOrganisation} from './bl.model';

/** The title command of an endorsement. */
const ENDORSE_COMMAND = 'endorse';

/** Who may not be picked: the user's own organisation and the B/L's current holder. */
export interface EndorseeExclusions {
  self: string | null;
  holder: string | null;
}

/** The arguments of a named endorsement, as the title API takes them. */
export interface EndorseRequest {
  to: string;
  inBlank: false;
}

/**
 * Whether the page offers the endorsement: the title read lists it among the commands the user
 * may run now (the holder's organisation, with the permission to endorse).
 * @param allowed the title read's allowedCommands
 * @return true when it is offered
 */
export function mayEndorse(allowed: readonly string[]): boolean {
  return allowed.includes(ENDORSE_COMMAND);
}

/**
 * The organisations the holder may endorse the B/L to: every one listed but its own and the
 * current holder, sorted by name. The list given is not changed.
 * @param organisations the organisations registered and active
 * @param exclude the user's organisation and the current holder
 * @return the choices
 */
export function endorseeChoices(
  organisations: readonly PartyOrganisation[],
  exclude: EndorseeExclusions,
): PartyOrganisation[] {
  const choices = organisations.filter(
    o => o.id !== exclude.self && o.id !== exclude.holder,
  );
  return choices.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the confirmation says happens when the B/L is endorsed.
 * @param name the name of the organisation picked
 * @return the sentence
 */
export function endorseConfirmation(name: string): string {
  const who = name === '' ? 'The organisation' : name;
  return `${who} becomes the holder; you can no longer act on this B/L.`;
}

/**
 * The arguments sent for an endorsement to the organisation picked: by name, never in blank.
 * @param to the organisation's id
 * @return the arguments
 */
export function endorseRequest(to: string): EndorseRequest {
  return {to, inBlank: false};
}

/**
 * What the panel announces as it changes (read out, review of CB-45): that the organisations are
 * loading, that there is nobody to pick, or what happens once one is picked.
 * @param choices the organisations the holder may pick, null while they load
 * @param picked the name of the organisation picked, '' for none
 * @return the text, '' for nothing to announce
 */
export function endorseStatus(
  choices: readonly PartyOrganisation[] | null,
  picked: string,
): string {
  if (choices === null) {
    return 'Loading the organisations…';
  }
  if (choices.length === 0) {
    return 'No other organisation is registered on the platform yet.';
  }
  if (picked === '') {
    return '';
  }
  return endorseConfirmation(picked);
}
