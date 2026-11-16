/**
 * The list of sea ports a B/L may name (CB-63): the ports of the UN/LOCODE code list, by their
 * five-character code. The list is a JSON file built from a UN/LOCODE release with
 * `scripts/build-port-list.mjs`; an install points to another file with PORT_LIST_FILE, so a new
 * release needs no code change.
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** The port list shipped with the shipping pack. */
export const DEFAULT_PORT_LIST_FILE = fileURLToPath(
  new URL('../../data/un-locode-ports.json', import.meta.url),
);

/** The B/L fields that name a port, as paths into the DCSA document. */
const PORT_FIELDS = [
  {path: 'transports.portOfLoading.UNLocationCode', words: 'port of loading'},
  {
    path: 'transports.portOfDischarge.UNLocationCode',
    words: 'port of discharge',
  },
];

/** The most ports a search returns. */
const MAX_RESULTS = 50;

/**
 * A port of the list.
 * @typedef {{code: string, name: string, country: string}} Port
 */

/**
 * Splits one CSV text into rows of fields (RFC 4180: quoted fields may hold commas, line breaks
 * and doubled quotes).
 * @param {string} text
 * @return {!Array<!Array<string>>}
 */
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') {
        index++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The sea ports of a UN/LOCODE code list in CSV (the columns Change, Country, Location, Name and
 * Function, by their header): the entries whose function names a port (its first character is
 * "1"), without those marked for removal ("X"), sorted by code.
 * @param {string} text the CSV
 * @return {!Array<!Port>}
 */
export function portsOfUnLocodeCsv(text) {
  const [header, ...rows] = csvRows(text);
  const column = name => {
    const index = header.indexOf(name);
    if (index < 0) {
      throw new Error(`The UN/LOCODE list has no column ${name}`);
    }
    return index;
  };
  const change = column('Change');
  const country = column('Country');
  const location = column('Location');
  const name = column('Name');
  const functionColumn = column('Function');
  const ports = [];
  for (const row of rows) {
    if (
      row.length < header.length ||
      row[change] === 'X' ||
      !row[functionColumn].startsWith('1') ||
      row[location].length !== 3
    ) {
      continue;
    }
    ports.push({
      code: `${row[country]}${row[location]}`.toUpperCase(),
      name: row[name].trim(),
      country: row[country].toUpperCase(),
    });
  }
  ports.sort((a, b) => a.code.localeCompare(b.code));
  return ports;
}

/**
 * The same words without accents, in lower case, for searching.
 * @param {string} text
 * @return {string}
 */
function folded(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * A port list to look ports up in and search.
 * @param {!Array<!Port>} ports
 * @param {string=} release the UN/LOCODE release it comes from, if known
 * @return {{size: number, release: ?string, has: function(string): boolean,
 *     get: function(string): ?Port, search: function(string, number=): !Array<!Port>}}
 */
export function createPortList(ports, release = null) {
  const byCode = new Map(ports.map(port => [port.code, port]));
  const index = ports.map(port => ({port, name: folded(port.name)}));
  return {
    size: byCode.size,
    release,
    has: code => byCode.has(String(code ?? '').toUpperCase()),
    get: code => byCode.get(String(code ?? '').toUpperCase()) ?? null,
    search(query, limit = 20) {
      const wanted = folded(String(query ?? '').trim());
      const max = Math.min(Math.max(1, limit), MAX_RESULTS);
      if (wanted === '') {
        return [];
      }
      const exact = byCode.get(wanted.toUpperCase());
      const found = exact ? [exact] : [];
      for (const entry of index) {
        if (found.length >= max) {
          break;
        }
        const matches =
          entry.port.code.toLowerCase().startsWith(wanted) ||
          entry.name.startsWith(wanted) ||
          entry.name.includes(` ${wanted}`);
        if (matches && entry.port !== exact) {
          found.push(entry.port);
        }
      }
      return found;
    },
  };
}

/**
 * Reads a port list file (JSON: `{release, ports: [[code, name, country], …]}`).
 * @param {string=} file the file; the pack's own list when not given
 * @return {!ReturnType<typeof createPortList>}
 */
export function loadPortList(file = DEFAULT_PORT_LIST_FILE) {
  const {release = null, ports} = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error(`The port list ${file} holds no ports`);
  }
  return createPortList(
    ports.map(([code, name, country]) => ({code, name, country})),
    release,
  );
}

/**
 * The value at a dotted path of a document.
 * @param {*} document
 * @param {string} path
 * @return {*}
 */
function valueAt(document, path) {
  let value = document;
  for (const key of path.split('.')) {
    value = value?.[key];
  }
  return value;
}

/**
 * The ports a B/L document names that are not in the port list, as problems. A port the B/L
 * already named in its previous version is not checked again, so a B/L issued before the list
 * still opens, and is amended or split, as it is.
 * @param {*} document the new document
 * @param {*} previous the B/L's previous document, null for a new B/L
 * @param {?ReturnType<typeof createPortList>} portList none: no check
 * @return {!Array<{path: string, message: string}>}
 */
export function portProblems(document, previous, portList) {
  if (!portList) {
    return [];
  }
  const problems = [];
  for (const {path, words} of PORT_FIELDS) {
    const code = valueAt(document, path);
    if (typeof code !== 'string' || code === '') {
      continue; // the schema check names a missing port
    }
    if (previous && valueAt(previous, path) === code) {
      continue;
    }
    if (!portList.has(code)) {
      problems.push({
        path,
        message: `${code} is not a sea port of the UN/LOCODE list: pick the ${words} from the list`,
      });
    }
  }
  return problems;
}
