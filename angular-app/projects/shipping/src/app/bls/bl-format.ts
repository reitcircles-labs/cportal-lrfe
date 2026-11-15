/**
 * How the shipping app shows a B/L (CB-42): its kind, its state, the organisation's roles on it,
 * the organisations it names and its chain of title; before issue, the version being approved or
 * issued (CB-44). Product wording, generic: no country, no organisation, no tool name. Tested by
 * bl-format.test.ts and bl-actions.test.ts (`npm run test:shipping`).
 */
import type {
  BlLink,
  BlState,
  ChainEntry,
  DraftVersion,
  PartyRole,
  TitleSummary,
  Viewer,
} from './bl.model';

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
    ['amendment-requested', {label: 'Change requested', ended: false}],
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

/** What the title read says of a B/L's versions and splits, to name its steps (CB-50). */
export interface ChainLinks {
  /** The version the title stands for now. */
  issuedVersion?: number;
  /** The B/Ls it was split into. */
  splitInto?: readonly BlLink[];
  /** The B/L it was split from. */
  splitFrom?: BlLink | null;
}

/**
 * The version each amendment of a chain made (CB-50): the title's version now, counted back over
 * the amendments, so a B/L issued at a later version counts on from there.
 * @param chain the chain-of-title entries, oldest first
 * @param issuedVersion the version the title stands for now
 * @return the version made, by the amendment entry's seq
 */
export function amendedVersions(
  chain: readonly ChainEntry[],
  issuedVersion: number,
): Map<number, number> {
  const amendments = chain.filter(entry => entry.command === 'amend');
  const versions = new Map<number, number>();
  let version = issuedVersion - amendments.length;
  for (const entry of amendments) {
    version += 1;
    versions.set(entry.seq, version);
  }
  return versions;
}

/**
 * The name of a step: with the links given, an amendment names the version it made, a split the
 * B/Ls it made and a child's first step the B/L it was split from.
 * @param entry the entry
 * @param links the links of the B/L
 * @param versions the version each amendment made, by seq
 * @return the step's name
 */
function stepName(
  entry: ChainEntry,
  links: ChainLinks,
  versions: ReadonlyMap<number, number>,
): string {
  const name = STEP_NAMES.get(entry.command) ?? entry.command;
  const version = versions.get(entry.seq);
  if (entry.command === 'amend' && version !== undefined) {
    return `Amended: version ${version}`;
  }
  const children = links.splitInto ?? [];
  if (entry.command === 'split' && children.length > 0) {
    return `Split into ${children.map(c => c.recordNo).join(', ')}`;
  }
  if (entry.command === 'issue-from-split' && links.splitFrom) {
    return `Issued from split of ${links.splitFrom.recordNo}`;
  }
  if (entry.command === 'endorse' && entry.endorsement === 'blank') {
    return 'Endorsed in blank';
  }
  return name;
}

/**
 * A B/L's chain of title as the rows of its page, oldest first.
 * @param chain the chain-of-title entries
 * @param viewer who looks at the B/L
 * @param names the names the service gave
 * @param links the B/L's version and split links, to name its steps (CB-50)
 * @return one row per entry
 */
export function chainRows(
  chain: readonly ChainEntry[],
  viewer: Viewer,
  names: OrganisationNames = {},
  links: ChainLinks = {},
): ChainRow[] {
  const ordered = [...chain].sort((a, b) => a.seq - b.seq);
  let versions = new Map<number, number>();
  if (links.issuedVersion !== undefined) {
    versions = amendedVersions(ordered, links.issuedVersion);
  }
  return ordered.map(entry => ({
    seq: entry.seq,
    step: stepName(entry, links, versions),
    from: partyLabel(entry.from, viewer, names),
    to: partyLabel(entry.to, viewer, names),
    by: entry.actor.name || NONE,
    at: entry.at,
  }));
}

/** The title state while the carrier holds the B/L for a change (CB-50). */
const CHANGE_STATE = 'amendment-requested';

