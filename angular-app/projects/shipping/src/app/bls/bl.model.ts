/**
 * The B/Ls of the shipping app as the shipping record service answers them (gateway prefix
 * /api/records): the list of the B/Ls an organisation is party to (`GET /records/title`, CB-42)
 * and one B/L's title (`GET /records/:id/title`). Plain types, so the formatting in bl-format.ts
 * is tested without Angular.
 */

/** An organisation's role on a B/L. */
export type PartyRole = 'carrier' | 'holder' | 'past-holder' | 'consignee';

/** Where a B/L stands, as the list and the title read both give it. */
export interface BlState {
  /** `draft` until its first version is committed, then `committed`. */
  status: string;
  /** The open draft's state: `draft` or `in_review`; null when there is none. */
  draftState: string | null;
  /** The title once issued (the fields the state needs), else null. */
  title: {kind: string; state: string} | null;
}

/** A B/L's title: who holds it and in which state (null before issue). */
export interface TitleSummary {
  kind: string;
  state: string;
  carrier: string;
  holder: string | null;
  endorsement: string;
  consignee: string | null;
  /** While the carrier holds the B/L for a change, the holder it goes back to (CB-50). */
  returnTo?: string | null;
  /** The version of the B/L its title stands for: the one issued, then each amendment's. */
  issuedVersion?: number;
}

/** A B/L another is linked to by a split (CB-50): its id and number. */
export interface BlLink {
  recordId: string;
  recordNo: string;
}

/** A sea port on a B/L list page (CB-72). */
export interface BlListPort {
  code: string;
  name: string;
  country: string;
}

/** One B/L of the list of the B/Ls the organisation is party to. */
export interface BlListItem extends BlState {
  id: string;
  recordNo: string;
  carrierCode: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  title: TitleSummary | null;
  roles: PartyRole[];
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  shipper?: string | null;
  shipperName?: string | null;
  consignee?: string | null;
  consigneeName?: string | null;
  draftKind?: string | null;
}

/** A page of that list. */
export interface BlPage {
  items: BlListItem[];
  total: number;
  /** The names of the organisations the items name, by id (CB-42); some may be missing. */
  organisationNames: Record<string, string>;
  /** The ports the items name, by UN/LOCODE (CB-72). */
  ports?: Record<string, BlListPort>;
}

/** One step of a B/L's chain of title (the fields the app reads). */
export interface ChainEntry {
  seq: number;
  command: string;
  /** The organisations holding the B/L before and after the step. */
  from: string | null;
  to: string | null;
  /** The title's endorsement after the step: none, named or blank (CB-52). */
  endorsement?: string;
  actor: {id: string; name?: string | null; org: string | null};
  at: string;
}

/** A B/L's title as `GET /records/:id/title` answers it (the fields the app reads). */
export interface BlTitleView {
  recordId: string;
  record: {
    recordNo: string;
    carrierCode: string;
    label: string;
    status: string;
    draftState: string | null;
  };
  title: TitleSummary | null;
  /** The commands the user may run now; CB-44 offers the issue, CB-45..46 the others. */
  allowedCommands: string[];
  roles: PartyRole[];
  chain: ChainEntry[];
  /** The names of the organisations the title and its chain name, by id; some may be missing. */
  organisationNames: Record<string, string>;
  /** The B/L this one was split from, for a B/L made by a split (CB-50). */
  splitFrom?: BlLink;
  /** The B/Ls this one was split into, once split, by number (CB-50). */
  splitInto?: BlLink[];
}

/** Who looks at a B/L: their organisation, to name it as theirs. */
export interface Viewer {
  organisationId: string | null;
  organisation: string;
}

/** One entry of a version's change log (the fields the app reads). */
export interface VersionChange {
  byId: string | null;
  /** `create`, `open`, `edit`, `submit`, `commit`, `reject`... */
  action: string;
}

/** A version of a B/L as the record read gives it (the fields the app reads, CB-44). */
export interface DraftVersion {
  versionNumber: number;
  /** `draft`, `in_review` or `committed`. */
  state: string;
  revision?: number;
  createdById?: string | null;
  createdByName?: string | null;
  submittedById?: string | null;
  submittedByName?: string | null;
  approvedByName?: string | null;
  changes?: VersionChange[];
  /** The B/L of the model: its DCSA document, and its parties' organisations. */
  data?: {
    document?: Record<string, unknown>;
    partyOrganisations?: Record<string, string>;
  };
}

/**
 * A B/L of the user's own organisation as `GET /records/:id` answers it (the fields the app reads,
 * CB-44): its open draft, before it is issued.
 */
export interface BlRecord {
  id: string;
  recordNo: string;
  status: string;
  draftVersion: number | null;
  draftState: string | null;
  draft: DraftVersion | null;
  /** The current committed version, null before the first commit. */
  current: DraftVersion | null;
}

/** An organisation a new B/L may name as its shipper or consignee (CB-44). */
export interface PartyOrganisation {
  id: string;
  code: string;
  name: string;
}
