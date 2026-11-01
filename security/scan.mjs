#!/usr/bin/env node
/**
 * The penetration tests (API-814): black-box scans of a throwaway install of the application,
 * from the outside only (the site, its API and the published API description; never the source
 * code). Run from the repository root; the guide is security/README.md.
 *
 *   node security/scan.mjs                       every pull request: quick scans, records officer
 *   node security/scan.mjs --level nightly       deep scans, signed in as each main role
 *   options: --roles rec,adm   --blocking   --version <images>   --out <folder>
 *
 * Steps: start the install (the containers of `npm run test:docker` as compose project
 * lrfe-pentest, e2e/stack/start-docker.mjs), sign the demo users in (with their authenticator
 * code), run ZAP, Nuclei, Schemathesis and OSV-Scanner as containers on the install's network,
 * read their reports (security/findings.mjs), write findings.json and summary.md, and remove the
 * install with its volumes. The reports stay in the output folder (security/.reports/<time>-<level>);
 * follow a run with `tail -f <folder>/run.log`.
 *
 * The last line is `RESULT {json}`. Exit code 1 when the install or a scanner failed, or with
 * --blocking (PENTEST_BLOCKING=1) when an open high finding remains; otherwise 0 (report only).
 */
import {spawn, spawnSync} from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {userInfo} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  applyAccepted,
  readNuclei,
  readOsv,
  readSchemathesis,
  readZap,
  summary,
  verdict,
} from './findings.mjs';

const SECURITY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SECURITY_DIR, '..');

// the install: its own project, ports and folders, never the demo's or the e2e tests'
const PROJECT = 'lrfe-pentest';
const NETWORK = `${PROJECT}_default`;
const TARGET = 'http://web:8080';
process.env.E2E_API_PORT ||= '3900';
process.env.E2E_WEB_PORT ||= '4600';

// the scanners, at fixed versions
const IMAGES = {
  zap: 'zaproxy/zap-stable:2.17.0',
  nuclei: 'projectdiscovery/nuclei:v3.11.1',
  schemathesis: 'schemathesis/schemathesis:4.32.7',
  osv: 'ghcr.io/google/osv-scanner:v2.7.0',
};

/** The main roles (identity's catalogue): registrar, capture, verify, records officer, admin. */
const MAIN_ROLES = ['sup', 'scan', 'rev', 'rec', 'adm'];

/**
 * What each level runs, in minutes: `zap` an active API scan, `schemathesis` its time budget,
 * `parallel` how many scanners at once (each ZAP takes about 1 GB of memory).
 */
const LEVELS = {
  pr: {
    roles: ['rec'],
    spider: 1,
    zap: 4,
    schemathesis: 2,
    nuclei: 6,
    parallel: 6,
  },
  nightly: {
    roles: MAIN_ROLES,
    spider: 5,
    zap: 30,
    schemathesis: 20,
    nuclei: 60,
    parallel: 3,
  },
};

/**
 * The value after a flag, or null.
 *
 * @param {string} name the flag, e.g. "--level"
 * @return {?string} its value
 */
function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const level = option('--level') || 'pr';
if (!LEVELS[level]) {
  console.error(`--level ${level}: pr or nightly`);
  process.exit(1);
}
const settings = LEVELS[level];
const roles = option('--roles')?.split(',') ?? settings.roles;
const blocking =
  process.argv.includes('--blocking') || process.env.PENTEST_BLOCKING === '1';
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '');
const OUT = resolve(
  option('--out') || join(SECURITY_DIR, '.reports', `${stamp}-${level}`),
);
const LOG = join(OUT, 'run.log');

mkdirSync(OUT, {recursive: true});
writeFileSync(LOG, '');

/** A line in run.log and on the console, with the time. */
function log(line) {
  const stamped = `${new Date().toTimeString().slice(0, 8)} ${line}`;
  appendFileSync(LOG, `${stamped}\n`);
  console.log(stamped);
}

/** Ends the run with its RESULT line. */
function finish(result, code) {
  log(`RESULT ${JSON.stringify(result)}`);
  process.exit(code);
}

// Rootless Docker maps the container's root to the user running this: the scanners run as root
// there, so their files belong to that user. Elsewhere (the GitHub runners) they run as the user,
// and ZAP as its own user, in folders open to it.
const rootless =
  spawnSync('docker', ['info', '--format', '{{.SecurityOptions}}'], {
    encoding: 'utf8',
  }).stdout?.includes('rootless') ?? false;
const {uid, gid} = userInfo();
const asUser = rootless ? ['--user', '0:0'] : ['--user', `${uid}:${gid}`];

/**
 * A folder the scanners write into, open to their container user.
 *
 * @param {string} name its path in the reports folder
 * @return {string} its full path
 */
