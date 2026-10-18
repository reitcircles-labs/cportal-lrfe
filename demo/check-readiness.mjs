#!/usr/bin/env node
/**
 * Is the demo install ready? (API-717) Run on the server, from the repository root:
 *
 *   node demo/check-readiness.mjs                 the install in deploy/ (deploy/.env, project lrfe)
 *   node demo/check-readiness.mjs --json          the same as JSON
 *   node demo/check-readiness.mjs --env <file> --project <name>    another install of the same compose file
 *
 * Checks the containers, the web app and the API through it, the API docs (profile docs), the demo
 * users (without signing anyone in: their accounts and the demo password are checked inside the
 * identity container), the AI for reading scans (without spending), the demo document set, the
 * data already there, and anchoring. Prints ✓ ready, ! worth a look, ✗ not ready, each with what to
 * do. Exits 0 when nothing is ✗, else 1. Never prints a secret: the values of the secret settings
 * (passwords, secrets, keys, tokens) are masked in everything it prints.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(REPO, 'deploy');
const DOCUMENTS = join(REPO, 'demo', 'documents');

/** The value after a command-line option, or the fallback; an option without a value stops the run. */
function option(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) {
    console.error(
      `${name} needs a value. Usage: node demo/check-readiness.mjs [--json] [--env <file>] [--project <name>]`,
    );
    process.exit(2);
  }
  return args[i + 1];
}

const asJson = process.argv.includes('--json');
const envFile = resolve(option('--env', join(DEPLOY, '.env')));
const project = option('--project', 'lrfe');
/** How the fix lines name docker compose: plainly for the install in deploy/, else with its project and settings. */
const composeCmd =
  project === 'lrfe' && envFile === join(DEPLOY, '.env')
    ? 'docker compose'
    : `docker compose -p ${project} --env-file ${envFile}`;

/** The demo users identity creates with SEED_DEMO_PASSWORD (backend/services/identity/src/seed.js). */
const DEMO_USERS = [
  {email: 'e.shivute@deeds.gov.na', role: 'supervisor'},
  {email: 'k.iipinge@deeds.gov.na', role: 'scan operator'},
  {email: 'a.mwandingi@deeds.gov.na', role: 'reviewer'},
  {email: 'j.gawaseb@deeds.gov.na', role: 'records officer'},
  {email: 'm.nakale@oag.gov.na', role: 'auditor'},
  {email: 'p.hamutenya@deeds.gov.na', role: 'administrator'},
  {email: 's.nangolo@deeds.gov.na', role: 'scan operator'},
  {email: 't.iita@deeds.gov.na', role: 'reviewer'},
  {email: 'w.beukes@deeds.gov.na', role: 'reviewer, auditor'},
  {email: 'h.haimbodi@deeds.gov.na', role: 'records officer'},
  {email: 'd.garoeb@deeds.gov.na', role: 'scan operator, reviewer'},
  // not active in the demo data, on purpose (Administration shows them)
  {
    email: 'f.katjiuongua@deeds.gov.na',
    role: 'records officer',
    status: 'Suspended',
  },
  {email: 's.uirab@oag.gov.na', role: 'auditor', status: 'Invited'},
  {email: 'l.tjiueza@deeds.gov.na', role: 'reviewer', status: 'Invited'},
];

/** The containers that use the data volumes; OpenBao and the blockchain node are not among them. */
const APP_SERVICES =
  'web gateway identity edrms bpm intake land-records audit db-setup nats postgres';

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const results = [];
let secrets = [];

/** Every value of the .env file that could be a secret, replaced in text that is printed. */
function mask(text) {
  let out = String(text ?? '');
  for (const secret of secrets) out = out.split(secret).join('***');
  return out;
}

function report(group, status, item, detail = '', fix = '') {
  results.push({group, status, item, detail: mask(detail), fix: mask(fix)});
}

// ------------------------------------------------------------------------------------------- setup

/** The settings of the install, read the way docker compose reads them (quotes, "export", CRLF, comments). */
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

/** docker compose for this install, with only what docker needs from this shell. */
function compose(composeArgs, {input, extraEnv = {}} = {}) {
  const keep = [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'XDG_RUNTIME_DIR',
  ];
  const env = Object.fromEntries(
    keep.filter(k => process.env[k]).map(k => [k, process.env[k]]),
  );
  const res = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--env-file',
      envFile,
      '-f',
      join(DEPLOY, 'docker-compose.yml'),
      ...composeArgs,
    ],
    {
      cwd: DEPLOY,
      env: {...env, ...extraEnv},
      input,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return {ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? ''};
}

