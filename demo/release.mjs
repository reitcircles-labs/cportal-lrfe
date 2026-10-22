#!/usr/bin/env node
/**
 * A new demo version from main (API-794): build the images, try them on a throwaway rehearsal
 * install, run the docker e2e on them, and deploy them to the demo install, with the guards that
 * keep the blockchain node and OpenBao untouched. Run on the server, from the repository root:
 *
 *   node demo/release.mjs build                              images from origin/main (skipped if built)
 *   node demo/release.mjs rehearse --version V [--keep]      a throwaway install on V, with its own OpenBao
 *   node demo/release.mjs teardown                           remove the rehearsal install kept with --keep
 *   node demo/release.mjs test --version V                   the docker e2e on V
 *   node demo/release.mjs deploy --version V --mode upgrade|fresh
 *                                                            V on the demo install: data kept, or erased
 *   node demo/release.mjs all --mode upgrade|fresh           all four, stopping at the first failure
 *
 * deploy also takes --project, --env and --compose-file (repeatable) for an install other than the
 * demo's: the rehearsal install, for example, to show that the guards refuse. Every step prints what
 * it did and ends with one line "RESULT {json}". The exit code is 0 only when the step succeeded.
 *
 * Guards: the volumes <project>_cardano-db and <project>_bao-data are never removed and there is
 * never a `down -v` on an install that is not the rehearsal; the containers openbao and cardano
 * must keep their compose configuration (else nothing is changed), and the same container, start
 * time and restart count afterwards; deploy/.env is copied before it is changed; old images are
 * kept. Secrets (the root token, the demo password) are passed by environment, never printed.
 */
import {spawnSync} from 'node:child_process';
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(REPO, 'deploy');
const REHEARSAL = 'lrfe-rehearsal';
/** The rehearsal's settings, OpenBao keys and seal certificate: this user only, removed on teardown. */
const REHEARSAL_DIR = join(homedir(), '.lrfe-rehearsal');
const REHEARSAL_PORT = '8716';
/** Containers that must never be stopped, recreated or reconfigured by a release. */
const GUARDED = ['openbao', 'cardano'];
/** The containers that use the data volumes, as in the readiness check's fresh start. */
const APP_SERVICES = [
  'web',
  'gateway',
  'identity',
  'edrms',
  'bpm',
  'intake',
  'land-records',
  'audit',
  'extracts',
  'db-setup',
  'nats',
  'postgres',
];
/** The data a fresh start erases; never the node's or OpenBao's. */
const DATA_VOLUMES = [
  'pgdata',
  'edrms-files',
  'intake-files',
  'extracts-files',
  'natsdata',
];
const PROTECTED_VOLUMES = ['cardano-db', 'bao-data'];

