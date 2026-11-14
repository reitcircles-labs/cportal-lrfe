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
}

/** A page of that list. */
export interface BlPage {
  items: BlListItem[];
  total: number;
  /** The names of the organisations the items name, by id (CB-42); some may be missing. */
  organisationNames: Record<string, string>;
}

/** One step of a B/L's chain of title (the fields the app reads). */
export interface ChainEntry {
  seq: number;
  command: string;
  /** The organisations holding the B/L before and after the step. */
  from: string | null;
  to: string | null;
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
  /** The commands the user may run now; their buttons come with CB-44..46. */
  allowedCommands: string[];
  roles: PartyRole[];
  chain: ChainEntry[];
  /** The names of the organisations the title and its chain name, by id; some may be missing. */
  organisationNames: Record<string, string>;
}

/** Who looks at a B/L: their organisation, to name it as theirs. */
export interface Viewer {
  organisationId: string | null;
  organisation: string;
}
