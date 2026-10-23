#!/usr/bin/env node
/**
 * The end-to-end tests against the application in containers (npm run test:docker): builds the
 * images from this checkout as it is (deploy/scripts/build.sh --worktree, version "e2e"), starts them with
 * deploy/docker-compose.yml plus the tests' additions (deploy/docker-compose.e2e.yml) as the
 * compose project "lrfe-e2e", and removes the containers and their volumes again when Playwright
 * stops it. The web app answers on the test web port, the gateway on the test API port, as with
 * the tests' own stack (start-backend.mjs), so the same tests run unchanged. The containers' logs
 * are kept in .stack/containers.log until the next run.
 *
 * E2E_DOCKER_VERSION=<version>: test images already built (or loaded from a bundle) instead.
 * The site settings in deploy/.env are never read.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {
  DEMO_PASSWORD,
  E2E_ORG,
  MAIL_DIR,
  PORTS,
  REPO_DIR,
  STACK_DIR,
  WEB_URL,
} from './config.mjs';

const DEPLOY_DIR = join(REPO_DIR, 'deploy');
const version = process.env.E2E_DOCKER_VERSION || 'e2e';
const {uid, gid} = userInfo();
// The identity container writes the emails into the tests' folder as the user running the tests.
// Rootless Docker maps the container's root to that user (other container users to unrelated ids).
const rootless =
  spawnSync('docker', ['info', '--format', '{{.SecurityOptions}}'], {
    encoding: 'utf8',
  }).stdout?.includes('rootless') ?? false;
const mailUser = rootless ? {uid: 0, gid: 0} : {uid, gid};

// Only what docker needs from this shell, and the settings of the test install
const env = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']
      .filter(k => process.env[k])
      .map(k => [k, process.env[k]]),
  ),
  LRFE_VERSION: version,
  LRFE_PUBLIC_URL: WEB_URL,
  LRFE_HTTP_PORT: String(PORTS.web),
  COOKIE_SECURE: 'false',
  JWT_SECRET: 'e2e-only-jwt-secret-not-used-anywhere-else',
  POSTGRES_PASSWORD: 'e2e-only-postgres-password',
  // the bundled database, OpenBao for the stored files (API-795) and the API docs (API-714)
  COMPOSE_PROFILES: 'postgres,bao,docs',
  E2E_BAO_TOKEN: 'e2e-only-openbao-root-token',
  LRFE_DOCS_PORT: String(PORTS.docs),
  // the organisation (API-712): test texts; Namibia's two offices, which the tests use
  LRFE_ORG_NAME: E2E_ORG.name,
  LRFE_ORG_SUBTITLE: E2E_ORG.subtitle,
  LRFE_ORG_PARENT: E2E_ORG.parent,
  LRFE_ORG_PLACE: E2E_ORG.place,
  LRFE_OFFICES: 'WDH=Deeds Registry · Windhoek;REH=Deeds Registry · Rehoboth',
  // the time zone of the dates on the extract and its check page (API-786)
  LRFE_TIME_ZONE: 'Africa/Windhoek',
  SEED_DEMO_PASSWORD: DEMO_PASSWORD,
  E2E_UID: String(mailUser.uid),
  E2E_GID: String(mailUser.gid),
  E2E_MAIL_DIR: MAIL_DIR,
  E2E_API_PORT: String(PORTS.gateway),
};
const compose = (...args) => [
  'compose',
  '--project-name',
  'lrfe-e2e',
  '--env-file',
  '/dev/null',
  '-f',
  join(DEPLOY_DIR, 'docker-compose.yml'),
  '-f',
  join(DEPLOY_DIR, 'docker-compose.e2e.yml'),
  ...args,
];
const docker = (args, stdio = 'inherit') =>
  spawnSync('docker', args, {
    env,
    stdio,
    cwd: DEPLOY_DIR,
    maxBuffer: 256 * 1024 * 1024,
  });

/** Containers and volumes of the test install: removed before and after each run. */
function down() {
  docker(compose('down', '--volumes', '--remove-orphans', '--timeout', '10'), [
    'ignore',
    'ignore',
    'inherit',
  ]);
}

let stopping = false;
/** Keeps the containers' logs, removes the test install and exits with `code`. */
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  // the containers' logs, kept until the next run: .stack/containers.log
  writeFileSync(
    join(STACK_DIR, 'containers.log'),
    docker(compose('logs', '--no-color', '--timestamps'), [
      'ignore',
      'pipe',
      'pipe',
    ]).stdout ?? '',
  );
  down();
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

rmSync(STACK_DIR, {recursive: true, force: true});
mkdirSync(MAIL_DIR, {recursive: true});
down();

if (!process.env.E2E_DOCKER_VERSION) {
  try {
    execFileSync(
      join(DEPLOY_DIR, 'scripts', 'build.sh'),
      ['--worktree', version],
      {stdio: 'inherit'},
    );
  } catch {
    console.error('could not build the images');
    process.exit(1);
  }
}

// OpenBao first, prepared with its keys and the services' logins before they start; the setup is
// tried until the node has elected itself leader, a few seconds after it starts
if (docker(compose('up', '--detach', 'openbao')).status !== 0) {
  console.error('the test OpenBao did not start');
  stop(1);
}
let prepared = false;
for (let i = 0; i < 20 && !prepared; i++) {
  prepared =
    docker(
      compose(
        '--profile',
        'bao-setup',
        'run',
        '--rm',
        '-T',
        '-e',
        `BAO_TOKEN=${env.E2E_BAO_TOKEN}`,
        'openbao-setup',
      ),
      // the last try shows why it failed
      i === 19 ? 'inherit' : 'ignore',
    ).status === 0;
  if (!prepared) spawnSync('sleep', ['1']);
}
if (!prepared) {
  console.error('the test OpenBao could not be prepared (openbao-setup)');
  stop(1);
}

// --wait: returns once every container is healthy (the web app last, after the gateway)
if (docker(compose('up', '--detach', '--wait')).status !== 0) {
  console.error(
    'the containers did not all become healthy; their last log lines:',
  );
  docker(compose('logs', '--tail', '40'));
  stop(1);
}
console.log(
  `e2e containers ready: web ${WEB_URL}, gateway http://localhost:${PORTS.gateway}`,
);
// stay up until Playwright stops this process (then stop() removes the containers)
setInterval(() => {}, 60_000);