/**
 * Runs a small Node program inside a service's container. The program prints one JSON line last
 * and reports its own failure as {error}. Secret values are passed by name only (`-e NAME`), from
 * this process's environment, never on a command line.
 */
function inContainer(service, program, secretEnv = {}) {
  const passEnv = Object.keys(secretEnv).flatMap(k => ['-e', k]);
  const wrapped = `try {\n${program}\n} catch (err) {\n    console.log(JSON.stringify({ error: String(err.cause?.code ?? err.code ?? err.message).slice(0, 160) }));\n}`;
  const res = compose(
    ['exec', '-T', ...passEnv, service, 'node', '--input-type=module', '-'],
    {input: wrapped, extraEnv: secretEnv},
  );
  const last = res.out.trim().split('\n').pop();
  try {
    return JSON.parse(last);
  } catch {
    return {
      error: res.ok
        ? 'unreadable answer'
        : `${service} cannot run the check (is it running?)`,
    };
  }
}

async function get(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    return {status: res.status, text: await res.text()};
  } catch (err) {
    return {status: 0, error: err.cause?.code ?? err.name};
  }
}

const profilesOf = env =>
  (env.COMPOSE_PROFILES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// ------------------------------------------------------------------------------------------ checks

/** @return {boolean} whether identity is up, so its accounts can be read */
function checkContainers(env) {
  const profiles = profilesOf(env);
  const expected = [
    'db-setup',
    'nats',
    'identity',
    'edrms',
    'bpm',
    'intake',
    'land-records',
    'audit',
    'gateway',
    'web',
  ];
  if (profiles.includes('postgres')) expected.unshift('postgres');
  if (profiles.includes('bao')) expected.push('openbao');
  if (profiles.includes('blockchain')) expected.push('cardano');
  if (profiles.includes('docs')) expected.push('docs');

  const res = compose(['ps', '--all', '--format', 'json']);
  if (!res.ok) {
    report(
      'Containers',
      FAIL,
      'docker compose',
      'cannot list the containers',
      `Is Docker running? systemctl --user start docker, then ${composeCmd} up -d`,
    );
    return false;
  }
  let rows;
  try {
    rows = JSON.parse(res.out || '[]');
  } catch {
    rows = res.out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)); // newer compose: one object per line
  }
  const byService = new Map(rows.map(row => [row.Service, row]));
  for (const service of expected) {
    const row = byService.get(service);
    if (!row) {
      report('Containers', FAIL, service, 'not created', `${composeCmd} up -d`);
    } else if (service === 'db-setup') {
      const done = row.State === 'exited' && row.ExitCode === 0;
      report(
        'Containers',
        done ? OK : FAIL,
        service,
        done ? 'database set up' : `${row.State}, exit ${row.ExitCode}`,
        done ? '' : `${composeCmd} logs db-setup`,
      );
    } else if (row.State === 'running' && row.Health === 'starting') {
      report(
        'Containers',
        WARN,
        service,
        'starting',
        'Wait a minute and run the check again',
      );
    } else {
      const healthy =
        row.State === 'running' && (!row.Health || row.Health === 'healthy');
      report(
        'Containers',
        healthy ? OK : FAIL,
        service,
        `${row.State}${row.Health ? `, ${row.Health}` : ''}`,
        healthy
          ? ''
          : `${composeCmd} logs --tail 50 ${service}; then ${composeCmd} up -d`,
      );
    }
  }
  if (env.LRFE_VERSION) report('Containers', OK, 'version', env.LRFE_VERSION);
  return byService.get('identity')?.State === 'running';
}