function workDir(name) {
  const dir = join(OUT, name);
  mkdirSync(dir, {recursive: true});
  chmodSync(dir, 0o777);
  return dir;
}

let target = null;
// set on Ctrl-C or a cancel: nothing new starts, so nothing is left running
let stopping = false;

/** Removes the install: start-docker.mjs keeps its logs and takes it down when stopped. */
function stopTarget() {
  return new Promise(done => {
    if (!target || target.exitCode !== null) {
      done();
      return;
    }
    target.on('exit', () => done());
    target.kill('SIGTERM');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`stopped (${signal}): removing the install`);
    spawnSync('sh', [
      '-c',
      `docker ps -q --filter name=lrfe-scan- | xargs -r docker rm -f`,
    ]);
    await stopTarget();
    finish({ok: false, error: `stopped (${signal})`, reports: OUT}, 1);
  });
}

/**
 * Starts the install and resolves once all its containers are healthy (building the images first,
 * unless --version names images already built).
 */
function startTarget() {
  if (stopping) {
    return Promise.reject(new Error('stopped'));
  }
  const out = openSync(LOG, 'a');
  const env = {
    ...process.env,
    E2E_COMPOSE_PROJECT: PROJECT,
    E2E_COMPOSE_FILE: join(SECURITY_DIR, 'docker-compose.pentest.yml'),
    E2E_STACK_DIR: join(OUT, 'stack'),
  };
  if (option('--version')) {
    env.E2E_DOCKER_VERSION = option('--version');
  }
  target = spawn(
    process.execPath,
    [join(REPO_DIR, 'e2e', 'stack', 'start-docker.mjs')],
    {env, stdio: ['ignore', out, out]},
  );
  return new Promise((ready, failed) => {
    const timer = setInterval(() => {
      if (readFileSync(LOG, 'utf8').includes('e2e containers ready')) {
        clearInterval(timer);
        ready();
      }
    }, 2000);
    target.on('exit', code => {
      clearInterval(timer);
      failed(
        new Error(`the install did not start (exit ${code}); see run.log`),
      );
    });
  });
}

const API = `http://127.0.0.1:${process.env.E2E_API_PORT}`;
const secrets = new Map();

/** A JSON request to the install's gateway; throws on an answer other than 200. */
async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Signs in the first active demo user that holds only `role`, enrolling its authenticator the
 * first time, as the e2e tests do (tests/auth.setup.ts). Returns a fresh access token.
 *
 * @param {string} role a role id, e.g. "rec"
 * @return {Promise<string>} the access token
 */
async function signIn(role) {
  const [{DEMO_USERS}, {totp}, {DEMO_PASSWORD}] = await Promise.all([
    import('../backend/services/identity/src/seed.js'),
    import('../backend/services/identity/src/totp.js'),
    import('../e2e/stack/config.mjs'),
  ]);
  const user = DEMO_USERS.find(
    u => u.status === 'Active' && u.roles.length === 1 && u.roles[0] === role,
  );
  if (!user) {
    throw new Error(`no active demo user with only the role ${role}`);
  }
  const {email} = user;
  const step1 = await post('/api/auth/login', {email, password: DEMO_PASSWORD});
  if (step1.accessToken) {
    return step1.accessToken;
  }
  if (step1.next === 'mfa-enroll') {
    secrets.set(email, step1.secret);
  }
  const step2 = await post('/api/auth/mfa', {
    challenge: step1.challenge,
    code: totp(secrets.get(email)),
  });
  return step2.accessToken;
}

/**
 * Runs a scanner's container on the install's network, its output into run.log, stopped after
 * `minutes`. Secrets go in `env` (passed by name, never on the command line); `vars` are plain
 * settings of the container only (not of the docker command that starts it).
 *
 * @param {string} name the scan's name, in run.log and its container's name
 * @param {string} image the scanner's image
 * @param {string[]} args the scanner's arguments
 * @param {{env: ?object, vars: ?object, minutes: number, mounts: ?string[]}} options
 * @return {Promise<number>} the exit code (124 when stopped for time, 130 when the run was stopped)
 */
