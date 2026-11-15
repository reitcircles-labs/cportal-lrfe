/**
 * demo/release.mjs's refusals for the shipping demo install (CB-49), checked from the command line.
 * Every case is refused before anything is changed; each uses a version that is not built, so even
 * a guard that failed would stop at the image check, never at an install.
 * Run with: node --test demo/release.test.mjs
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release.mjs');
const NO_SUCH_VERSION = '0.0.0-cb49-test-not-built';
const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
after(() => rmSync(dir, {recursive: true, force: true}));

/**
 * Runs release.mjs with these arguments; returns its RESULT line, parsed.
 * @param {!Array<string>} args the command and its options
 * @return {{ok: boolean, command: string, reason: (string|undefined)}}
 */
function release(args) {
  const res = spawnSync('node', [SCRIPT, ...args], {encoding: 'utf8'});
  const line = res.stdout
    .split('\n')
    .reverse()
    .find(l => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line: ${res.stdout}${res.stderr}`);
  const result = JSON.parse(line.slice('RESULT '.length));
  assert.equal(res.status === 0, result.ok);
  return result;
}

/**
 * A settings file of a shipping install, with these settings changed.
 * @param {string} name the file's name
 * @param {!Object<string, string>} settings the settings that differ
 * @return {string} its path
 */
function shippingEnv(name, settings = {}) {
  const values = {
    LRFE_VERSION: NO_SUCH_VERSION,
    LRFE_HTTP_PORT: '8799',
    LRFE_PUBLIC_URL: 'http://localhost:8799',
    LRFE_DOMAIN: 'shipping',
    COMPOSE_PROFILES: 'postgres,bao,shipping',
    COMPOSE_FILE: 'docker-compose.yml',
    JWT_SECRET: 'x'.repeat(48),
    POSTGRES_PASSWORD: 'p'.repeat(48),
    ...settings,
  };
  const file = join(dir, name);
  writeFileSync(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  return file;
}

test('deploy --shipping chooses the shipping demo itself: --project and --env are refused', () => {
  for (const extra of [
    ['--project', 'lrfe'],
    ['--env', shippingEnv('a.env')],
    ['--compose-file', join(dir, 'x.yml')],
  ]) {
    const result = release([
      'deploy',
      '--shipping',
      '--version',
      NO_SUCH_VERSION,
      '--mode',
      'upgrade',
      ...extra,
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /--shipping/, extra[0]);
  }
});

test('deploy --shipping needs the mode', () => {
  const result = release([
    'deploy',
    '--shipping',
    '--version',
    NO_SUCH_VERSION,
    '--mode',
    'install',
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /--mode must be upgrade/);
});

test('install-shipping needs a version', () => {
  const result = release(['install-shipping']);
  assert.equal(result.ok, false);
  assert.match(result.reason, /--version is required/);
});

test('install-shipping takes no other project or settings file', () => {
  for (const extra of [
    ['--project', 'lrfe'],
    ['--env', shippingEnv('b.env')],
  ]) {
    const result = release([
      'install-shipping',
      '--version',
      NO_SUCH_VERSION,
      ...extra,
    ]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /install-shipping/, extra[0]);
  }
});

test("any deploy of a shipping install gets the shipping guards: not on the land demo's port", () => {
  const result = release([
    'deploy',
    '--version',
    NO_SUCH_VERSION,
    '--mode',
    'upgrade',
    '--project',
    'lrfe-cb49-test',
    '--env',
    shippingEnv('c.env', {LRFE_HTTP_PORT: '8088'}),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /port 8088/);
});

test('any deploy of a shipping install gets the shipping guards: no blockchain node of its own', () => {
  const result = release([
    'deploy',
    '--version',
    NO_SUCH_VERSION,
    '--mode',
    'upgrade',
    '--project',
    'lrfe-cb49-test',
    '--env',
    shippingEnv('d.env', {
      COMPOSE_PROFILES: 'postgres,bao,shipping,blockchain',
    }),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /blockchain/);
});

test('the land demo never becomes a shipping install', () => {
  const result = release([
    'deploy',
    '--version',
    NO_SUCH_VERSION,
    '--mode',
    'upgrade',
    '--project',
    'lrfe',
    '--env',
    shippingEnv('e.env'),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /project lrfe/);
});

test('rehearse --shipping and teardown --shipping are known; an unknown command is refused', () => {
  const unknown = release(['rehearse-everything']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /install-shipping/);
  assert.match(unknown.reason, /--shipping/);
  const noVersion = release(['rehearse', '--shipping']);
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.reason, /--version is required/);
});