async function checkApps(env) {
  const web = `http://127.0.0.1:${env.LRFE_HTTP_PORT || 8080}`;
  const page = await get(`${web}/`);
  report(
    'Apps',
    page.status === 200 ? OK : FAIL,
    `web app ${web}`,
    page.status ? `HTTP ${page.status}` : page.error,
    page.status === 200 ? '' : `${composeCmd} ps web; ${composeCmd} logs web`,
  );
  let org = null;
  try {
    org = JSON.parse((await get(`${web}/config.json`)).text);
  } catch {
    // reported below
  }
  const orgLine = org
    ? `${org.orgName ?? '(default name)'}${org.orgSubtitle ? ` · ${org.orgSubtitle}` : ''}`
    : 'missing: the app shows its defaults';
  report('Apps', org ? OK : WARN, 'site settings (config.json)', orgLine);

  // one call per service through the web app and the gateway: "sign-in needed" (401) means it answers
  const servicePaths = [
    ['identity', '/api/auth/me'],
    ['edrms', '/api/documents'],
    ['bpm', '/api/tasks'],
    ['intake', '/api/intake/batches'],
    ['land-records', '/api/records'],
    ['audit', '/api/audit/anchoring/wallet'],
  ];
  for (const [service, path] of servicePaths) {
    const res = await get(`${web}${path}`);
    // 503 from audit: it answers, but its wallet is not readable (reported under Anchoring); from the gateway
    // for any other service, that service is not reachable
    const answers =
      [200, 401].includes(res.status) ||
      (service === 'audit' && res.status === 503);
    report(
      'Apps',
      answers ? OK : FAIL,
      `API: ${service}`,
      res.status ? `HTTP ${res.status} on ${path}` : res.error,
      answers ? '' : `${composeCmd} logs --tail 50 ${service} gateway`,
    );
  }
  if (profilesOf(env).includes('docs')) {
    const port = env.LRFE_DOCS_PORT || 3510;
    const docs = await get(`http://127.0.0.1:${port}/`);
    report(
      'Apps',
      docs.status === 200 ? OK : FAIL,
      `API docs :${port}`,
      docs.status ? `HTTP ${docs.status}` : docs.error,
      docs.status === 200 ? '' : `${composeCmd} logs docs`,
    );
  } else {
    report(
      'Apps',
      WARN,
      'API docs',
      'off (add docs to COMPOSE_PROFILES to show them)',
    );
  }
}

/** Inside identity: the demo users' accounts, the demo password against each, and the data so far. */
const IDENTITY_PROGRAM = `
const { default: pg } = await import('/app/node_modules/pg/lib/index.js');
const { verifyPassword } = await import('/app/services/identity/src/crypto.js');
const emails = JSON.parse(process.env.DEMO_EMAILS);
const client = new pg.Client({ connectionString: process.env.DB_CONNECTION_STRING });
await client.connect();
const accounts = await client.query('SELECT email, status, "mfaEnrolled", "passwordHash" FROM identity."user" WHERE email = ANY($1)', [emails]);
const users = [];
for (const row of accounts.rows) {
    const password = row.passwordHash && process.env.DEMO_PW ? await verifyPassword(process.env.DEMO_PW, row.passwordHash) : null;
    users.push({ email: row.email, status: row.status, mfa: row.mfaEnrolled, password });
}
const counts = {};
const tables = [['batches', 'intake.batch'], ['scanned documents', 'intake.document'], ['filed documents', 'edrms.document'], ['land records', 'records.land_record']];
for (const [name, table] of tables) {
    const [schema, base] = table.split('.');
    counts[name] = Number((await client.query('SELECT count(*) FROM "' + schema + '"."' + base + '"')).rows[0].count);
}
await client.end();
console.log(JSON.stringify({ users, counts }));
`;

function checkUsersAndData(env) {
  const freshStart = profilesOf(env).includes('postgres')
    ? `${composeCmd} rm -sf ${APP_SERVICES}, then docker volume rm ${project}_pgdata ${project}_edrms-files ${project}_intake-files ${project}_natsdata, ` +
      `then ${composeCmd} up -d. OpenBao and the blockchain node keep running and keep their data (not down -v: it deletes the services' OpenBao logins)`
    : 'the database is an existing server: empty it there (its administrator), and the edrms-files and intake-files volumes';
  const answer = inContainer('identity', IDENTITY_PROGRAM, {
    DEMO_PW: env.SEED_DEMO_PASSWORD ?? '',
    DEMO_EMAILS: JSON.stringify(DEMO_USERS.map(u => u.email)),
  });
  if (answer.error) {
    report(
      'Demo users',
      FAIL,
      'identity',
      `cannot read the accounts: ${answer.error}`,
      `${composeCmd} ps identity; ${composeCmd} logs identity`,
    );
    return;
  }
  if (!env.SEED_DEMO_PASSWORD) {
    report(
      'Demo users',
      FAIL,
      'demo password',
      'SEED_DEMO_PASSWORD is not set in .env',
      `Set it in .env, then ${composeCmd} up -d (the demo users are created on start)`,
    );
  }
  const found = new Map(answer.users.map(u => [u.email, u]));
  for (const {email, role, status = 'Active'} of DEMO_USERS) {
    const user = found.get(email);
    if (!user) {
      report(
        'Demo users',
        FAIL,
        email,
        `${role}: not found`,
        `Set SEED_DEMO_PASSWORD in .env and recreate identity: ${composeCmd} up -d --force-recreate identity`,
      );
    } else if (user.status !== 'Active') {
      const asIntended = user.status === status;
      report(
        'Demo users',
        asIntended ? OK : WARN,
        email,
        `${role}: ${user.status}${asIntended ? ', as in the demo data' : ''} (cannot sign in)`,
        asIntended
          ? ''
          : 'An administrator can reactivate the user (Administration → Users)',
      );
    } else if (!env.SEED_DEMO_PASSWORD) {
      continue; // reported once above
    } else if (!user.password) {
      report(
        'Demo users',
        FAIL,
        email,
        `${role}: the demo password does not match`,
        'The password was changed, or the users were created with another SEED_DEMO_PASSWORD: reset it (backend/README.md, reset-password)',
      );
    } else {
      report(
        'Demo users',
        user.mfa ? OK : WARN,
        email,
        `${role}: ${user.mfa ? 'authenticator set up' : 'authenticator not set up yet'}`,
        user.mfa
          ? ''
          : 'Sign in once before the demo and set up the authenticator app',
      );
    }
  }
  const counts = Object.entries(answer.counts)
    .map(([name, n]) => `${n} ${name}`)
    .join(', ');
  const any = Object.values(answer.counts).some(n => n > 0);
  report(
    'Data',
    any ? WARN : OK,
    'already in the install',
    counts,
    any
      ? `Fine to continue with it (intake refuses a demo document it has seen before). For a fresh start: ${freshStart}. This also removes the authenticator set-ups.`
      : '',
  );
}