function runContainer(
  name,
  image,
  args,
  {env = {}, vars = {}, minutes, mounts = []},
) {
  if (stopping) {
    return Promise.resolve(130);
  }
  const container = `lrfe-scan-${name.replace(/[^a-z0-9]+/g, '-')}`;
  const out = openSync(LOG, 'a');
  const dockerArgs = [
    'run',
    '--rm',
    '--name',
    container,
    '--network',
    NETWORK,
    ...Object.keys(env).flatMap(k => ['-e', k]),
    ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...mounts.flatMap(m => ['-v', m]),
    ...(image === IMAGES.zap ? (rootless ? ['--user', '0:0'] : []) : asUser),
    image,
    ...args,
  ];
  log(`${name}: started (at most ${minutes} min)`);
  const started = Date.now();
  return new Promise(done => {
    const child = spawn('docker', dockerArgs, {
      env: {...process.env, ...env},
      stdio: ['ignore', out, out],
    });
    let late = false;
    const timer = setTimeout(
      () => {
        late = true;
        spawnSync('docker', ['stop', '--time', '10', container]);
      },
      (minutes + 2) * 60_000,
    );
    child.on('exit', code => {
      clearTimeout(timer);
      const took = Math.round((Date.now() - started) / 60_000);
      log(
        `${name}: ended, exit ${late ? 'stopped for time' : code} (${took} min)`,
      );
      done(late ? 124 : code);
    });
  });
}

/** Runs `jobs` (functions returning promises), at most `limit` at a time. */
async function inParallel(jobs, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (!stopping && next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({length: limit}, worker));
  return results;
}

/** The scans of this level, each {name, ok (its exit codes that mean it completed), report, read, run}. */
function scans(tokens) {
  const zapDir = workDir('zap');
  const spec = join(zapDir, 'openapi.yaml');
  copyFileSync(
    join(REPO_DIR, 'backend', 'services', 'gateway', 'docs', 'openapi.yaml'),
    spec,
  );
  const stDir = workDir('schemathesis');
  copyFileSync(spec, join(stDir, 'openapi.yaml'));
  // Nuclei's templates, downloaded on its first run and kept for the next ones
  const cache = join(SECURITY_DIR, '.reports', '.nuclei-cache');
  mkdirSync(cache, {recursive: true});
  chmodSync(cache, 0o777);
  const zapMount = `${zapDir}:/zap/wrk:rw`;
  const list = [
    {
      name: 'osv-scanner',
      // 1: vulnerabilities found
      ok: [0, 1],
      report: join(OUT, 'osv', 'osv.json'),
      read: file => readOsv(file),
      run: () =>
        runContainer(
          'osv-scanner',
          IMAGES.osv,
          [
            'scan',
            'source',
            ...['package-lock.json', 'backend', 'angular-app', 'e2e'].flatMap(
              p => [
                '-L',
                `/src/${p.endsWith('.json') ? p : `${p}/package-lock.json`}`,
              ],
            ),
            '--format',
            'json',
            '--output-file',
            '/out/osv.json',
          ],
          {
            minutes: 5,
            mounts: [`${REPO_DIR}:/src:ro`, `${workDir('osv')}:/out:rw`],
          },
        ),
    },
    {
      name: 'zap baseline',
      // 1 and 2: alerts at FAIL or WARN
      ok: [0, 1, 2],
      report: join(zapDir, 'baseline.json'),
      read: file => readZap(file, 'zap baseline'),
      run: () =>
        runContainer(
          'zap baseline',
          IMAGES.zap,
          [
            level === 'nightly' ? 'zap-full-scan.py' : 'zap-baseline.py',
            '-t',
            TARGET,
            '-m',
            String(settings.spider),
            ...(level === 'nightly' ? ['-j'] : []),
            '-J',
            'baseline.json',
            '-r',
            'baseline.html',
            '-I',
            ...(level === 'nightly'
              ? ['-z', `-config scanner.maxScanDurationInMins=${settings.zap}`]
              : []),
          ],
          {
            // nightly: the spider and the AJAX spider (each up to -m), the active scan, the passive wait
            minutes:
              level === 'nightly'
                ? 2 * settings.spider + settings.zap + 10
                : settings.spider + 5,
            mounts: [zapMount],
          },
        ),
    },
    {
      name: 'nuclei',
      ok: [0],
      report: join(OUT, 'nuclei', 'nuclei.jsonl'),
      read: file => readNuclei(file),
      run: () =>
        runContainer(
          'nuclei',
          IMAGES.nuclei,
          [
            '-u',
            TARGET,
            // every pull request: the templates for the technologies it detects; nightly: all
            ...(level === 'nightly' ? [] : ['-as']),
            '-jsonl',
            '-o',
            '/out/nuclei.jsonl',
            '-silent',
            '-rl',
            '50',
          ],
          {
            minutes: settings.nuclei,
            vars: {HOME: '/cache'},
            mounts: [`${workDir('nuclei')}:/out:rw`, `${cache}:/cache:rw`],
          },
        ),
    },
  ];
  // the API, signed out and as each role
  for (const who of ['anonymous', ...roles]) {
    const env = tokens[who] ? {PENTEST_TOKEN: tokens[who]} : {};
    const zapEnv = tokens[who]
      ? {
          ZAP_AUTH_HEADER: 'Authorization',
          ZAP_AUTH_HEADER_VALUE: `Bearer ${tokens[who]}`,
          ZAP_AUTH_HEADER_SITE: 'web',
        }
      : {};
    list.push(
      {
        name: `zap api (${who})`,
        ok: [0, 1, 2],
        report: join(zapDir, `api-${who}.json`),
        read: file => readZap(file, `zap api (${who})`),
        run: () =>
          runContainer(
            `zap api (${who})`,
            IMAGES.zap,
            [
              'zap-api-scan.py',
              '-t',
              '/zap/wrk/openapi.yaml',
              '-f',
              'openapi',
              '-O',
              TARGET,
              '-J',
              `api-${who}.json`,
              '-r',
              `api-${who}.html`,
              '-I',
              '-z',
              `-config scanner.maxScanDurationInMins=${settings.zap}`,
            ],
            {minutes: settings.zap + 3, env: zapEnv, mounts: [zapMount]},
          ),
      },
      {
        name: `schemathesis (${who})`,
        // 1: failures found
        ok: [0, 1],
        report: join(stDir, who, 'junit.xml'),
        read: file => readSchemathesis(file, `schemathesis (${who})`),
        run: () =>
          runContainer(
            `schemathesis (${who})`,
            IMAGES.schemathesis,
            [
              // a global option: before `run`
              ...(tokens[who]
                ? ['--config-file', '/st/schemathesis.toml']
                : []),
              'run',
              '/st/openapi.yaml',
              '--url',
              TARGET,
              '--checks',
              'not_a_server_error,ignored_auth,use_after_free,ensure_resource_availability',
              '--max-time',
              String(settings.schemathesis * 60),
              '--report',
              'junit',
              '--report-junit-path',
              `/st/${who}/junit.xml`,
              '--rate-limit',
              '20/s',
            ],
            {
              minutes: settings.schemathesis + 2,
              env,
              mounts: [`${stDir}:/st:rw`],
            },
          ),
      },
    );
  }
  for (const who of ['anonymous', ...roles]) {
    workDir(join('schemathesis', who));
  }
  // the signed-in runs read their token from the environment, never from the command line
  writeFileSync(
    join(stDir, 'schemathesis.toml'),
    '[headers]\nAuthorization = "Bearer ${PENTEST_TOKEN}"\n',
  );
  return list;
}

