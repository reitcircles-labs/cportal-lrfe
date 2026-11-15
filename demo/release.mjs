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
 * The shipping demo (CB-49), a second demo install beside the land registry's, never touching it:
 * project lrfe-shipping, port 8089, settings deploy/.env.shipping, its own OpenBao and data:
 *
 *   node demo/release.mjs rehearse --shipping --version V [--keep]   a throwaway shipping install
 *                                                            (project lrfe-rehearsal-shipping, port 8717)
 *   node demo/release.mjs teardown --shipping                remove that rehearsal install
 *   node demo/release.mjs install-shipping --version V       the shipping demo's first install
 *   node demo/release.mjs deploy --shipping --version V --mode upgrade|fresh
 *   node demo/release.mjs all --shipping --mode upgrade|fresh
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
 * A shipping install (demo/shipping-install.mjs) is refused before anything changes when it would
 * be the land demo's project, settings, port or volumes, or start a blockchain node of its own;
 * every shipping step also checks that the land demo's openbao and cardano were not touched.
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

import {
  DEMO_ENV_FILE,
  REHEARSAL_TEARDOWN_PROFILES,
  SHIPPING_DEMO,
  SHIPPING_LOCK_FILE,
  SHIPPING_REHEARSAL,
  SHIPPING_RELAY_FILE,
  landNetworkProblems,
  nodeNetworkProblems,
  parseSettings,
  rollbackCommand,
  shippingSettings,
  shippingTargetProblems,
  withSettings,
} from './shipping-install.mjs';
import {readinessOutcome} from './anchoring-funds.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(REPO, 'deploy');
const REHEARSAL = 'lrfe-rehearsal';
/** The rehearsal's settings, OpenBao keys and seal certificate: this user only, removed on teardown. */
const REHEARSAL_DIR = join(homedir(), '.lrfe-rehearsal');
const REHEARSAL_PORT = '8716';
/** Containers that must never be stopped, recreated or reconfigured by a release. */
const GUARDED = ['openbao', 'cardano'];
/**
 * The containers that use the data volumes, as in the readiness check's fresh start; shipping-records
 * only runs with the profile shipping (removing it where it does not run does nothing).
 */
