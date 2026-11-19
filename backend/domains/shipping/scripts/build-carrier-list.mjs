#!/usr/bin/env node
/**
 * Builds the SMDG liner code list of the shipping pack (CB-68) from the official SMDG `.xlsx`
 * workbook (https://smdg.org/documents/smdg-code-lists/smdg-liner-code-list/).
 *
 *   node scripts/build-carrier-list.mjs <SMDG-Liner-codes-list.xlsx> [--version 20261028] [--downloaded 2026-11-19] [--out <file>]
 *
 * Without --out it writes the pack's own list (data/smdg-liner-codes.json). An install can keep
 * its own file instead and point CARRIER_LIST_FILE of shipping-records to it.
 */

import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {
  DEFAULT_CARRIER_LIST_FILE,
  carriersOfRows,
} from '../src/carriers/index.js';

/**
 * Unescapes standard XML entities from spreadsheet cells.
 * @param {string} text
 * @return {string}
 */
function unescapeXml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extracts shared string entries from `xl/sharedStrings.xml`.
 * @param {string} xml
 * @return {!Array<string>}
 */
function parseSharedStrings(xml) {
  const strings = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [];
    for (const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      parts.push(unescapeXml(t[1]));
    }
    strings.push(parts.join(''));
  }
  return strings;
}

/**
 * Reads `[code, name]` rows from `xl/worksheets/sheet1.xml` using shared strings.
 * @param {string} sheetXml
 * @param {!Array<string>} sharedStrings
 * @return {!Array<!Array<string>>}
 */
function parseSheetRows(sheetXml, sharedStrings) {
  const rows = [];
  let afterHeader = false;
  for (const row of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] ?? '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? '';
      const val = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (val === undefined) {
        continue;
      }
      cells[ref] = (
        type === 's' ? (sharedStrings[Number(val)] ?? '') : unescapeXml(val)
      ).trim();
    }
    if (!afterHeader) {
      if ((cells.A ?? '').startsWith('Code')) {
        afterHeader = true;
      }
      continue;
    }
    if (cells.A && cells.B) {
      rows.push([cells.A, cells.B]);
    }
  }
  return rows;
}

const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {
    version: {type: 'string'},
    downloaded: {type: 'string'},
    out: {type: 'string'},
  },
});
if (positionals.length !== 1) {
  console.error(
    'Usage: node scripts/build-carrier-list.mjs <SMDG-Liner-codes-list.xlsx> [--version <name>] [--downloaded <YYYY-MM-DD>] [--out <file>]',
  );
  process.exit(2);
}

const xlsxPath = positionals[0];
const sharedXml = execFileSync(
  'unzip',
  ['-p', xlsxPath, 'xl/sharedStrings.xml'],
  {encoding: 'utf8', maxBuffer: 20 * 1024 * 1024},
);
const sheetXml = execFileSync(
  'unzip',
  ['-p', xlsxPath, 'xl/worksheets/sheet1.xml'],
  {encoding: 'utf8', maxBuffer: 20 * 1024 * 1024},
);

const carriers = carriersOfRows(
  parseSheetRows(sheetXml, parseSharedStrings(sharedXml)),
);
const out = values.out ?? DEFAULT_CARRIER_LIST_FILE;
const list = {
  source: 'SMDG Liner Code List (LCL), smdg.org',
  version: values.version ?? null,
  downloadedAt: values.downloaded ?? new Date().toISOString().slice(0, 10),
  carriers: carriers.map(({code, name}) => [code, name]),
};
writeFileSync(out, `${JSON.stringify(list)}\n`);
console.log(`${carriers.length} carriers written to ${out}`);
