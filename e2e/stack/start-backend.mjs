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
 * The gateway starts last, once the others answer /health, so "gateway up" means "stack ready".
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { BACKEND_DIR, DEMO_PASSWORD, MAIL_DIR, PORTS, STACK_DIR, WEB_URL } from './config.mjs';

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
const SERVICES = ['identity', 'edrms', 'bpm', 'intake'];

rmSync(STACK_DIR, { recursive: true, force: true });
mkdirSync(MAIL_DIR, { recursive: true });

// Only what a node process needs from this shell; nothing else (DB_*, AWS_*, GEMINI_*) leaks in.
const base = Object.fromEntries(['PATH', 'HOME', 'TZ', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const children = [];

function start(name) {
    const cwd = join(STACK_DIR, name);
    mkdirSync(cwd, { recursive: true });
    const child = spawn(process.execPath, [join(BACKEND_DIR, 'services', name, 'src', 'index.js')], {
        cwd, env: { ...base, ...COMMON, PORT: String(PORTS[name]) }, stdio: ['ignore', 'pipe', 'pipe']
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

startNats();
try {
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