/** Inside intake: its AI settings, and whether the AI accepts its key (listing the models is free). */
const INTAKE_PROGRAM = `
const key = process.env.GEMINI_API_KEY;
let answer = 'no key';
if (key) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(8000) });
    answer = res.status;
}
console.log(JSON.stringify({ provider: process.env.EXTRACTION_PROVIDER, answer, crossCheck: process.env.JEV_ENABLED === 'true' }));
`;

function checkAi(env) {
  const provider = env.EXTRACTION_PROVIDER || 'mock';
  if (provider === 'mock') {
    report(
      'Reading scans',
      WARN,
      'AI',
      'mock: every scan gets the same canned answer',
      'EXTRACTION_PROVIDER=gemini and GEMINI_API_KEY in .env for real reading',
    );
    return;
  }
  if (!env.GEMINI_API_KEY) {
    report(
      'Reading scans',
      FAIL,
      'AI',
      `${provider}: no API key`,
      `Set GEMINI_API_KEY in .env, then ${composeCmd} up -d`,
    );
    return;
  }
  const answer = inContainer('intake', INTAKE_PROGRAM);
  if (answer.error) {
    report(
      'Reading scans',
      FAIL,
      'AI service',
      `not reachable from intake: ${answer.error}`,
      "Check the server's internet access, and that intake runs",
    );
  } else if (answer.provider !== provider || answer.answer === 'no key') {
    report(
      'Reading scans',
      FAIL,
      'AI',
      'the running intake has other settings than .env',
      `${composeCmd} up -d (recreates intake with the settings)`,
    );
  } else if (answer.answer !== 200) {
    report(
      'Reading scans',
      FAIL,
      'AI',
      `the AI refuses the key (HTTP ${answer.answer})`,
      `Check GEMINI_API_KEY in .env (wrong, revoked or without access), then ${composeCmd} up -d`,
    );
  } else {
    report(
      'Reading scans',
      OK,
      'AI',
      `${provider}, key accepted${answer.crossCheck ? ', cross-check on' : ''}`,
    );
  }
}

function checkDocuments() {
  const sums = join(DOCUMENTS, 'SHA256SUMS');
  if (!existsSync(sums)) {
    report(
      'Demo documents',
      FAIL,
      'demo/documents',
      'SHA256SUMS missing',
      'git checkout demo/documents',
    );
    return;
  }
  const lines = readFileSync(sums, 'utf8').trim().split('\n');
  const changed = [];
  for (const line of lines) {
    const [sum, file] = line.split(/\s+/);
    const path = join(DOCUMENTS, file);
    if (
      !existsSync(path) ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== sum
    ) {
      changed.push(file);
    }
  }
  report(
    'Demo documents',
    changed.length ? FAIL : OK,
    'demo/documents',
    changed.length
      ? `missing or changed: ${changed.join(', ')}`
      : `${lines.length} documents, unchanged`,
    changed.length
      ? 'git checkout demo/documents (or node demo/documents/generate.mjs)'
      : '',
  );
}

