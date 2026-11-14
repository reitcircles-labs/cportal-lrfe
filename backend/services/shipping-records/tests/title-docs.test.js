import {readFileSync, readdirSync} from 'node:fs';

import {MODULES, STATES, TITLE_COMMANDS} from '@lrfe/domain-shipping/title';
import {expect} from 'chai';

import {OFFERED_COMMANDS} from '../src/title.service.js';

/**
 * CB-36: the title engine's docs describe every state, command, permission and refusal of the
 * code. The refusal codes are read from the sources (the engine's `new TitleRefusal('<code>'` and
 * the service's `code: '<code>'`), so a new refusal without a line in the docs fails here.
 *
 * - title-states.md (shipping pack): a table row per refusal code, per command (commands table),
 *   per state (states table), per module, and per command with its permission.
 * - chain-of-title.md: the entry of a B/L made by a split, `issue-from-split`.
 */

/** The shipping pack's docs. */
const DOCS_DIR = new URL('../../../domains/shipping/docs/', import.meta.url);

/** The title engine's sources (the pure state machine). */
const ENGINE_DIR = new URL(
  '../../../domains/shipping/src/title/',
  import.meta.url,
);

/** The record service's sources. */
const SERVICE_DIR = new URL('../src/', import.meta.url);

/**
 * The text of every .js file of a folder, concatenated.
 *
 * @param {!URL} dir
 * @return {string}
 */
function sourcesOf(dir) {
  const texts = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.js')) {
      texts.push(readFileSync(new URL(name, dir), 'utf8'));
    }
  }
  return texts.join('\n');
}

/**
 * Every match of a pattern's first group in a text, without duplicates, sorted.
 *
 * @param {string} text
 * @param {!RegExp} pattern a global pattern with one group
 * @return {!Array<string>}
 */
function matchesOf(text, pattern) {
  const found = new Set();
  for (const match of text.matchAll(pattern)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Whether a markdown text has a table row whose first cell is the name in backticks.
 *
 * @param {string} markdown
 * @param {string} name
 * @return {boolean}
 */
function hasRow(markdown, name) {
  return markdown.split('\n').some(line => line.startsWith(`| \`${name}\` |`));
}

const TITLE_STATES_DOC = readFileSync(
  new URL('title-states.md', DOCS_DIR),
  'utf8',
);
const CHAIN_OF_TITLE_DOC = readFileSync(
  new URL('chain-of-title.md', DOCS_DIR),
  'utf8',
);

/** The refusal codes of the engine: `new TitleRefusal('<code>'`, on one line or the next. */
const ENGINE_CODES = matchesOf(
  sourcesOf(ENGINE_DIR),
  /new TitleRefusal\(\s*'([a-z-]+)'/g,
);

/** The refusal codes of the service: `code: '<code>'` in its errors' details. */
const SERVICE_CODES = matchesOf(
  sourcesOf(SERVICE_DIR),
  /\bcode:\s*'([a-z-]+)'/g,
);

describe('CB-36 the title docs cover the code', () => {
  it('finds the refusal codes in the sources (the scan itself works)', () => {
    expect(ENGINE_CODES).to.include.members([
      'module-off',
      'wrong-state',
      'partial-release',
      'bearer-unconfirmed',
    ]);
    expect(SERVICE_CODES).to.include.members([
      'draft-open',
      'cargo-mismatch',
      'reference-taken',
      'unregistered-organisation',
      'unknown-command',
    ]);
  });

  describe('every refusal code of the engine has a row in title-states.md', () => {
    for (const code of ENGINE_CODES) {
      it(code, () => {
        expect(
          hasRow(TITLE_STATES_DOC, code),
          `no row for \`${code}\``,
        ).to.equal(true);
      });
    }
  });

  describe('every refusal code of the service has a row in title-states.md', () => {
    for (const code of SERVICE_CODES) {
      it(code, () => {
        expect(
          hasRow(TITLE_STATES_DOC, code),
          `no row for \`${code}\``,
        ).to.equal(true);
      });
    }
  });

  describe('every command has a row in title-states.md', () => {
    for (const command of Object.keys(TITLE_COMMANDS)) {
      it(command, () => {
        expect(hasRow(TITLE_STATES_DOC, command)).to.equal(true);
      });
    }
  });

  describe('every command offered by the service has its permission in title-states.md', () => {
    for (const [command, permission] of OFFERED_COMMANDS) {
      it(`${command}: ${permission}`, () => {
        const row = `| \`${command}\` | \`${permission}\` |`;
        expect(TITLE_STATES_DOC.split('\n')).to.include(row);
      });
    }
  });

  describe('every state of every kind is in the states table of title-states.md', () => {
    for (const [kind, states] of Object.entries(STATES)) {
      for (const state of states) {
        it(`${kind}: ${state}`, () => {
          const listed = TITLE_STATES_DOC.split('\n').some(
            line =>
              line.startsWith('| ') &&
              line.includes(kind) &&
              line.includes(`| \`${state}\` |`),
          );
          expect(listed).to.equal(true);
        });
      }
    }
  });

  describe('every module has a row in title-states.md', () => {
    for (const name of Object.keys(MODULES)) {
      it(name, () => {
        expect(hasRow(TITLE_STATES_DOC, name)).to.equal(true);
      });
    }
  });

  it('chain-of-title.md describes the entry issue-from-split', () => {
    expect(CHAIN_OF_TITLE_DOC).to.include('`issue-from-split`');
  });
});
