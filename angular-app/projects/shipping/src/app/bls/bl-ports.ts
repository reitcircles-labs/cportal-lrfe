/**
 * The port list in the B/L forms (CB-63): as a person types a code or a port's name, the field
 * offers the matching UN/LOCODE sea ports of the record service's list, and names the port picked.
 */

/** A sea port of the list. */
export interface Port {
  code: string;
  name: string;
  /** Its country, ISO 3166 code. */
  country: string;
}

/** Searches the port list by code or name. */
export type PortSearch = (query: string) => Promise<Port[]>;

/** What the port fields offer: the ports offered per field, and the ports seen, by code. */
export interface PortState {
  offered: ReadonlyMap<string, readonly Port[]>;
  known: ReadonlyMap<string, Port>;
}

/**
 * Where the state is kept: a component passes an Angular `signal`, so its template follows it;
 * a plain cell otherwise.
 */
export interface PortCell {
  (): PortState;
  set(state: PortState): void;
}

/** Nothing offered yet. */
export const NO_PORTS: PortState = {offered: new Map(), known: new Map()};

/**
 * A plain cell, for use outside a component.
 * @param initial its first state
 * @return the cell
 */
export function plainCell(initial: PortState = NO_PORTS): PortCell {
  let state = initial;
  const cell = (() => state) as PortCell;
  cell.set = next => {
    state = next;
  };
  return cell;
}

/** The shortest text the list is searched for. */
const MIN_QUERY = 2;

const COUNTRIES = new Intl.DisplayNames(['en'], {type: 'region'});

/**
 * How a port reads in the form: its name and its country's name.
 * @param port the port
 * @return e.g. "Rotterdam, Netherlands"
 */
export function portLabel(port: Port): string {
  let country = port.country;
  try {
    country = COUNTRIES.of(port.country) ?? port.country;
  } catch {
    // an unknown country code reads as it is
  }
  return `${port.name}, ${country}`;
}

/**
 * The ports offered for each port field of a form, and the ports already seen by code, to name
 * the one picked. Only the answer to the latest text typed in a field is kept.
 */
export class PortOptions {
  private readonly latest = new Map<string, number>();
  private requests = 0;
  private readonly searchPorts: PortSearch;
  private readonly state: PortCell;

  /**
   * @param searchPorts how the list is searched
   * @param state where the state is kept (an Angular signal in a component)
   */
  constructor(searchPorts: PortSearch, state: PortCell = plainCell()) {
    this.searchPorts = searchPorts;
    this.state = state;
  }

  /**
   * The ports offered for a field.
   * @param field the field
   * @return the ports
   */
  options(field: string): readonly Port[] {
    return this.state().offered.get(field) ?? [];
  }

  /**
   * The name of the port a code stands for, when the list has offered it.
   * @param code the code typed or picked
   * @return e.g. "Rotterdam, Netherlands", or '' when not known
   */
  nameOf(code: string): string {
    const port = this.state().known.get(code.trim().toUpperCase());
    return port ? portLabel(port) : '';
  }

  /**
   * Searches the list for what was typed in a field; a failed search offers nothing.
   * @param field the field
   * @param text what was typed
   * @return when the field's ports are offered
   */
  async search(field: string, text: string): Promise<void> {
    const query = text.trim();
    const request = ++this.requests;
    this.latest.set(field, request);
    let ports: Port[] = [];
    if (query.length >= MIN_QUERY) {
      try {
        ports = await this.searchPorts(query);
      } catch {
        ports = [];
      }
    }
    if (this.latest.get(field) !== request) {
      return; // a later text was typed meanwhile
    }
    const {offered, known} = this.state();
    const nextKnown = new Map(known);
    for (const port of ports) {
      nextKnown.set(port.code, port);
    }
    this.state.set({
      offered: new Map(offered).set(field, ports),
      known: nextKnown,
    });
  }
}