async function checkAnchoring(env) {
  if (!env.CARDANO_PROVIDER) {
    report(
      'Anchoring',
      WARN,
      'blockchain',
      'off: the Anchorings screens stay empty',
    );
    return;
  }
  const res = await get(
    `http://127.0.0.1:${env.LRFE_HTTP_PORT || 8080}/api/audit/anchoring/wallet`,
  );
  let wallet = null;
  try {
    wallet = JSON.parse(res.text);
  } catch {
    // reported below
  }
  if (res.status !== 200 || !wallet?.address) {
    report(
      'Anchoring',
      FAIL,
      'wallet',
      `cannot be read${res.status ? ` (HTTP ${res.status})` : ''}`,
      `${composeCmd} logs --tail 50 audit (with OpenBao: is it unsealed? README.md, "Anchoring for the demo")`,
    );
    return;
  }
  report('Anchoring', OK, 'wallet', `readable: ${wallet.address}`);
  const chain = inContainer('audit', AUDIT_PROGRAM, {
    LRFE_CHECK_ADDRESS: wallet.address,
  });
  if (chain.error) {
    report(
      'Anchoring',
      FAIL,
      'blockchain node',
      `not reachable from audit: ${chain.error}`,
      `${composeCmd} logs --tail 50 cardano`,
    );
    return;
  }
  // the audit service's own rule for "synced" (backend/services/audit/src/cardano/drivers.js)
  const synced = Math.floor(chain.synchronization * 10000) / 100;
  if (chain.synchronization < 0.9999) {
    report(
      'Anchoring',
      FAIL,
      'blockchain node',
      `syncing: ${synced} %`,
      `Wait until it reaches 100 % (${composeCmd} logs -f cardano)`,
    );
  } else {
    report('Anchoring', OK, 'blockchain node', `synced (${chain.network})`);
  }
  const minimum = Number(env.ANCHOR_MIN_BALANCE_ADA || 5);
  const funds = `${chain.ada.toLocaleString('en', {maximumFractionDigits: 2})} ADA`;
  if (chain.ada < minimum) {
    report(
      'Anchoring',
      FAIL,
      'funds',
      `${funds}, at least ${minimum} needed`,
      `Send test ADA (${chain.network}) to ${wallet.address}`,
    );
  } else {
    report(
      'Anchoring',
      OK,
      'funds',
      `${funds} (at least ${minimum} needed; each batch costs about 0.2 ADA)`,
    );
  }
}

/** Runs in the audit container: the node's sync state and the wallet's funds, from Ogmios. */
const AUDIT_PROGRAM = `
const url = process.env.OGMIOS_URL;
const health = await (await fetch(url + '/health', { signal: AbortSignal.timeout(8000) })).json();
const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'queryLedgerState/utxo', params: { addresses: [process.env.LRFE_CHECK_ADDRESS] }, id: 1 })
});
const { result, error } = await res.json();
if (error) throw new Error(error.message);
const lovelace = result.reduce((sum, u) => sum + BigInt(u.value.ada.lovelace), 0n);
console.log(JSON.stringify({ synchronization: health.networkSynchronization, network: health.network, ada: Number(lovelace) / 1e6 }));
`;

// ------------------------------------------------------------------------------------------ output

function print() {
  const mark = {[OK]: '✓', [WARN]: '!', [FAIL]: '✗'};
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n${group}`);
    }
    console.log(
      `  ${mark[r.status]} ${r.item}${r.detail ? ` — ${r.detail}` : ''}`,
    );
    if (r.fix && r.status !== OK) console.log(`      → ${r.fix}`);
  }
  const fails = results.filter(r => r.status === FAIL).length;
  const warns = results.filter(r => r.status === WARN).length;
  console.log(
    `\n${fails ? `NOT READY: ${fails} to fix` : 'READY'}${warns ? ` (${warns} worth a look)` : ''}`,
  );
}

if (!existsSync(envFile)) {
  report(
    'Settings',
    FAIL,
    envFile,
    'not found',
    'cp deploy/.env.example deploy/.env and fill it in (deploy/README.md)',
  );
} else {
  const env = readEnv(envFile);
  // the secret settings (passwords, secrets, keys, tokens), longest first, masked in everything printed
  secrets = Object.entries(env)
    .filter(([k, v]) => /PASSWORD|SECRET|KEY|TOKEN/.test(k) && v.length >= 4)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  const identityUp = checkContainers(env);
  await checkApps(env);
  if (identityUp) checkUsersAndData(env);
  checkAi(env);
  checkDocuments();
  await checkAnchoring(env);
}
if (asJson) {
  console.log(
    JSON.stringify(
      {ready: !results.some(r => r.status === FAIL), results},
      null,
      2,
    ),
  );
} else print();
process.exit(results.some(r => r.status === FAIL) ? 1 : 0);
