/**
 * The endorsement of a B/L to a named organisation on its page (CB-45, from the CB-12 design,
 * good weather): the holder picks a registered organisation, confirms, and that organisation
 * becomes the holder at once. The record service checks everything again (the holder only, an
 * active organisation, never the holder itself); these only decide what the page offers and says.
 *
 * The endorsement in blank and the transfer (CB-52, first version, from the CB-12 design and the
 * title engine): the holder may endorse in blank instead of by name, still handing the B/L to an
 * organisation it picks; the holder of a blank-endorsed B/L may then transfer it on to another
 * organisation without endorsing it.
 * Tested by bl-endorse.test.ts (`npm run test:shipping`).
 */
import type {PartyOrganisation} from './bl.model';

/** The title command of an endorsement. */
const ENDORSE_COMMAND = 'endorse';

/** The title command of a transfer of a blank-endorsed B/L (CB-52). */
const TRANSFER_COMMAND = 'transfer';

/** How the holder endorses: to the organisation by name, or in blank (CB-52). */
export type EndorseMode = 'named' | 'blank';

/** What the panel does: endorse the B/L, or transfer a blank-endorsed one (CB-52). */
export type HandOver = 'endorse' | 'transfer';

/** What a blank endorsement means, said in its confirmation (CB-52). */
const BLANK_MEANING =
  'Endorsing in blank means the B/L no longer names a holder by endorsement: whoever it is then transferred to becomes its holder.';

/** What the page says of a B/L's endorsement, by the title's endorsement (CB-52). */
const ENDORSEMENT_LABELS: ReadonlyMap<string, string> = new Map([
  ['none', 'Not endorsed yet'],
  ['named', 'Endorsed to a named organisation'],
  ['blank', 'Endorsed in blank'],
]);

/** Who may not be picked: the user's own organisation and the B/L's current holder. */
export interface EndorseeExclusions {
  self: string | null;
  holder: string | null;
}

/** The arguments of an endorsement, as the title API takes them. */
export interface EndorseRequest {
  to: string;
  inBlank: boolean;
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
 * Whether the page offers the transfer: the title read lists it among the commands the user may
 * run now, which it does only for the holder of a blank-endorsed B/L (CB-52).
 * @param allowed the title read's allowedCommands
 * @return true when it is offered
 */
export function mayTransfer(allowed: readonly string[]): boolean {
  return allowed.includes(TRANSFER_COMMAND);
}

/**
 * What the confirmation says happens when the B/L is endorsed or transferred: the organisation
 * becomes the holder and, for an endorsement in blank, what that means.
 * @param name the name of the organisation picked
 * @param mode by name or in blank; a transfer says the same as by name
 * @return the sentence
 */
export function endorseConfirmation(
  name: string,
  mode: EndorseMode = 'named',
): string {
  let who = name;
  if (name === '') {
    who = 'The organisation';
  }
  const becomes = `${who} becomes the holder; you can no longer act on this B/L.`;
  if (mode === 'blank') {
    return `${becomes} ${BLANK_MEANING}`;
  }
  return becomes;
}

/**
 * The arguments sent for an endorsement to the organisation picked, by name or in blank.
 * @param to the organisation's id
 * @param mode by name or in blank
 * @return the arguments
 */
export function endorseRequest(
  to: string,
  mode: EndorseMode = 'named',
): EndorseRequest {
  return {to, inBlank: mode === 'blank'};
}

/**
 * What the page says of a B/L's endorsement (CB-52).
 * @param endorsement the title's endorsement, null before issue
 * @return the words, '' before issue or for an endorsement it does not know
 */
export function endorsementLabel(endorsement: string | null): string {
  if (endorsement === null) {
    return '';
  }
  return ENDORSEMENT_LABELS.get(endorsement) ?? '';
}

/**
 * The confirmation's title and button, and the toast once done, of an endorsement or a
 * transfer to the organisation picked (CB-52).
 * @param action endorse or transfer
 * @param mode by name or in blank, for an endorsement
 * @param label the B/L's label
 * @param name the name of the organisation picked
 * @return the words
 */
export function handOverWords(
  action: HandOver,
  mode: EndorseMode,
  label: string,
  name: string,
): {title: string; confirmLabel: string; done: string} {
  if (action === 'transfer') {
    return {
      title: `Transfer ${label} to ${name}?`,
      confirmLabel: 'Transfer',
      done: `B/L transferred to ${name}`,
    };
  }
  if (mode === 'blank') {
    return {
      title: `Endorse ${label} in blank and hand it to ${name}?`,
      confirmLabel: 'Endorse in blank',
      done: `B/L endorsed in blank to ${name}`,
    };
  }
  return {
    title: `Endorse ${label} to ${name}?`,
    confirmLabel: 'Endorse',
    done: `B/L endorsed to ${name}`,
  };
}

/**
 * What the panel announces as it changes (read out, review of CB-45): that the organisations are
 * loading, that there is nobody to pick, or what happens once one is picked.
 * @param choices the organisations the holder may pick, null while they load
 * @param picked the name of the organisation picked, '' for none
 * @param mode by name or in blank (CB-52)
 * @return the text, '' for nothing to announce
 */
export function endorseStatus(
  choices: readonly PartyOrganisation[] | null,
  picked: string,
  mode: EndorseMode = 'named',
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
  return endorseConfirmation(picked, mode);
}
