/**
 * How the shipping app shows a B/L (CB-42): its kind, its state, the organisation's roles on it,
 * the organisations it names and its chain of title. Product wording, generic: no country, no
 * organisation, no tool name. Tested by bl-format.test.ts (`npm run test:shipping`).
 */
import type {BlState, ChainEntry, PartyRole, Viewer} from './bl.model';

/** How a state is shown at a glance: being drafted, waiting, live, or ended. */
export type StateTone = 'draft' | 'review' | 'live' | 'ended';

/** A row of the chain of title on a B/L's page. */
export interface ChainRow {
  seq: number;
  step: string;
  from: string;
  to: string;
  by: string;
  at: string;
}

/** What stands for nobody or nothing. */
const NONE = '—';

const ROLE_NAMES: ReadonlyMap<PartyRole, string> = new Map([
  ['carrier', 'carrier'],
  ['holder', 'holder'],
  ['past-holder', 'past holder'],
  ['consignee', 'consignee'],
]);

const KIND_NAMES: ReadonlyMap<string, string> = new Map([
  ['negotiable', 'Negotiable B/L'],
  ['straight', 'Straight B/L'],
  ['waybill', 'Sea waybill'],
]);

/** The title states, each with its name and whether the B/L's life is over. */
const STATE_NAMES: ReadonlyMap<string, {label: string; ended: boolean}> =
  new Map([
    ['issued', {label: 'Issued', ended: false}],
    ['with-holder', {label: 'With holder', ended: false}],
    ['surrendered', {label: 'Surrendered', ended: false}],
    ['amendment-requested', {label: 'Amendment requested', ended: false}],
    ['accomplished', {label: 'Accomplished', ended: true}],
    ['delivered', {label: 'Delivered', ended: true}],
    ['void', {label: 'Void', ended: true}],
    ['split', {label: 'Split', ended: true}],
    ['switched-to-paper', {label: 'Switched to paper', ended: true}],
  ]);

/** Each step of a chain of title, as done. */
const STEP_NAMES: ReadonlyMap<string, string> = new Map([
  ['issue', 'Issued'],
  ['issue-from-split', 'Issued from a split'],
  ['endorse', 'Endorsed'],
  ['transfer', 'Transferred'],
  ['surrender', 'Surrendered'],
  ['release', 'Released'],
  ['deliver', 'Delivered'],
  ['void', 'Voided'],
  ['surrender-for-amendment', 'Surrendered for amendment'],
  ['amend', 'Amended'],
  ['split', 'Split'],
  ['switch-to-paper', 'Switched to paper'],
]);

/**
 * The organisation's roles on a B/L, e.g. "Carrier, holder".
 * @param roles the roles, as the service gives them
 * @return the words, the first capitalised; empty for none
 */
export function rolesLabel(roles: readonly PartyRole[]): string {
  const words = roles.map(role => ROLE_NAMES.get(role) ?? role).join(', ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The kind of a B/L; a B/L not issued yet has none (it is fixed at issue).
 * @param kind the title's kind, if any
 * @return its name
 */
export function kindLabel(kind: string | null | undefined): string {
  if (!kind) {
    return 'Not issued yet';
  }
  return KIND_NAMES.get(kind) ?? kind;
}

/**
 * Where a B/L stands: before issue its drafting (draft, in review, ready to issue), after it the
 * state of its title.
 * @param bl the B/L
 * @return the state's name
 */
export function stateLabel(bl: BlState): string {
  if (bl.title) {
    return STATE_NAMES.get(bl.title.state)?.label ?? bl.title.state;
  }
  if (bl.draftState === 'in_review') {
    return 'In review';
  }
  if (bl.status === 'draft') {
    return 'Draft';
  }
  return 'Ready to issue';
}

/**
 * How a B/L's state is shown at a glance (the dot of the list, the tag of the page).
 * @param bl the B/L
 * @return its tone
 */
export function stateTone(bl: BlState): StateTone {
  if (bl.title) {
    const ended = STATE_NAMES.get(bl.title.state)?.ended ?? false;
    return ended ? 'ended' : 'live';
  }
  if (bl.status === 'draft' && bl.draftState !== 'in_review') {
    return 'draft';
  }
  return 'review';
}

/** The names of organisations, by id, as the service gives them (`organisationNames`). */
export type OrganisationNames = Readonly<Record<string, string>>;

/**
 * An organisation a B/L names: by its name, the viewer's own marked as theirs; by its id when no
 * name is known; a dash for none.
 * @param organisationId the organisation, if any
 * @param viewer who looks at the B/L
 * @param names the names the service gave
 * @return the words
 */
export function partyLabel(
  organisationId: string | null | undefined,
  viewer: Viewer,
  names: OrganisationNames = {},
): string {
  if (!organisationId) {
    return NONE;
  }
  const name = Object.hasOwn(names, organisationId)
    ? names[organisationId]
    : '';
  if (organisationId !== viewer.organisationId) {
    return name || organisationId;
  }
  const own = viewer.organisation || name;
  if (!own) {
    return 'Your organisation';
  }
  return `${own} (your organisation)`;
}

/**
 * A B/L's chain of title as the rows of its page, oldest first.
 * @param chain the chain-of-title entries
 * @param viewer who looks at the B/L
 * @param names the names the service gave
 * @return one row per entry
 */
export function chainRows(
  chain: readonly ChainEntry[],
  viewer: Viewer,
  names: OrganisationNames = {},
): ChainRow[] {
  const ordered = [...chain].sort((a, b) => a.seq - b.seq);
  return ordered.map(entry => ({
    seq: entry.seq,
    step: STEP_NAMES.get(entry.command) ?? entry.command,
    from: partyLabel(entry.from, viewer, names),
    to: partyLabel(entry.to, viewer, names),
    by: entry.actor.name || NONE,
    at: entry.at,
  }));
}

/**
 * The tag class that colours a state of the given tone.
 * @param tone the tone (stateTone)
 * @return the platform's tag class
 */
export function toneTagClass(tone: StateTone): string {
  switch (tone) {
    case 'live':
      return 'tag-accent';
    case 'review':
      return 'tag-info';
    case 'draft':
      return 'tag-outline';
    default:
      return 'tag-neutral';
  }
}

/**
 * The carrier of a B/L: the title's once issued; before issue the record's owner, which alone sees
 * it and so is the viewer's organisation (the service gives it the carrier role).
 * @param bl the title (null before issue) and the viewer's roles
 * @param viewer who looks at the B/L
 * @return the carrier's organisation id, or null
 */
export function carrierOf(
  bl: {title: {carrier: string} | null; roles: readonly PartyRole[]},
  viewer: Viewer,
): string | null {
  if (bl.title) {
    return bl.title.carrier;
  }
  if (bl.roles.includes('carrier')) {
    return viewer.organisationId;
  }
  return null;
}
