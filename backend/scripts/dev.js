#!/usr/bin/env node
/**
 * Run every backend service in watch mode from one terminal:
 *
 *   npm run dev                      all five services
 *   npm run dev -- identity intake   only these
 *
 * Each service starts in its own directory, so it reads its own .env exactly as
 * `npm run dev:<name>` does. Output lines are prefixed with the service name. Ctrl+C stops all
 * of them; if one exits for good, the others are stopped too. (With --watch a crash does not
 * exit: node waits for a file change and restarts, so a typo does not take the others down.)
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = ['identity', 'edrms', 'bpm', 'intake', 'gateway'];   // gateway last: it proxies to the rest
const COLORS = [36, 33, 35, 32, 34];

const wanted = process.argv.slice(2);
const unknown = wanted.filter(s => !SERVICES.includes(s));
if (unknown.length) {
    console.error(`Unknown service(s): ${unknown.join(', ')}. Choose from: ${SERVICES.join(', ')}`);
    process.exit(1);
}
const names = wanted.length ? SERVICES.filter(s => wanted.includes(s)) : SERVICES;

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

const children = new Map();
let stopping = false;

function pipe(stream, out, prefix) {
    let rest = '';
    stream.on('data', chunk => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
            out.write(prefix + line + '\n');
            const busy = line.match(/EADDRINUSE: address already in use (\S+)/);
            if (busy) out.write(`${prefix}↳ ${busy[1]} is taken, probably by a service started separately (npm run dev:<name>). Stop it, or leave this service out: npm run dev -- <other services>\n`);
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
    const child = spawn(process.execPath, ['--watch', 'src/index.js'], { cwd: join(ROOT, 'services', name), env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(name, child);
    pipe(child.stdout, process.stdout, label(name));
    pipe(child.stderr, process.stderr, label(name));
    child.on('exit', (code, signal) => {
        children.delete(name);
        if (!stopping) {
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