const APP_SERVICES = [
  'web',
  'gateway',
  'identity',
  'edrms',
  'bpm',
  'intake',
  'land-records',
  'shipping-records',
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
  return parseSettings(readFileSync(file, 'utf8'));
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
      failItems: of('fail').map(r => r.item),
      warns: of('warn').length,
    };
  } catch {
    return {
      ready: false,
      fails: ['the readiness check gave no answer'],
      failItems: ['readiness'],
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

/**
 * Whether an install has containers.
 * @param {string} project its compose project
 * @return {boolean}
 */
function installExists(project) {
  const res = run(
    'docker',
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
    {capture: true},
  );
  return res.out.trim() !== '';
}

/**
 * The rehearsal installs `teardown` may remove: the land registry's and the shipping product's.
 * @param {boolean} shipping the shipping rehearsal
 * @return {{project: string, dir: string, envFile: string}}
 */
function rehearsalOf(shipping) {
  if (shipping) {
    return {
      project: SHIPPING_REHEARSAL.project,
      dir: SHIPPING_REHEARSAL.dir,
      envFile: join(SHIPPING_REHEARSAL.dir, 'rehearsal.env'),
    };
  }
  return {project: REHEARSAL, dir: REHEARSAL_DIR, envFile: rehearsalEnvFile()};
}

/**
 * `teardown` from the command line: for the shipping rehearsal, with the land demo's openbao and
 * cardano checked before and after (the relay of a shipping rehearsal was on the land network).
 * @param {boolean} shipping the shipping rehearsal, else the land registry's
 * @return {!Object}
 */
function teardownChecked(shipping) {
  if (!shipping) {
    return teardown(false);
  }
  const landBefore = landDemoState();
  const result = teardown(true);
  const problems = checkGuardsAfter(landBefore, landDemoState());
  if (problems.length) {
    throw new Refusal(`guard (land demo): ${problems.join('; ')}`);
  }
  return {
    ...result,
    landDemo: `${Object.keys(landBefore).join(' and ') || 'nothing'} of lrfe: same containers, no restart`,
  };
}

/**
 * Removes a rehearsal install: its containers, volumes, network, settings and keys.
 * @param {boolean} shipping the shipping rehearsal, else the land registry's
 * @return {{removed: boolean}}
 */
function teardown(shipping = false) {
  const {project, dir, envFile} = rehearsalOf(shipping);
  // the rehearsal's own settings, else the demo's (only read, for compose's required values)
  const settingsFile = existsSync(envFile) ? envFile : DEMO_ENV_FILE;
  // `down -v` only ever for a rehearsal project, with every profile it may use, the shipping
  // product's included (CB-49)
  const res = run(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--env-file',
      settingsFile,
      '-f',
      join(DEPLOY, 'docker-compose.yml'),
      'down',
      '-v',
      '--remove-orphans',
    ],
    {
      cwd: DEPLOY,
      env: {COMPOSE_PROFILES: REHEARSAL_TEARDOWN_PROFILES},
      capture: true,
    },
  );
  rmSync(dir, {recursive: true, force: true});
  const left = run(
    'docker',
    [
      'volume',
      'ls',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ],
    {capture: true},
  ).out.trim();
  if (installExists(project) || left) {
    throw new Refusal(
      `the rehearsal install ${project} is not fully removed: ${res.err.trim().split('\n').pop()}`,
    );
  }
  log(
    `rehearsal install ${project} removed: containers, volumes, network, settings, keys`,
  );
  return {removed: true};
}

/**
 * An install's new OpenBao: initialised (its unseal key and root token written to `initFile`, this
 * user only, never over an existing file), unsealed and prepared; with `shipping`, also for the
 * title signer (openbao-setup-shipping). Returns its root token.
 * @param {!Object} install the install (installOf)
 * @param {string} initFile where its unseal key and root token are kept
 * @param {boolean=} shipping prepare the title signer too
 * @return {string}
 */
function prepareOpenBao(install, initFile, shipping = false) {
  if (existsSync(initFile)) {
    throw new Refusal(
      `${initFile} exists: it holds the only unseal key of an earlier OpenBao. Nothing was changed.`,
    );
  }
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
  writeFileSync(initFile, init.out, {mode: 0o600, flag: 'wx'});
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
  runSetup(install, token, 'openbao-setup');
  if (shipping) {
    runSetup(install, token, 'openbao-setup-shipping');
  }
  log(
    `${install.project}: OpenBao initialised, unsealed and prepared${shipping ? ', the title signer too' : ''}`,
  );
  return token;
}

/**
 * Runs one of OpenBao's setup services (openbao-setup, openbao-setup-shipping) with the root token.
 * The node elects itself leader a few seconds after unsealing: the setup is tried until it is.
 * @param {!Object} install the install (installOf)
 * @param {string} token OpenBao's root token
 * @param {string} service the setup service, also the name of its profile without "openbao-"
 */
function runSetup(install, token, service) {
  const profile = service.replace(/^openbao-/, 'bao-');
  let setup;
  for (let i = 0; i < 20; i++) {
    setup = install.compose(
      ['--profile', profile, 'run', '--rm', '-T', '-e', 'BAO_TOKEN', service],
      {env: {BAO_TOKEN: token}, capture: true},
    );
    if (setup.ok) {
      return;
    }
    spawnSync('sleep', ['3']);
  }
  throw new Refusal(`${service} failed: ${setup.err.trim().split('\n').pop()}`);
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

/**
 * Refuses when the images of a version are not built.
 * @param {string} version the images' version
 */
function requireImages(version) {
  for (const tag of [`lrfe-backend:${version}`, `lrfe-web:${version}`]) {
    if (!imageExists(tag)) {
      throw new Refusal(
        `${tag} is not built (run: node demo/release.mjs build)`,
      );
    }
  }
}

function rehearse(version, keep) {
  requireImages(version);
  if (installExists(REHEARSAL)) {
    log('a rehearsal install is left from before: removing it first');
    teardown();
  }
  mkdirSync(REHEARSAL_DIR, {recursive: true, mode: 0o700});
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
    const token = prepareOpenBao(
      install,
      join(REHEARSAL_DIR, 'openbao-init.json'),
    );
    const cert = demoSealCertificate(install, token);
    // the seal as the demo install has it; every stored file encrypted at rest (API-795)
    writePrivate(
      rehearsalEnvFile(),
      withSettings(base, {
        LRFE_SEAL: 'bao',
        LRFE_SEAL_CERT: cert,
        EXTRACTS_ENCRYPTION: 'bao',
        EDRMS_ENCRYPTION: 'bao',
        INTAKE_ENCRYPTION: 'bao',
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

// ---------------------------------------------------------------------------------------- shipping

/**
 * The land demo's openbao and cardano as they run now (read only): a shipping step checks them
 * before and after, and they must be the same containers, never restarted.
 * @return {!Object<string, {id: string, startedAt: string, restarts: number, hash: string}>}
 */
function landDemoState() {
  return guardedState({project: 'lrfe'});
}

/**
 * Refuses a shipping install that would touch the land demo or is not a shipping install
 * (demo/shipping-install.mjs), before anything is changed.
 * @param {!Object} install the install (installOf)
 */
function refuseShippingProblems(install) {
  const demoSettings = existsSync(DEMO_ENV_FILE) ? readEnv(DEMO_ENV_FILE) : {};
  const problems = shippingTargetProblems({
    project: install.project,
    envFile: install.envFile,
    settings: install.settings,
    composeFiles: install.files.map(file => ({
      file,
      text: readFileSync(file, 'utf8'),
    })),
    demoSettings,
    shellProfiles: process.env.COMPOSE_PROFILES,
  });
  // anchoring through the relay (CB-49): to the land node's own network, and only the relay on it
  const nodeNetwork = install.settings.LRFE_NODE_NETWORK;
  if (nodeNetwork) {
    const landNetwork = landNodeNetwork();
    if (nodeNetwork !== landNetwork) {
      problems.push(
        `LRFE_NODE_NETWORK=${nodeNetwork} is not the land demo's node network (${landNetwork})`,
      );
    } else {
      const config = install.compose(['config', '--format', 'json'], {
        capture: true,
      });
      if (!config.ok) {
        problems.push(`compose config failed: ${config.err.trim()}`);
      } else {
        problems.push(
          ...nodeNetworkProblems(JSON.parse(config.out), landNetwork),
        );
      }
    }
  }
  if (problems.length) {
    throw new Refusal(`${problems.join('; ')}. Nothing was changed.`);
  }
}

/**
 * The network of the land demo that holds its blockchain node, read from docker (the container of
 * project lrfe's service cardano): the one network the shipping relay joins.
 * @return {string}
 */
function landNodeNetwork() {
  const ids = run(
    'docker',
    [
      'ps',
      '-q',
      '--filter',
      'label=com.docker.compose.project=lrfe',
      '--filter',
      'label=com.docker.compose.service=cardano',
    ],
    {capture: true},
  )
    .out.trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Refusal(
      `the land demo's blockchain node is not running (${ids.length} containers): the shipping install anchors through it`,
    );
  }
  const networks = run(
    'docker',
    [
      'inspect',
      ids[0],
      '--format',
      '{{range $name, $n := .NetworkSettings.Networks}}{{$name}} {{end}}',
    ],
    {capture: true},
  )
    .out.trim()
    .split(/\s+/)
    .filter(Boolean);
  if (networks.length !== 1) {
    throw new Refusal(
      `the land demo's blockchain node is on ${networks.length} networks, not one: ${networks.join(', ')}`,
    );
  }
  return networks[0];
}

/**
 * The land demo's network as the relay sees it: the containers on it and their names (aliases),
 * read only, for the before/after comparison of a shipping step.
 * @return {!Array<string>} one line per container: its name and aliases, sorted
 */
function landNetworkMembers() {
  const network = landNodeNetwork();
  const ids = run(
    'docker',
    [
      'network',
      'inspect',
      network,
      '--format',
      '{{range $id, $c := .Containers}}{{$id}} {{end}}',
    ],
    {capture: true},
  )
    .out.trim()
    .split(/\s+/)
    .filter(Boolean);
  return ids
    .map(id =>
      run(
        'docker',
        [
          'inspect',
          id,
          '--format',
          `{{.Name}} {{with index .NetworkSettings.Networks "${network}"}}{{join .Aliases ","}}{{end}}`,
        ],
        {capture: true},
      ).out.trim(),
    )
    .sort();
}

/**
 * Whether these settings are a shipping install's: the product or its profile.
 * @param {!Object<string, string>} settings the install's settings
 * @return {boolean}
 */
function isShipping(settings) {
  const profiles = (settings.COMPOSE_PROFILES || '').split(',');
  return (
    settings.LRFE_DOMAIN === 'shipping' ||
    profiles.map(p => p.trim()).includes('shipping')
  );
}

/**
 * Sets up a new shipping install (CB-49): started with its stored files unencrypted and the title
 * signer off, its own OpenBao initialised, unsealed and prepared (the title signer too), then
 * every stored file encrypted and the title signer on (TITLE_SIGNER=bao), and the readiness check.
 * The land demo's openbao and cardano are checked before and after; with anchoring through the
 * relay, also the land network's members, and the new wallet's address is written to `walletFile`.
 * An unfunded wallet is "waiting for funds", not a failure.
 * @param {{project: string, envFile: string, initFile: string, walletFile: (string|undefined)}}
 *     target the new install, where its OpenBao's keys and its wallet's address are written
 * @return {{ready: boolean, waitsForFunds: boolean, warns: number, landDemo: string,
 *     landNetwork: ({added: !Array<string>}|undefined), wallet: (?string|undefined)}}
 */
function setUpShipping({project, envFile, initFile, walletFile}) {
  const final = readFileSync(envFile, 'utf8');
  // the first start before OpenBao is prepared: nothing that needs its keys (the stored files'
  // keys, the title key, the anchoring wallet's key)
  const first = withSettings(final, {
    EXTRACTS_ENCRYPTION: 'off',
    EDRMS_ENCRYPTION: 'off',
    INTAKE_ENCRYPTION: 'off',
    TITLE_SIGNER: '',
    CARDANO_PROVIDER: '',
  });
  let install = installOf({project, envFile});
  refuseShippingProblems(install);
  const landBefore = landDemoState();
  const relayed = Boolean(install.settings.LRFE_NODE_NETWORK);
  const membersBefore = relayed ? landNetworkMembers() : [];
  // its key store, external when the shipping lock is on: compose never creates it
  if (
    install.files.some(f => f.endsWith('compose.keep-volumes.shipping.yml'))
  ) {
    const volume = `${project}_bao-data`;
    if (!run('docker', ['volume', 'inspect', volume], {capture: true}).ok) {
      if (!run('docker', ['volume', 'create', volume], {capture: true}).ok) {
        throw new Refusal(`docker volume create ${volume} failed`);
      }
      log(`created ${volume} (its key store, kept by the shipping lock)`);
    }
  }
  try {
    writeFileSync(envFile, first);
    install = installOf({project, envFile});
    log(
      `${project}: first start on ${install.settings.LRFE_VERSION}, port ${install.settings.LRFE_HTTP_PORT}`,
    );
    upAndWait(install);
    prepareOpenBao(install, initFile, true);
  } catch (err) {
    // the settings as they were given, never left half switched (stored files unencrypted)
    writeFileSync(envFile, final);
    throw new Refusal(
      `${err.message}. ${envFile} is back as it was given; the install is half set up (demo/README.md, "A first install that failed")`,
    );
  }
  writeFileSync(
    envFile,
    withSettings(final, {
      EXTRACTS_ENCRYPTION: 'bao',
      EDRMS_ENCRYPTION: 'bao',
      INTAKE_ENCRYPTION: 'bao',
      TITLE_SIGNER: 'bao',
    }),
  );
  install = installOf({project, envFile});
  upAndWait(install);
  const problems = checkGuardsAfter(landBefore, landDemoState());
  if (problems.length) {
    throw new Refusal(`guard (land demo): ${problems.join('; ')}`);
  }
  const result = {
    landDemo: `${Object.keys(landBefore).join(' and ') || 'nothing'} of lrfe: same containers, no restart`,
  };
  if (relayed) {
    result.landNetwork = landNetworkChange(membersBefore, landNetworkMembers());
    result.wallet = shippingWallet(install, walletFile);
  }
  const check = checkedReadiness(install);
  return {
    ready: check.ready,
    waitsForFunds: check.waitsForFunds,
    warns: check.warns,
    ...result,
  };
}

/**
 * The readiness check after a shipping step: ready, or waiting for funds (a new wallet: anchoring
 * waits until it is funded, the rest works, said plainly); refused otherwise.
 * @param {!Object} install the install (installOf)
 * @return {{ready: boolean, waitsForFunds: boolean, warns: number}}
 */
function checkedReadiness(install) {
  const check = readiness(install);
  const {ok, waitsForFunds} = readinessOutcome(check);
  let verdict = 'NOT READY';
  if (check.ready) {
    verdict = 'READY';
  } else if (waitsForFunds) {
    verdict =
      'WAITING FOR FUNDS: ready but for the wallet, not funded yet; anchoring waits';
  }
  log(`${install.project} readiness: ${verdict} (${check.warns} worth a look)`);
  if (!ok) {
    throw new Refusal(
      `${install.project} is not ready: ${check.fails.join('; ')}`,
    );
  }
  return {ready: check.ready, waitsForFunds, warns: check.warns};
}

/**
 * What a shipping step changed on the land demo's network: only the relay, under its own names, may
 * have joined it (demo/shipping-install.mjs, landNetworkProblems).
 * @param {!Array<string>} before the members before (landNetworkMembers)
 * @param {!Array<string>} after the members after
 * @return {{added: !Array<string>}}
 */
function landNetworkChange(before, after) {
  const problems = landNetworkProblems(before, after);
  if (problems.length) {
    throw new Refusal(landNetworkRefusal(problems));
  }
  return {added: after.filter(member => !before.includes(member))};
}

/**
 * The refusal's text when the land demo's network changed otherwise than by the relay.
 * @param {!Array<string>} problems what changed (landNetworkProblems)
 * @return {string}
 */
function landNetworkRefusal(problems) {
  return `guard (land demo's network): ${problems.join('; ')}`;
}

/**
 * The shipping install's own anchoring wallet (in its own OpenBao): its public address, written to
 * `walletFile` when given, so that it can be funded with test ADA.
 * @param {!Object} install the install (installOf)
 * @param {(string|undefined)} walletFile where to write the address
 * @return {?string} the address, or null when it cannot be read yet
 */
function shippingWallet(install, walletFile) {
  const res = run(
    'curl',
    [
      '-s',
      '--max-time',
      '10',
      `http://127.0.0.1:${install.settings.LRFE_HTTP_PORT}/api/audit/anchoring/wallet`,
    ],
    {capture: true},
  );
  let address = null;
  try {
    address = JSON.parse(res.out).address ?? null;
  } catch {
    // not readable yet: the readiness check says why
  }
  if (address && walletFile) {
    writeFileSync(walletFile, `${address}\n`);
    log(
      `its anchoring wallet: ${address} (also in ${walletFile}); fund it with test ADA`,
    );
  }
  return address;
}

/**
 * A throwaway shipping install from these images (project lrfe-rehearsal-shipping, port 8717), set
 * up as the shipping demo's first install is, then removed unless `keep`.
 * @param {string} version the images' version
 * @param {boolean} keep keep it for a closer look (teardown --shipping removes it)
 * @return {!Object}
 */
function rehearseShipping(version, keep) {
  requireImages(version);
  if (installExists(SHIPPING_REHEARSAL.project)) {
    log('a shipping rehearsal install is left from before: removing it first');
    teardown(true);
  }
  const {project, dir, envFile} = rehearsalOf(true);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  // the shipping demo's settings when it has them, else the land demo's (only read), else the
  // template, as a shipping install with new secrets, on the rehearsal's port, without the lock
  const base = [
    SHIPPING_DEMO.envFile,
    DEMO_ENV_FILE,
    join(DEPLOY, '.env.example'),
  ].find(file => existsSync(file));
  // anchoring as the shipping demo's: through the relay to the land demo's node, its own wallet
  writePrivate(
    envFile,
    shippingSettings(readFileSync(base, 'utf8'), {
      version,
      port: SHIPPING_REHEARSAL.port,
      composeFile: `docker-compose.yml:${SHIPPING_RELAY_FILE}`,
      nodeNetwork: landNodeNetwork(),
    }),
  );
  log(
    `shipping rehearsal install ${project} on ${version}, port ${SHIPPING_REHEARSAL.port}`,
  );
  try {
    const result = setUpShipping({
      project,
      envFile,
      initFile: join(dir, 'openbao-init.json'),
      walletFile: join(dir, 'wallet-address.txt'),
    });
    return {version, ...result, kept: keep};
  } finally {
    if (!keep) {
      teardown(true);
    }
  }
}

/**
 * The shipping demo's first install (project lrfe-shipping, port 8089): its settings file
 * deploy/.env.shipping written from the land demo's when missing (new secrets, never printed),
 * its own OpenBao (unseal key and root token in ~/lrfe-shipping-openbao-init.json) and data.
 * Refused when it is installed already: then `deploy --shipping`.
 * @param {string} version the images' version
 * @return {!Object}
 */
function installShipping(version) {
  requireImages(version);
  const {project, envFile, initFile, port} = SHIPPING_DEMO;
  if (installExists(project)) {
    throw new Refusal(
      `${project} is installed already: node demo/release.mjs deploy --shipping --version ${version} --mode upgrade|fresh`,
    );
  }
  if (existsSync(initFile)) {
    throw new Refusal(
      `${initFile} exists: it holds the only unseal key of an earlier OpenBao. Nothing was changed.`,
    );
  }
  let written = false;
  if (!existsSync(envFile)) {
    writePrivate(
      envFile,
      shippingSettings(readFileSync(DEMO_ENV_FILE, 'utf8'), {
        version,
        port,
        composeFile: `docker-compose.yml:${SHIPPING_LOCK_FILE}:${SHIPPING_RELAY_FILE}`,
        nodeNetwork: landNodeNetwork(),
      }),
    );
    written = true;
    log(`${envFile} written: new secrets, the shipping product, port ${port}`);
  } else {
    writeFileSync(
      envFile,
      withSettings(readFileSync(envFile, 'utf8'), {LRFE_VERSION: version}),
    );
  }
  const result = setUpShipping({
    project,
    envFile,
    initFile,
    walletFile: SHIPPING_DEMO.walletFile,
  });
  return {
    version,
    project,
    port,
    envFile,
    envWritten: written,
    initFile,
    ...result,
    note: `Each demo user sets up the authenticator at the first sign-in (demo/README.md, "A shipping install"). Anchoring waits until its wallet (address in ${SHIPPING_DEMO.walletFile}) has test ADA.`,
  };
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
  // a shipping install, the shipping demo's or another: never the land demo's project, port or
  // volumes, nor a blockchain node of its own (CB-49); the land demo is checked after it
  const shipping =
    isShipping(current.settings) || project === SHIPPING_DEMO.project;
  if (shipping) {
    refuseShippingProblems(current);
  }
  for (const tag of [`lrfe-backend:${version}`, `lrfe-web:${version}`]) {
    if (!imageExists(tag)) throw new Refusal(`${tag} is not built`);
  }
  const previous = current.settings.LRFE_VERSION;
  const before = guardedState(current);
  const landBefore = shipping ? landDemoState() : {};
  const relayed = shipping && Boolean(current.settings.LRFE_NODE_NETWORK);
  const membersBefore = relayed ? landNetworkMembers() : [];
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
        `To go back: ${rollbackCommand({project, envFile, version: previous})}`,
    );
  }

  const problems = checkGuardsAfter(before, guardedState(install));
  if (problems.length) throw new Refusal(`guard: ${problems.join('; ')}`);
  const landProblems = checkGuardsAfter(landBefore, landDemoState());
  if (landProblems.length) {
    throw new Refusal(`guard (land demo): ${landProblems.join('; ')}`);
  }
  const lost = protectedBefore.filter(name => !volumeExists(name));
  if (lost.length) {
    throw new Refusal(`guard: ${lost.join(', ')} missing`);
  }
  const landNetwork = relayed
    ? landNetworkChange(membersBefore, landNetworkMembers())
    : undefined;
  // a shipping install whose wallet is not funded yet waits for funds (CB-49); land as before
  const check = shipping ? checkedReadiness(install) : landReadiness(install);
  return {
    version,
    previous,
    mode,
    backup,
    guarded: Object.keys(before).map(s => `${s}: same container, no restart`),
    protectedVolumes: protectedBefore,
    ready: check.ready,
    waitsForFunds: check.waitsForFunds,
    landNetwork,
    warns: check.warns,
    note:
      mode === 'fresh'
        ? 'The demo users must set up their authenticators again (a fresh start removes them).'
        : null,
  };
}

/**
 * The readiness check after a land deploy, as before: refused unless ready.
 * @param {!Object} install the install (installOf)
 * @return {{ready: boolean, waitsForFunds: boolean, warns: number}}
 */
function landReadiness(install) {
  const check = readiness(install);
  log(
    `readiness: ${check.ready ? 'READY' : 'NOT READY'} (${check.warns} worth a look)`,
  );
  if (!check.ready) {
    throw new Refusal(`not ready after the deploy: ${check.fails.join('; ')}`);
  }
  return {ready: true, waitsForFunds: false, warns: check.warns};
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
  const shipping = process.argv.includes('--shipping');
  // the shipping demo's project and settings are fixed: never given (nor the land demo's)
  const refuseOtherTarget = name => {
    for (const given of ['--project', '--env', '--compose-file']) {
      if (option(given, [], true).length) {
        throw new Refusal(
          `${name} chooses the shipping demo install itself: ${given} is not taken`,
        );
      }
    }
  };
  const target = () => {
    if (shipping) {
      refuseOtherTarget('--shipping');
      return {
        project: SHIPPING_DEMO.project,
        envFile: SHIPPING_DEMO.envFile,
        composeFiles: [],
      };
    }
    return {
      project: option('--project', 'lrfe'),
      envFile: resolve(option('--env', DEMO_ENV_FILE)),
      composeFiles: option('--compose-file', [], true),
    };
  };
  const rehearseOne = (v, keep) =>
    shipping ? rehearseShipping(v, keep) : rehearse(v, keep);
  if (command === 'build') {
    result = build();
  } else if (command === 'rehearse') {
    result = rehearseOne(version(), process.argv.includes('--keep'));
  } else if (command === 'teardown') {
    result = teardownChecked(shipping);
  } else if (command === 'test') {
    result = test(version());
  } else if (command === 'install-shipping') {
    refuseOtherTarget('install-shipping');
    result = installShipping(version());
  } else if (command === 'deploy') {
    const mode = option('--mode');
    const where = target();
    result = deploy(version(), mode, where);
  } else if (command === 'all') {
    const mode = option('--mode');
    if (!['upgrade', 'fresh'].includes(mode)) {
      throw new Refusal(
        '--mode must be upgrade (data kept) or fresh (data erased): ask the user which',
      );
    }
    const where = target();
    const built = build();
    const rehearsal = rehearseOne(built.version, false);
    const e2e = test(built.version);
    const deployed = deploy(built.version, mode, where);
    result = {built, rehearsal, e2e, deployed};
  } else {
    throw new Refusal(
      'usage: node demo/release.mjs build | rehearse [--shipping] --version V [--keep] | teardown [--shipping] | test --version V | deploy [--shipping] --version V --mode upgrade|fresh | all [--shipping] --mode upgrade|fresh | install-shipping --version V',
    );
  }
  console.log(`RESULT ${JSON.stringify({ok: true, command, ...result})}`);
} catch (err) {
  const reason = err instanceof Refusal ? err.message : err.stack;
  console.log(`RESULT ${JSON.stringify({ok: false, command, reason})}`);
  process.exit(1);
}