const log = (...a) =>
  console.log(`[release ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Stops the step: the reason, then the RESULT line with ok false. */
class Refusal extends Error {}

// ------------------------------------------------------------------------------------------ helpers

/** The value after an option, the values of a repeated one (`all`), or the fallback. */
function option(name, fallback, all = false) {
  const args = process.argv.slice(3);
  const values = [];
  args.forEach((a, i) => {
    if (a === name) values.push(args[i + 1]);
  });
  if (values.some(v => !v || v.startsWith('--'))) {
    throw new Refusal(`${name} needs a value`);
  }
  if (all) return values;
  return values.length ? values[values.length - 1] : fallback;
}

/** Runs a program; its output goes to the terminal unless `capture`. Never through a shell. */
function run(
  program,
  args,
  {cwd = REPO, env = {}, input, capture = false} = {},
) {
  const res = spawnSync(program, args, {
    cwd,
    env: {...process.env, ...env},
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture || input ? 'pipe' : ['ignore', 'inherit', 'inherit'],
  });
  return {ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? ''};
}

/** The settings of an install, read the way docker compose reads them (as check-readiness.mjs). */
function readEnv(file) {
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^\s*export\s+/, '');
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(['"])(.*)\1\s*(#.*)?$/.exec(value);
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '').trim();
    env[match[1]] = value;
  }
  return env;
}

/** The settings file with `values` set: each line replaced in place, or added at the end. */
function withSettings(text, values) {
  const lines = text.split('\n');
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const name = /^\s*(?:export\s+)?([A-Za-z0-9_]+)=/.exec(lines[i])?.[1];
    if (name && name in values) {
      lines[i] = `${name}=${values[name]}`;
      seen.add(name);
    }
  }
  const added = Object.keys(values).filter(k => !seen.has(k));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return [...lines, ...added.map(k => `${k}=${values[k]}`), ''].join('\n');
}

/** Writes a file readable by this user only. */
function writePrivate(file, text) {
  writeFileSync(file, text, {mode: 0o600});
  chmodSync(file, 0o600);
}

/**
 * docker compose for one install: its project, settings file and compose files (by default those
 * of its COMPOSE_FILE, as compose itself would take them in deploy/).
 */
function installOf({project, envFile, composeFiles = []}) {
  const settings = readEnv(envFile);
  const files = (settings.COMPOSE_FILE || 'docker-compose.yml')
    .split(':')
    .filter(Boolean)
    .map(f => resolve(DEPLOY, f))
    .concat(composeFiles.map(f => resolve(f)));
  const compose = (args, opts = {}) =>
    run(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--env-file',
        envFile,
        ...files.flatMap(f => ['-f', f]),
        ...args,
      ],
      {cwd: DEPLOY, ...opts},
    );
  return {project, envFile, settings, files, compose};
}

const imageExists = tag =>
  run('docker', ['image', 'inspect', tag], {capture: true}).ok;

/** The running guarded containers of an install: id, start time, restarts, compose config hash. */
function guardedState(install) {
  const state = {};
  for (const service of GUARDED) {
    const res = run(
      'docker',
      [
        'inspect',
        `${install.project}-${service}-1`,
        '--format',
        '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{index .Config.Labels "com.docker.compose.config-hash"}}',
      ],
      {capture: true},
    );
    if (!res.ok) continue; // not part of this install (no bao or blockchain profile)
    const [id, startedAt, restarts, hash] = res.out.trim().split(' ');
    state[service] = {id, startedAt, restarts: Number(restarts), hash};
  }
  return state;
}

/**
 * Refuses before anything changes when the configuration about to be applied would recreate a
 * guarded container: its config hash under `install` (the settings as they will be) differs from
 * the running container's.
 */
function refuseIfGuardedWouldChange(install, before) {
  const services = Object.keys(before);
  if (!services.length) return;
  const res = install.compose(['config', '--hash', services.join(',')], {
    capture: true,
  });
  if (!res.ok) throw new Refusal(`compose config failed: ${res.err.trim()}`);
  for (const line of res.out.trim().split('\n')) {
    const [service, hash] = line.trim().split(/\s+/);
    if (before[service] && before[service].hash !== hash) {
      throw new Refusal(
        `${service}'s compose configuration would change (config hash ${before[service].hash.slice(0, 12)}… → ${hash.slice(0, 12)}…): it would be recreated. Nothing was changed.`,
      );
    }
  }
}

/** After the change: the same guarded containers, same start, no restart. */
function checkGuardsAfter(before, after) {
  const problems = [];
  for (const [service, was] of Object.entries(before)) {
    const now = after[service];
    if (!now) problems.push(`${service} is gone`);
    else if (now.id !== was.id) problems.push(`${service} is a new container`);
    else if (now.startedAt !== was.startedAt || now.restarts !== was.restarts) {
      problems.push(`${service} was restarted`);
    }
  }
  return problems;
}

/** up -d --wait; a first start of an empty install may report a failure while it settles: once more. */
function upAndWait(install) {
  if (install.compose(['up', '-d', '--wait']).ok) return;
  log('up --wait did not report healthy at once; trying once more');
  if (!install.compose(['up', '-d', '--wait']).ok) {
    throw new Refusal(
      'the install did not become healthy (docker compose up -d --wait failed twice)',
    );
  }
}

