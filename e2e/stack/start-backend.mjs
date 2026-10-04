#!/usr/bin/env node
/**
 * Start the five backend services for the end-to-end tests: everything in memory (a fresh, known
 * state each run), the AI replaced by its canned answer, emails written to files, the demo users
 * seeded, and a NATS server of its own as the event bus between them (backend/scripts/nats.js).
 * Playwright runs this (see playwright.config.ts); it can also be run by hand to keep a test stack
 * up between runs: `node stack/start-backend.mjs`, then `E2E_REUSE=1 npx playwright test`.
 *
 * Each service runs in its own empty folder under .stack/, so it does not read the developer's
 * backend/services/<name>/.env: the tests never touch a real database, bucket, AI or mail server.
 *
 * E2E_DB=postgres (npm run test:postgres) runs the same services on PostgreSQL instead of memory,
 * with documents stored as files: a private, throwaway PostgreSQL instance is created under
 * .stack/pg with the server binaries already installed on the machine (PG_BIN, or the newest
 * /usr/lib/postgresql/<version>/bin), on its own port, TCP only, and removed with the stack.
 * The gateway starts last, once the others answer /health, so "gateway up" means "stack ready".
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { BACKEND_DIR, BAO_DIR, DEMO_PASSWORD, MAIL_DIR, PORTS, STACK_DIR, WEB_URL } from './config.mjs';

const url = (name) => `http://127.0.0.1:${PORTS[name]}`;
const COMMON = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'warn',
    JWT_SECRET: 'e2e-only-jwt-secret-not-used-anywhere-else',
    IDENTITY_URL: url('identity'), EDRMS_URL: url('edrms'), BPM_URL: url('bpm'), INTAKE_URL: url('intake'),
    EVENT_BUS_DRIVER: 'nats', NATS_URL: `nats://127.0.0.1:${PORTS.nats}`,
    IDENTITY_STORE: 'memory', EDRMS_STORE: 'memory', EDRMS_STORAGE: 'memory', BPM_STORE: 'memory',
    INTAKE_STORE: 'memory', INTAKE_STORAGE: 'memory', EXTRACTION_PROVIDER: 'mock',
    SEED_DEMO_PASSWORD: DEMO_PASSWORD,
    MAIL_TRANSPORT: 'file', MAIL_FILE_DIR: MAIL_DIR, MAIL_FROM: 'Deeds Registry (e2e) <noreply@example.com>',
    IDENTITY_INVITE_URL_BASE: `${WEB_URL}/#/invite`,
    // plain http on localhost: a Secure cookie would not be sent back by every client
    COOKIE_SECURE: 'false'
};
// E2E_JEV=fake: the automatic cross-check on, with the fake judge (fixed answers, nothing sent)
if (process.env.E2E_JEV === 'fake') Object.assign(COMMON, { JEV_ENABLED: 'true', JEV_PROVIDER: 'fake' });
// E2E_BAO=fake: stored files encrypted, with in-memory keys instead of OpenBao (nothing sent).
// E2E_BAO=real: a throwaway OpenBao for this run (scripts/bao.js --dev on its own port and folder);
// edrms and intake encrypt with it, each logged in with its own AppRole (SERVICE_ENV, set once it is up).
const E2E_BAO = process.env.E2E_BAO || 'off';
if (!['off', 'fake', 'real'].includes(E2E_BAO)) throw new Error(`E2E_BAO must be fake or real, got "${E2E_BAO}"`);
if (E2E_BAO === 'fake') Object.assign(COMMON, { EDRMS_ENCRYPTION: 'fake', INTAKE_ENCRYPTION: 'fake' });
const SERVICE_ENV = {};
const SERVICES = ['identity', 'edrms', 'bpm', 'intake'];
const POSTGRES = process.env.E2E_DB === 'postgres';
const pgData = join(STACK_DIR, 'pg');
if (POSTGRES) {
    Object.assign(COMMON, {
        IDENTITY_STORE: 'postgres', EDRMS_STORE: 'postgres', BPM_STORE: 'postgres', INTAKE_STORE: 'postgres',
        DB_CONNECTION_STRING: `postgres://lrfe@127.0.0.1:${PORTS.postgres}/e2e`, DB_SYNC: 'true',
        EDRMS_STORAGE: 'local', EDRMS_LOCAL_DIR: join(STACK_DIR, 'files', 'edrms'),
        INTAKE_STORAGE: 'local', INTAKE_LOCAL_DIR: join(STACK_DIR, 'files', 'intake')
    });
}

/** Directory with initdb/pg_ctl/psql: PG_BIN, or the newest /usr/lib/postgresql/<version>/bin. */
function pgBin() {
    if (process.env.PG_BIN) return process.env.PG_BIN;
    const root = '/usr/lib/postgresql';
    const versions = existsSync(root) ? readdirSync(root).filter(v => existsSync(join(root, v, 'bin', 'initdb'))).sort((a, b) => Number(b) - Number(a)) : [];
    if (!versions.length) throw new Error('E2E_DB=postgres needs PostgreSQL server binaries: install postgresql, or set PG_BIN to the folder with initdb and pg_ctl');
    return join(root, versions[0], 'bin');
}

