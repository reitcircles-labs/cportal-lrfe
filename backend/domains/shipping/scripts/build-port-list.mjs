#!/usr/bin/env node
/**
 * Builds the port list of the shipping pack (CB-63) from a UN/LOCODE code list in CSV.
 *
 *   node scripts/build-port-list.mjs <code-list.csv> [--release 2025-1] [--out <file>]
 *
 * Without --out it writes the pack's own list (data/un-locode-ports.json). An install can keep its
 * own file instead and point PORT_LIST_FILE of shipping-records to it (deploy/README.md).
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {
  DEFAULT_PORT_LIST_FILE,
  portsOfUnLocodeCsv,
} from '../src/ports/index.js';

const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {release: {type: 'string'}, out: {type: 'string'}},
});
if (positionals.length !== 1) {
  console.error(
    'Usage: node scripts/build-port-list.mjs <code-list.csv> [--release <name>] [--out <file>]',
  );
  process.exit(2);
}
const ports = portsOfUnLocodeCsv(readFileSync(positionals[0], 'utf8'));
const out = values.out ?? DEFAULT_PORT_LIST_FILE;
const list = {
  source: 'UN/LOCODE code list (UNECE), entries with a port function',
  release: values.release ?? null,
  ports: ports.map(({code, name, country}) => [code, name, country]),
};
writeFileSync(out, `${JSON.stringify(list)}\n`);
console.log(`${ports.length} ports written to ${out}`);