/** The readiness check of an install, as JSON: {ready, fails, warns}. */
function readiness(install) {
  const res = run(
    'node',
    [
      join(REPO, 'demo', 'check-readiness.mjs'),
      '--json',
      '--env',
      install.envFile,
      '--project',
      install.project,
    ],
    {capture: true},
  );
  try {
    const report = JSON.parse(res.out);
    const of = s => report.results.filter(r => r.status === s);
    return {
      ready: report.ready,
      fails: of('fail').map(r => `${r.item}: ${r.detail}`),
      warns: of('warn').length,
    };
  } catch {
    return {
      ready: false,
      fails: ['the readiness check gave no answer'],
      warns: 0,
    };
  }
}

// ------------------------------------------------------------------------------------------- build

/** The version build.sh gives a release of origin/main: <backend package version>-<commit>. */
function mainVersion() {
  if (!run('git', ['fetch', '-q', 'origin', 'main']).ok) {
    throw new Refusal('git fetch origin main failed');
  }
  const commit = run('git', ['rev-parse', 'origin/main'], {
    capture: true,
  }).out.trim();
  const pkg = JSON.parse(
    run('git', ['show', 'origin/main:backend/package.json'], {capture: true})
      .out,
  );
  return {commit, version: `${pkg.version}-${commit.slice(0, 7)}`};
}

function build() {
  const {commit, version} = mainVersion();
  const tags = [`lrfe-backend:${version}`, `lrfe-web:${version}`];
  if (tags.every(imageExists)) {
    log(`${tags.join(' and ')} already built: skipped`);
    return {version, commit, built: false};
  }
  // a release build of exactly origin/main, whatever is checked out here
  const tree = join(tmpdir(), `lrfe-release-${commit.slice(0, 7)}`);
  rmSync(tree, {recursive: true, force: true});
  if (!run('git', ['worktree', 'add', '-q', '--detach', tree, commit]).ok) {
    throw new Refusal('git worktree add failed');
  }
  try {
    log(`building ${version} from origin/main ${commit.slice(0, 7)}`);
    if (!run(join(tree, 'deploy', 'scripts', 'build.sh'), [], {cwd: tree}).ok) {
      throw new Refusal('deploy/scripts/build.sh failed');
    }
  } finally {
    run('git', ['worktree', 'remove', '--force', tree]);
  }
  return {version, commit, built: true};
}

// ---------------------------------------------------------------------------------------- rehearse

const rehearsalEnvFile = () => join(REHEARSAL_DIR, 'rehearsal.env');

/** The rehearsal install; its compose files are always the plain bundle, never the demo's volume lock. */
const rehearsalInstall = () =>
  installOf({
    project: REHEARSAL,
    envFile: rehearsalEnvFile(),
  });

function rehearsalExists() {
  const res = run(
    'docker',
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${REHEARSAL}`],
    {capture: true},
  );
  return res.out.trim() !== '';
}

function teardown() {
  // the rehearsal's own settings, else the demo's (only read, for compose's required values)
  const envFile = existsSync(rehearsalEnvFile())
    ? rehearsalEnvFile()
    : join(DEPLOY, '.env');
  // `down -v` only ever for the rehearsal project, with every profile it uses
  const res = run(
    'docker',
    [
      'compose',
      '--project-name',
      REHEARSAL,
      '--env-file',
      envFile,
      '-f',
      join(DEPLOY, 'docker-compose.yml'),
      'down',
      '-v',
      '--remove-orphans',
    ],
    {
      cwd: DEPLOY,
      env: {COMPOSE_PROFILES: 'postgres,bao,bao-setup'},
      capture: true,
    },
  );
  rmSync(REHEARSAL_DIR, {recursive: true, force: true});
  const left = run(
    'docker',
    [
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${REHEARSAL}`,
    ],
    {capture: true},
  ).out.trim();
  if (rehearsalExists() || left) {
    throw new Refusal(
      `the rehearsal install is not fully removed: ${res.err.trim().split('\n').pop()}`,
    );
  }
  log(
    'rehearsal install removed: containers, volumes, network, settings, keys',
  );
  return {removed: true};
}