/** One version of a B/L: its number and since when (CB-50). */
export interface VersionLine {
  version: number;
  at: string;
}

/**
 * What the page says while the carrier holds the B/L for a change: to the carrier, who asked and
 * that it goes back to them; to the one who asked, that it comes back to them.
 * @param title the title, null before issue
 * @param viewer who looks at the B/L
 * @param names the names the service gave
 * @return the text, '' in another state and for anyone else
 */
export function changeRequestNote(
  title: TitleSummary | null,
  viewer: Viewer,
  names: OrganisationNames = {},
): string {
  if (title?.state !== CHANGE_STATE || !viewer.organisationId) {
    return '';
  }
  if (viewer.organisationId === title.carrier) {
    const who = partyLabel(title.returnTo, viewer, names);
    return `${who} asked for a change. The B/L goes back to them.`;
  }
  if (viewer.organisationId === title.returnTo) {
    return 'Change requested: the carrier holds the B/L to change it and give it back to you.';
  }
  return '';
}

/**
 * The holder while the carrier holds the B/L for a change: the carrier, to go back to the one who
 * asked.
 * @param title the title, null before issue
 * @param viewer who looks at the B/L
 * @param names the names the service gave
 * @return the words, null in another state
 */
export function changeHolderLabel(
  title: TitleSummary | null,
  viewer: Viewer,
  names: OrganisationNames = {},
): string | null {
  if (title?.state !== CHANGE_STATE) {
    return null;
  }
  const carrier = partyLabel(title.carrier, viewer, names);
  const back = partyLabel(title.returnTo, viewer, names);
  return `${carrier}, to go back to ${back}`;
}

/**
 * The versions of an issued B/L, oldest first: the one issued (or made by a split), then one per
 * amendment, each since its step of the chain of title.
 * @param chain the chain-of-title entries
 * @param issuedVersion the version the title stands for now
 * @return the versions, none before issue
 */
