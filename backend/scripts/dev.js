#!/usr/bin/env node
/**
 * Run every backend service in watch mode from one terminal:
 *
 *   npm run dev                      NATS, all six services, and the API docs on http://localhost:3510
 *   npm run dev -- identity intake   only these (add `nats` for the event bus, `docs` for the API docs,
 *                                    `bao` for OpenBao; it is added anyway when one of them needs it)
 *
 * NATS (scripts/nats.js, port 4222) is the event bus between the services. When it is part of the
 * run, the services use it (EVENT_BUS_DRIVER=nats, NATS_URL), whatever their .env says; set
 * EVENT_BUS_DRIVER in the shell to choose otherwise (e.g. EVENT_BUS_DRIVER=log npm run dev).
 * The first run downloads nats-server into backend/.tools/.
 *
 * OpenBao (scripts/bao.js --dev, port 8200) is started first when a selected service encrypts with
 * it (EDRMS_ENCRYPTION=bao or INTAKE_ENCRYPTION=bao, in its .env or this shell), or when `bao` is
 * named. Those services wait for the vault at startup (up to a minute). If port 8200 is taken by an
 * OpenBao started separately, that one is used.
 *
 * Each service starts in its own directory, so it reads its own .env exactly as
 * `npm run dev:<name>` does. Output lines are prefixed with the service name. Ctrl+C stops all
 * of them; if one exits for good, the others are stopped too. (With --watch a crash does not
 * exit: node waits for a file change and restarts, so a typo does not take the others down.)
 * The API docs (scripts/docs-server.js) are optional: if they cannot start, the services keep running.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// gateway after the services it proxies to; docs last
const PROCESSES = {
    // the vault first, when a service encrypts with it; those services wait for it at startup
    bao: { cwd: ROOT, args: ['scripts/bao.js', '--dev'], optional: true },
    // the event bus; the services connect when it is up (and retry until then)
    nats: { cwd: ROOT, args: ['scripts/nats.js'], optional: true },
    identity: { cwd: join(ROOT, 'services', 'identity'), args: ['--watch', 'src/index.js'] },
    edrms: { cwd: join(ROOT, 'services', 'edrms'), args: ['--watch', 'src/index.js'] },
    bpm: { cwd: join(ROOT, 'services', 'bpm'), args: ['--watch', 'src/index.js'] },
    intake: { cwd: join(ROOT, 'services', 'intake'), args: ['--watch', 'src/index.js'] },
    'land-records': { cwd: join(ROOT, 'services', 'land-records'), args: ['--watch', 'src/index.js'] },
    gateway: { cwd: join(ROOT, 'services', 'gateway'), args: ['--watch', 'src/index.js'] },
    // reads docs/openapi.yaml on every request: `npm run docs` updates it without a restart
    docs: { cwd: ROOT, args: ['scripts/docs-server.js'], optional: true }
};
const SERVICES = Object.keys(PROCESSES);
const COLORS = [31, 37, 36, 33, 35, 32, 94, 34, 90];

const wanted = process.argv.slice(2);
const unknown = wanted.filter(s => !SERVICES.includes(s));
if (unknown.length) {
    console.error(`Unknown service(s): ${unknown.join(', ')}. Choose from: ${SERVICES.join(', ')}`);
    process.exit(1);
}
/** The services (among `selected`) whose files are encrypted with OpenBao: their .env, or this shell. */
function baoUsers(selected) {
    return selected.filter(name => {
        const setting = { edrms: 'EDRMS_ENCRYPTION', intake: 'INTAKE_ENCRYPTION' }[name];
        if (!setting) return false;
        const file = join(PROCESSES[name].cwd, '.env');
        const fromFile = existsSync(file) ? dotenv.parse(readFileSync(file))[setting] : undefined;
        return (process.env[setting] ?? fromFile ?? 'off').toLowerCase() === 'bao';
    });
}
// Everything but OpenBao by default; OpenBao when named, or when a selected service needs it
const selected = wanted.length ? SERVICES.filter(s => wanted.includes(s)) : SERVICES.filter(s => s !== 'bao');
const needBao = baoUsers(selected);
const names = needBao.length && !selected.includes('bao') ? ['bao', ...selected] : selected;
if (needBao.length && !wanted.includes('bao')) console.log(`OpenBao is started too: ${needBao.map(n => `${n} encrypts its files with it`).join(', ')}.`);

const width = Math.max(...names.map(n => n.length));
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const label = (name) => {
    const text = name.padEnd(width);
    return color ? `\x1b[${COLORS[SERVICES.indexOf(name)]}m${text}\x1b[0m │ ` : `${text} │ `;
};

// A PORT set in this shell would override every service's .env (dotenv never overrides), and all
// five would try to bind the same port.
const env = { ...process.env };
delete env.PORT;
// With NATS in this run, point the services at it (a shell setting still wins over this).
if (names.includes('nats') && !process.env.EVENT_BUS_DRIVER) {
    env.EVENT_BUS_DRIVER = 'nats';
    env.NATS_URL ??= `nats://127.0.0.1:${process.env.NATS_PORT || 4222}`;
}

const children = new Map();
let stopping = false;

function pipe(stream, out, prefix, name) {
    let rest = '';
    stream.on('data', chunk => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
            out.write(prefix + line + '\n');
            const busy = line.match(/EADDRINUSE: address already in use (\S+)/);
            if (busy) out.write(`${prefix}↳ ${busy[1]} is taken, probably by a copy started separately (${name === 'docs' ? 'npm run docs:serve' : `npm run dev:${name}`}). Stop it, or leave ${name} out: npm run dev -- <the others>\n`);
            if (name === 'nats' && /address already in use/.test(line)) out.write(`${prefix}↳ port ${process.env.NATS_PORT || 4222} is taken, probably by another NATS (npm run nats, Docker); the services will use that one\n`);
            if (name === 'bao' && /already answers/.test(line)) out.write(`${prefix}↳ another OpenBao is running on that port (npm run bao); the services will use that one\n`);
        }
    });
    stream.on('end', () => { if (rest) out.write(prefix + rest + '\n'); });
}

function stopAll(signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    for (const child of children.values()) child.kill(signal);
    // a service that ignores the signal must not keep the terminal busy
    setTimeout(() => { for (const child of children.values()) child.kill('SIGKILL'); }, 8000).unref();
}

for (const name of names) {
    const { cwd, args, optional } = PROCESSES[name];
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(name, child);
    pipe(child.stdout, process.stdout, label(name), name);
    pipe(child.stderr, process.stderr, label(name), name);
    child.on('exit', (code, signal) => {
        children.delete(name);
        if (!stopping && optional) {
            console.error(`${label(name)}exited (${signal || `code ${code}`}); the services keep running`);
        } else if (!stopping) {
            console.error(`${label(name)}exited (${signal || `code ${code}`}); stopping the other services`);
            process.exitCode = code || 1;
            stopAll();
        }
        if (!children.size) process.exit();
    });
}

console.log(`Starting ${names.join(', ')}. Ctrl+C stops all.`);
process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