/** The rehearsal's OpenBao: initialised, unsealed and prepared; returns its root token. */
function prepareOpenBao(install) {
  const initFile = join(REHEARSAL_DIR, 'openbao-init.json');
  const init = install.compose(
    [
      'exec',
      '-T',
      'openbao',
      'bao',
      'operator',
      'init',
      '-address=http://127.0.0.1:8200',
      '-key-shares=1',
      '-key-threshold=1',
      '-format=json',
    ],
    {capture: true},
  );
  if (!init.ok) throw new Refusal(`OpenBao init failed: ${init.err.trim()}`);
  writePrivate(initFile, init.out);
  const {unseal_keys_b64: keys, root_token: token} = JSON.parse(init.out);
  const unseal = install.compose(
    [
      'exec',
      '-T',
      'openbao',
      'bao',
      'write',
      '-address=http://127.0.0.1:8200',
      'sys/unseal',
      'key=-',
    ],
    {input: keys[0], capture: true},
  );
  if (!unseal.ok) throw new Refusal('OpenBao unseal failed');
  // the node elects itself leader a few seconds after unsealing: the setup is tried until it is
  let setup;
  for (let i = 0; i < 20; i++) {
    setup = install.compose(
      [
        '--profile',
        'bao-setup',
        'run',
        '--rm',
        '-T',
        '-e',
        'BAO_TOKEN',
        'openbao-setup',
      ],
      {env: {BAO_TOKEN: token}, capture: true},
    );
    if (setup.ok) break;
    spawnSync('sleep', ['3']);
  }
  if (!setup.ok) {
    throw new Refusal(
      `the OpenBao setup failed: ${setup.err.trim().split('\n').pop()}`,
    );
  }
  log('rehearsal OpenBao initialised, unsealed and prepared');
  return token;
}

/**
 * The demo seal certificate for the install's extracts-seal key, as demo/README.md makes it: a
 * demo authority issues a certificate for the key's public key. Returns it as one .env line.
 */