/** A fresh PostgreSQL instance for this run only, with an empty database `e2e`. */
function startPostgres() {
    const bin = pgBin();
    const run = (cmd, args) => execFileSync(join(bin, cmd), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    run('initdb', ['-D', pgData, '-U', 'lrfe', '--auth=trust', '-E', 'UTF8', '--no-locale']);
    // TCP only (-k ''): a socket path under .stack/ can exceed the 107-byte limit; no fsync: data is thrown away
    run('pg_ctl', ['-D', pgData, '-o', `-p ${PORTS.postgres} -h 127.0.0.1 -k '' -c fsync=off -c synchronous_commit=off`, '-l', join(STACK_DIR, 'pg.log'), '-w', 'start']);
    run('psql', ['-h', '127.0.0.1', '-p', String(PORTS.postgres), '-U', 'lrfe', '-d', 'postgres', '-qc', 'CREATE DATABASE e2e']);
    console.log(`e2e PostgreSQL ${run('pg_ctl', ['--version']).toString().trim().replace(/^pg_ctl \(PostgreSQL\) /, '')} on port ${PORTS.postgres}`);
}

function stopPostgres() {
    if (!POSTGRES || !existsSync(join(pgData, 'postmaster.pid'))) return;
    try { execFileSync(join(pgBin(), 'pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

// A PostgreSQL left running by an interrupted run would keep its port: stop it before clearing.
if (existsSync(join(STACK_DIR, 'pg', 'postmaster.pid'))) {
    try { execFileSync(join(pgBin(), 'pg_ctl'), ['-D', join(STACK_DIR, 'pg'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* not running */ }
}
// Likewise a throwaway OpenBao left by an interrupted run (only ours: matched by its config path).
if (existsSync(join(BAO_DIR, 'openbao.hcl'))) {
    try { execFileSync('pkill', ['-f', join(BAO_DIR, 'openbao.hcl')], { stdio: 'ignore' }); } catch { /* not running */ }
}
rmSync(STACK_DIR, { recursive: true, force: true });
mkdirSync(MAIL_DIR, { recursive: true });

// Only what a node process needs from this shell; nothing else (DB_*, AWS_*, GEMINI_*) leaks in.
const base = Object.fromEntries(['PATH', 'HOME', 'TZ', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const children = [];

function start(name) {
    const cwd = join(STACK_DIR, name);
    mkdirSync(cwd, { recursive: true });
    const child = spawn(process.execPath, [join(BACKEND_DIR, 'services', name, 'src', 'index.js')], {
        cwd, env: { ...base, ...COMMON, ...SERVICE_ENV[name], PORT: String(PORTS[name]) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream.on('data', chunk => out.write(String(chunk).replace(/^(?=.)/gm, `[${name}] `)));
    }
    child.on('exit', (code, signal) => {
        if (stopping) return;
        console.error(`[${name}] exited (${signal || `code ${code}`}); stopping the test stack`);
        stop(1);
    });
    children.push(child);
}

async function waitHealthy(name, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            if ((await fetch(`${url(name)}/health`)).ok) return;
        } catch { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`${name} did not answer ${url(name)}/health within ${timeoutMs / 1000}s`);
}

let stopping = false;
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const c of children) c.kill('SIGTERM');
    stopPostgres();
    setTimeout(() => { for (const c of children) c.kill('SIGKILL'); process.exit(code); }, 5000).unref();
    Promise.all(children.map(c => c.exitCode !== null ? null : new Promise(r => c.once('exit', r)))).then(() => process.exit(code));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

/** The event bus: the backend's own launcher, on the test port, its JetStream data under .stack/. */
function startNats() {
    const child = spawn(process.execPath, [join(BACKEND_DIR, 'scripts', 'nats.js')], {
        env: { ...base, NATS_PORT: String(PORTS.nats), NATS_MONITOR_PORT: '0', NATS_STORE_DIR: join(STACK_DIR, 'nats') },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    // nats-server is chatty at start; show only problems
    child.stderr.on('data', chunk => String(chunk).split('\n').filter(l => /\[(ERR|FTL|WRN)\]|Could not|Checksum/.test(l))
        .forEach(l => process.stderr.write(`[nats] ${l}\n`)));
    child.stdout.on('data', chunk => String(chunk).split('\n').filter(l => /Downloading|Installed/.test(l))
        .forEach(l => process.stdout.write(`[nats] ${l}\n`)));
    child.on('exit', (code, signal) => {
        if (stopping) return;
        console.error(`[nats] exited (${signal || `code ${code}`}); stopping the test stack`);
        stop(1);
    });
    children.push(child);
}

/**
 * E2E_BAO=real: the backend's own OpenBao launcher (development mode) on the test port, its data
 * under .stack/bao. It initialises, unseals and creates the keys, policies and AppRoles; resolves
 * once that is done, then hands each service its own login.
 */
function startBao(timeoutMs = 180_000) {
    const child = spawn(process.execPath, [join(BACKEND_DIR, 'scripts', 'bao.js'), '--dev'], {
        env: { ...base, BAO_PORT: String(PORTS.bao), BAO_DATA_DIR: BAO_DIR }, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('exit', (code, signal) => {
        if (stopping) return;
        console.error(`[bao] exited (${signal || `code ${code}`}); stopping the test stack`);
        stop(1);
    });
    children.push(child);
    // OpenBao logs harmless [ERROR] lines on first initialisation and shutdown: show bao.js's own errors only
    child.stderr.on('data', chunk => String(chunk).split('\n').filter(l => /^OpenBao: |Could not/.test(l))
        .forEach(l => process.stderr.write(`[bao] ${l}\n`)));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`OpenBao was not ready within ${timeoutMs / 1000}s`)), timeoutMs);
        child.stdout.on('data', chunk => {
            for (const l of String(chunk).split('\n')) {
                if (/Downloading|Installed|unsealed\.|Document encryption ready/.test(l)) process.stdout.write(`[bao] ${l}\n`);
                if (/Document encryption ready/.test(l)) {
                    clearTimeout(timer);
                    const login = (name, key) => ({
                        [`${name.toUpperCase()}_ENCRYPTION`]: 'bao', BAO_ADDR: `http://127.0.0.1:${PORTS.bao}`, BAO_KEY_NAME: key,
                        BAO_ROLE_ID: readFileSync(join(BAO_DIR, 'approle', `${name}-role-id`), 'utf8').trim(),
                        BAO_SECRET_ID_FILE: join(BAO_DIR, 'approle', `${name}-secret-id`)
                    });
                    SERVICE_ENV.edrms = login('edrms', 'edrms-files');
                    SERVICE_ENV.intake = login('intake', 'intake-files');
                    resolve();
                }
            }
        });
    });
}

async function waitPort(port, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const open = await new Promise(resolve => {
            const socket = connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
            socket.on('error', () => resolve(false));
        });
        if (open) return;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`nothing listening on port ${port} after ${timeoutMs / 1000}s`);
}

try {
    if (POSTGRES) startPostgres();
} catch (err) {
    console.error(`could not start PostgreSQL: ${err.stderr?.toString().trim() || err.message}`);
    stopPostgres();
    process.exit(1);
}
startNats();
try {
    if (E2E_BAO === 'real') await startBao();   // the first run downloads OpenBao
    await waitPort(PORTS.nats);   // the first run downloads nats-server, hence the long wait
    for (const name of SERVICES) start(name);
    await Promise.all(SERVICES.map(n => waitHealthy(n)));
    start('gateway');
    await waitHealthy('gateway');
    console.log(`e2e backend ready: gateway ${url('gateway')}`);
} catch (err) {
    console.error(err.message);
    stop(1);
}