export function versionHistory(
  chain: readonly ChainEntry[],
  issuedVersion: number,
): VersionLine[] {
  const ordered = [...chain].sort((a, b) => a.seq - b.seq);
  const amended = amendedVersions(ordered, issuedVersion);
  const lines: VersionLine[] = [];
  for (const entry of ordered) {
    const version = amended.get(entry.seq);
    if (version !== undefined) {
      lines.push({version, at: entry.at});
    } else if (
      entry.command === 'issue' ||
      entry.command === 'issue-from-split'
    ) {
      lines.push({version: issuedVersion - amended.size, at: entry.at});
    }
  }
  return lines;
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

/** A fact of a version, as the approval panel lists it, with a warning when it needs a look. */
export interface DraftFact {
  label: string;
  value: string;
  warning?: string;
}

/** The consignee of a B/L to order: none is named. */
export const NO_CONSIGNEE = 'None: to order';

/**
 * A value of a document read at a path, when it is text.
 * @param value where to start
 * @param path the keys and indexes to follow
 * @return the text, '' when there is none
 */
function textAt(value: unknown, path: ReadonlyArray<string | number>): string {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return '';
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return typeof current === 'string' ? current : '';
}

/**
 * The voyage of a document: vessel and voyage, then the ports.
 * @param document the version's document
 * @return the text, '' when it has none
 */
function voyageOf(document: Record<string, unknown>): string {
  const transports = document['transports'];
  const vessel = [
    textAt(transports, ['vesselVoyages', 0, 'vesselName']),
    textAt(transports, ['vesselVoyages', 0, 'carrierExportVoyageNumber']),
  ]
    .filter(text => text !== '')
    .join(' ');
  const from = textAt(transports, ['portOfLoading', 'UNLocationCode']);
  const to = textAt(transports, ['portOfDischarge', 'UNLocationCode']);
  const ports = from !== '' || to !== '' ? `${from} → ${to}` : '';
  return [vessel, ports].filter(text => text !== '').join(', ');
}

/**
 * The kind a document will be issued as, as the title engine reads it: a sea waybill, a B/L to
 * order (negotiable) or a straight B/L.
 * @param document the version's document
 * @return the kind's id, as kindLabel names it
 */
export function draftKind(document: Record<string, unknown>): string {
  if (document['transportDocumentTypeCode'] === 'SWB') {
    return 'waybill';
  }
  if (document['isToOrder'] === true) {
    return 'negotiable';
  }
  return 'straight';
}

/**
 * A party of a version: the organisation it is linked to (what the issue uses), by name, with a
 * warning when the document names it otherwise, or when it is linked to none.
 * @param label the fact's label
 * @param typed the party's name as the document gives it
 * @param linked the id of the organisation it is linked to, '' for none
 * @param names the organisations' names, by id
 * @return the fact
 */
function partyFact(
  label: string,
  typed: string,
  linked: string,
  names: Readonly<Record<string, string>>,
): DraftFact {
  if (linked === '') {
    if (typed === '') {
      return {label, value: NONE};
    }
    return {
      label,
      value: typed,
      warning: `"${typed}" is not linked to an organisation on the platform.`,
    };
  }
  const name = names[linked];
  if (name === undefined) {
    return {label, value: linked};
  }
  if (typed !== '' && typed !== name) {
    return {
      label,
      value: name,
      warning: `The document names "${typed}", but the B/L goes to ${name}.`,
    };
  }
  return {label, value: name};
}

/**
 * What the approver, and then the issuer, sees of a version: its kind, its shipper and consignee
 * (the organisations they are linked to, by name), the voyage, the container, the goods, who
 * prepared it and, once approved, who approved it.
 * @param version the version, null when there is none
 * @param names the organisations' names, by id
 * @return the facts, none without a version
 */
export function draftFacts(
  version: DraftVersion | null,
  names: Readonly<Record<string, string>>,
): DraftFact[] {
  if (version === null) {
    return [];
  }
  const document = version.data?.document ?? {};
  const links = version.data?.partyOrganisations ?? {};
  const parties = document['documentParties'];
  const kind = draftKind(document);
  let consignee: DraftFact = {label: 'Consignee', value: NO_CONSIGNEE};
  if (kind !== 'negotiable') {
    consignee = partyFact(
      'Consignee',
      textAt(parties, ['consignee', 'partyName']),
      links['consignee'] ?? '',
      names,
    );
  }
  const plain: Array<[string, string]> = [
    ['Voyage', voyageOf(document)],
    [
      'Container',
      textAt(document['utilizedTransportEquipments'], [
        0,
        'equipment',
        'equipmentReference',
      ]),
    ],
    [
      'Goods',
      textAt(document['consignmentItems'], [0, 'descriptionOfGoods', 0]),
    ],
    ['Prepared by', version.createdByName ?? ''],
  ];
  if (version.state === 'committed') {
    plain.push(['Approved by', version.approvedByName ?? '']);
  }
  return [
    {label: 'Kind', value: kindLabel(kind)},
    partyFact(
      'Shipper',
      textAt(parties, ['shipper', 'partyName']),
      links['shipper'] ?? '',
      names,
    ),
    consignee,
    ...plain.map(([label, value]) => ({label, value: value || NONE})),
  ];
}

/**
 * The consignee of an issued B/L: none for a B/L to order (negotiable), as before issue; the
 * named organisation of a straight B/L or a sea waybill.
 * @param title the B/L's title, null before issue
 * @param viewer who looks at the B/L
 * @param names the names the service gave
 * @return the words
 */
export function consigneeLabel(
  title: TitleSummary | null,
  viewer: Viewer,
  names: OrganisationNames = {},
): string {
  if (title?.kind === 'negotiable') {
    return NO_CONSIGNEE;
  }
  return partyLabel(title?.consignee, viewer, names);
}