function demoSealCertificate(install, token) {
  const dir = join(REHEARSAL_DIR, 'seal');
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const key = install.compose(
    [
      'exec',
      '-T',
      '-e',
      'BAO_TOKEN',
      'openbao',
      'bao',
      'read',
      '-address=http://127.0.0.1:8200',
      '-format=json',
      'transit/keys/extracts-seal',
    ],
    {env: {BAO_TOKEN: token}, capture: true},
  );
  if (!key.ok) throw new Refusal('the seal key could not be read from OpenBao');
  const keys = JSON.parse(key.out).data.keys;
  const newest = Object.keys(keys).sort((a, b) => b - a)[0];
  writeFileSync(join(dir, 'extracts-seal.pub.pem'), keys[newest].public_key);
  const openssl = args => {
    if (!run('openssl', args, {cwd: dir, capture: true}).ok) {
      throw new Refusal(`openssl ${args[0]} failed`);
    }
  };
  openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    'demo-ca.key',
    '-out',
    'demo-ca.pem',
    '-days',
    '365',
    '-subj',
    '/CN=Demo seal authority (not valid)',
  ]);
  openssl([
    'req',
    '-new',
    '-key',
    'demo-ca.key',
    '-subj',
    '/O=Deeds Registry/CN=Deeds Registry (demo seal, not valid)',
    '-out',
    'seal.csr',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    'seal.csr',
    '-CA',
    'demo-ca.pem',
    '-CAkey',
    'demo-ca.key',
    '-CAcreateserial',
    '-force_pubkey',
    'extracts-seal.pub.pem',
    '-days',
    '365',
    '-out',
    'seal.pem',
  ]);
  return readFileSync(join(dir, 'seal.pem'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .join('\\n');
}

function rehearse(version, keep) {
  for (const tag of [`lrfe-backend:${version}`, `lrfe-web:${version}`]) {
    if (!imageExists(tag)) {
      throw new Refusal(
        `${tag} is not built (run: node demo/release.mjs build)`,
      );
    }
  }
  if (rehearsalExists()) {
    log('a rehearsal install is left from before: removing it first');
    teardown();
  }
  mkdirSync(REHEARSAL_DIR, {recursive: true, mode: 0o700});
  const demo = readEnv(join(DEPLOY, '.env'));
  // the demo's settings, on the rehearsal's own port and profiles, without anchoring or its seal
  const base = withSettings(readFileSync(join(DEPLOY, '.env'), 'utf8'), {
    LRFE_VERSION: version,
    LRFE_HTTP_PORT: REHEARSAL_PORT,
    LRFE_PUBLIC_URL: `http://localhost:${REHEARSAL_PORT}`,
    LRFE_DOCS_PORT: '3716',
    COMPOSE_PROFILES: 'postgres,bao',
    COMPOSE_FILE: 'docker-compose.yml',
    CARDANO_PROVIDER: '',
    LRFE_SEAL: '',
    LRFE_SEAL_CERT: '',
    EXTRACTS_ENCRYPTION: 'off',
    EDRMS_ENCRYPTION: 'off',
    INTAKE_ENCRYPTION: 'off',
  });
  writePrivate(rehearsalEnvFile(), base);
  let install = rehearsalInstall();
  log(`rehearsal install ${REHEARSAL} on ${version}, port ${REHEARSAL_PORT}`);
  try {
    upAndWait(install);
    const token = prepareOpenBao(install);
    const cert = demoSealCertificate(install, token);
    // the seal and the encryption as the demo install has them
    writePrivate(
      rehearsalEnvFile(),
      withSettings(base, {
        LRFE_SEAL: 'bao',
        LRFE_SEAL_CERT: cert,
        EXTRACTS_ENCRYPTION: 'bao',
        EDRMS_ENCRYPTION: demo.EDRMS_ENCRYPTION || 'off',
        INTAKE_ENCRYPTION: demo.INTAKE_ENCRYPTION || 'off',
      }),
    );
    install = rehearsalInstall();
    upAndWait(install);
    const check = readiness(install);
    log(
      `rehearsal readiness: ${check.ready ? 'READY' : 'NOT READY'} (${check.warns} worth a look)`,
    );
    if (!check.ready) {
      throw new Refusal(
        `the rehearsal install is not ready: ${check.fails.join('; ')}`,
      );
    }
    return {version, ready: true, warns: check.warns, kept: keep};
  } finally {
    if (!keep) teardown();
  }
}

// -------------------------------------------------------------------------------------------- test

/** backend and e2e dependencies as their lock files say: a merge can bring new packages. */
function ensureDependencies() {
  for (const dir of ['backend', 'e2e']) {
    const lock = join(REPO, dir, 'package-lock.json');
    const installed = join(REPO, dir, 'node_modules', '.package-lock.json');
    const same =
      existsSync(installed) &&
      JSON.stringify(JSON.parse(readFileSync(lock, 'utf8')).packages) ===
        JSON.stringify(JSON.parse(readFileSync(installed, 'utf8')).packages);
    if (same) continue;
    log(`${dir}: installing the dependencies of package-lock.json (npm ci)`);
    if (
      !run('npm', ['ci', '--silent'], {cwd: join(REPO, dir), capture: true}).ok
    ) {
      throw new Refusal(`npm ci in ${dir} failed`);
    }
  }
}

/** Totals and failed tests from Playwright's line reporter. */
function summarize(output) {
  const count = word =>
    Number(new RegExp(`(\\d+) ${word}`).exec(output)?.[1] ?? 0);
  const failed = [...output.matchAll(/^\s+\d+\) \[[^\]]+\] › (.+?)\s*$/gm)].map(
    m => m[1],
  );
  return {
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    didNotRun: count('did not run'),
    failures: [...new Set(failed)],
  };
}