log(
  `penetration tests: level ${level}, roles ${roles.join(', ')}, ${blocking ? 'blocking' : 'report only'}`,
);
log(`reports: ${OUT}`);
log(`follow: tail -f ${LOG}`);

const errors = [];
let findings = [];
try {
  log(
    `install: compose project ${PROJECT}, web ${process.env.E2E_WEB_PORT}, gateway ${process.env.E2E_API_PORT}`,
  );
  try {
    await startTarget();
  } catch (err) {
    // a start-up job of the search engine (search-users) now and then fails once: one more try
    if (stopping) {
      throw err;
    }
    log(`install: ${err.message}; trying once more`);
    await startTarget();
  }
  log('install: ready');
  const tokens = {};
  for (const role of roles) {
    tokens[role] = await signIn(role);
    log(`signed in: ${role}`);
  }
  const list = scans(tokens);
  const codes = await inParallel(
    list.map(scan => () => scan.run()),
    settings.parallel,
  );
  list.forEach((scan, i) => {
    if (!existsSync(scan.report)) {
      errors.push(`${scan.name} (exit ${codes[i]}, no report; see run.log)`);
      return;
    }
    if (codes[i] === 124) {
      errors.push(`${scan.name} stopped for time (its report is partial)`);
    } else if (!scan.ok.includes(codes[i])) {
      errors.push(`${scan.name} (exit ${codes[i]}; see run.log)`);
    }
    try {
      findings.push(...scan.read(scan.report));
    } catch (err) {
      // a report cut short (stopped for time) must not lose the other scanners' findings
      errors.push(
        `${scan.name}: its report could not be read (${err.message})`,
      );
    }
  });
} catch (err) {
  errors.push(err.message);
  log(`error: ${err.message}`);
}
await stopTarget();
log('install: removed');

const accepted = JSON.parse(
  readFileSync(join(SECURITY_DIR, 'accepted-findings.json'), 'utf8'),
);
findings = applyAccepted(findings, accepted);
writeFileSync(join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
const text = summary(findings, {level, blocking, roles, errors});
writeFileSync(join(OUT, 'summary.md'), text);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
const result = verdict(findings, blocking);
log(
  `findings: ${JSON.stringify(result.counts)}; summary: ${join(OUT, 'summary.md')}`,
);
finish(
  {...result, ok: result.ok && !errors.length, errors, reports: OUT},
  result.ok && !errors.length ? 0 : 1,
);