function test(version) {
  ensureDependencies();
  const logFile = join(tmpdir(), `lrfe-release-e2e-${version}.log`);
  const env = {
    E2E_DOCKER_VERSION: version,
    E2E_API_PORT: process.env.E2E_API_PORT || '3600',
    E2E_WEB_PORT: process.env.E2E_WEB_PORT || '4300',
  };
  log(
    `docker e2e on ${version} (ports ${env.E2E_API_PORT}/${env.E2E_WEB_PORT}); full log ${logFile}`,
  );
  // straight into the log as it runs, so its progress can be followed (tail -f)
  const fd = openSync(logFile, 'w', 0o600);
  const res = spawnSync(
    'npm',
    ['run', '-s', 'test:docker', '--', '--reporter=line'],
    {
      cwd: join(REPO, 'e2e'),
      env: {...process.env, ...env},
      stdio: ['ignore', fd, fd],
    },
  );
  closeSync(fd);
  const output = readFileSync(logFile, 'utf8');
  const result = {version, ...summarize(output), log: logFile};
  log(
    `e2e: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.didNotRun} did not run`,
  );
  result.failures.forEach(f => log(`  failed: ${f}`));
  if (res.status !== 0 || result.failed) {
    throw new Refusal(
      `the docker e2e failed (${result.failed} failed): see ${logFile}`,
    );
  }
  return result;
}

// ------------------------------------------------------------------------------------------ deploy

/** The new version up: for a fresh start, first without the portal's containers and data. */
function changeVersion(install, mode, project, volumeExists) {
  if (mode === 'fresh') {
    const removed = install.compose(['rm', '-sf', ...APP_SERVICES], {
      capture: true,
    });
    if (!removed.ok) {
      throw new Refusal(
        `removing the portal's containers failed: ${removed.err.trim()}`,
      );
    }
    for (const name of DATA_VOLUMES.map(v => `${project}_${v}`)) {
      if (PROTECTED_VOLUMES.some(p => name === `${project}_${p}`)) {
        throw new Refusal(`refusing to remove ${name}`);
      }
      if (!volumeExists(name)) continue;
      if (!run('docker', ['volume', 'rm', name], {capture: true}).ok) {
        throw new Refusal(`docker volume rm ${name} failed`);
      }
      log(`removed volume ${name}`);
    }
  }
  upAndWait(install);
}

function deploy(version, mode, {project, envFile, composeFiles}) {
  if (!['upgrade', 'fresh'].includes(mode)) {
    throw new Refusal(
      '--mode must be upgrade (data kept) or fresh (data erased): ask the user which',
    );
  }
  if (!existsSync(envFile)) throw new Refusal(`${envFile} not found`);
  // another install never uses the demo's settings, nor a compose file that names the demo's
  // volumes (compose.keep-volumes.yml): it would mount the node's and OpenBao's data
  const demoEnv = join(DEPLOY, '.env');
  if (project !== 'lrfe' && resolve(envFile) === demoEnv) {
    throw new Refusal(
      `project ${project} with the demo's settings (${demoEnv}): give it its own --env`,
    );
  }
  const current = installOf({project, envFile, composeFiles});
  if (project !== 'lrfe') {
    const naming = current.files.filter(f =>
      /\blrfe_[a-z-]+/.test(readFileSync(f, 'utf8')),
    );
    if (naming.length) {
      throw new Refusal(
        `project ${project} with a compose file that names the demo's volumes: ${naming.join(', ')}`,
      );
    }
  }
  for (const tag of [`lrfe-backend:${version}`, `lrfe-web:${version}`]) {
    if (!imageExists(tag)) throw new Refusal(`${tag} is not built`);
  }
  const previous = current.settings.LRFE_VERSION;
  const before = guardedState(current);
  const volumeExists = name =>
    run('docker', ['volume', 'inspect', name], {capture: true}).ok;
  const protectedBefore = PROTECTED_VOLUMES.map(v => `${project}_${v}`).filter(
    volumeExists,
  );

  // the settings as they will be, checked before anything changes
  const draftFile = join(
    tmpdir(),
    `lrfe-release-${project}-${process.pid}.env`,
  );
  writePrivate(
    draftFile,
    withSettings(readFileSync(envFile, 'utf8'), {LRFE_VERSION: version}),
  );
  try {
    refuseIfGuardedWouldChange(
      {...installOf({project, envFile: draftFile, composeFiles})},
      before,
    );
  } finally {
    rmSync(draftFile, {force: true});
  }

  // the settings file kept as it was, then the new version
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backup = join(
    homedir(),
    `${project}-env.backup-${stamp}-${process.pid}`,
  );
  copyFileSync(envFile, backup, fsConstants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  // in place, so the file keeps its owner and mode
  writeFileSync(
    envFile,
    withSettings(readFileSync(envFile, 'utf8'), {LRFE_VERSION: version}),
  );
  log(
    `${envFile}: LRFE_VERSION ${previous} → ${version} (copy of the old file: ${backup})`,
  );
  const install = installOf({project, envFile, composeFiles});
  try {
    changeVersion(install, mode, project, volumeExists);
  } catch (err) {
    const guards = checkGuardsAfter(before, guardedState(install));
    throw new Refusal(
      `${err.message}. LRFE_VERSION is now ${version} (was ${previous}); the old settings are in ${backup}. ` +
        `Guards: ${guards.length ? guards.join('; ') : 'openbao and cardano untouched'}. ` +
        `To go back: node demo/release.mjs deploy --version ${previous} --mode upgrade`,
    );
  }

  const problems = checkGuardsAfter(before, guardedState(install));
  if (problems.length) throw new Refusal(`guard: ${problems.join('; ')}`);
  const lost = protectedBefore.filter(name => !volumeExists(name));
  if (lost.length) throw new Refusal(`guard: ${lost.join(', ')} missing`);
  const check = readiness(install);
  log(
    `readiness: ${check.ready ? 'READY' : 'NOT READY'} (${check.warns} worth a look)`,
  );
  if (!check.ready) {
    throw new Refusal(`not ready after the deploy: ${check.fails.join('; ')}`);
  }
  return {
    version,
    previous,
    mode,
    backup,
    guarded: Object.keys(before).map(s => `${s}: same container, no restart`),
    protectedVolumes: protectedBefore,
    ready: true,
    warns: check.warns,
    note:
      mode === 'fresh'
        ? 'The demo users must set up their authenticators again (a fresh start removes them).'
        : null,
  };
}

// -------------------------------------------------------------------------------------------- main

const command = process.argv[2];
let result;
try {
  const version = () => {
    const v = option('--version');
    if (!v) throw new Refusal('--version is required');
    return v;
  };
  const target = () => ({
    project: option('--project', 'lrfe'),
    envFile: resolve(option('--env', join(DEPLOY, '.env'))),
    composeFiles: option('--compose-file', [], true),
  });
  if (command === 'build') result = build();
  else if (command === 'rehearse') {
    result = rehearse(version(), process.argv.includes('--keep'));
  } else if (command === 'teardown') result = teardown();
  else if (command === 'test') result = test(version());
  else if (command === 'deploy') {
    result = deploy(version(), option('--mode'), target());
  } else if (command === 'all') {
    const mode = option('--mode');
    if (!['upgrade', 'fresh'].includes(mode)) {
      throw new Refusal(
        '--mode must be upgrade (data kept) or fresh (data erased): ask the user which',
      );
    }
    const built = build();
    const rehearsal = rehearse(built.version, false);
    const e2e = test(built.version);
    const deployed = deploy(built.version, mode, target());
    result = {built, rehearsal, e2e, deployed};
  } else {
    throw new Refusal(
      'usage: node demo/release.mjs build | rehearse --version V [--keep] | teardown | test --version V | deploy --version V --mode upgrade|fresh | all --mode upgrade|fresh',
    );
  }
  console.log(`RESULT ${JSON.stringify({ok: true, command, ...result})}`);
} catch (err) {
  const reason = err instanceof Refusal ? err.message : err.stack;
  console.log(`RESULT ${JSON.stringify({ok: false, command, reason})}`);
  process.exit(1);
}
