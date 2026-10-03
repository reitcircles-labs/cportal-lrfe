#!/usr/bin/env node
/**
 * Local NATS server, the event bus between the services (EVENT_BUS_DRIVER=nats):
 *
 *   npm run nats                 start it on its own (npm run dev starts it with the services)
 *   NATS_PORT=4223 npm run nats  another port
 *   npm run nats -- --install    only download it (CI: the @lrfe/common tests then run against it)
 *
 * The first run downloads the official nats-server release for this machine into backend/.tools/
 * and checks it against the release's SHA-256 checksums; later runs start it straight away. It
 * listens on 127.0.0.1 only. JetStream (durable streams, for the audit trail later) is on, with its
 * data in backend/.tools/nats-data (NATS_STORE_DIR to change). Ctrl+C stops it.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v2.15.0';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, '.tools');
const port = Number(process.env.NATS_PORT || 4222);
const monitorPort = process.env.NATS_MONITOR_PORT === undefined ? 8222 : Number(process.env.NATS_MONITOR_PORT);
const storeDir = process.env.NATS_STORE_DIR || join(TOOLS, 'nats-data');

const OS = { linux: 'linux', darwin: 'darwin' }[platform()];
const CPU = { x64: 'amd64', arm64: 'arm64' }[arch()];
if (!OS || !CPU) {
    console.error(`No nats-server download for ${platform()}/${arch()} here: install nats-server yourself and put it on PATH, or run it with Docker (docker run -p 4222:4222 nats -js).`);
    process.exit(1);
}
const name = `nats-server-${VERSION}-${OS}-${CPU}`;
const binary = join(TOOLS, name, 'nats-server');

async function download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function install() {
    const base = `https://github.com/nats-io/nats-server/releases/download/${VERSION}`;
    console.log(`Downloading ${name} (first run only)…`);
    const [archive, sums] = await Promise.all([download(`${base}/${name}.tar.gz`), download(`${base}/SHA256SUMS`)]);
    const expected = sums.toString().split('\n').find(l => l.trim().endsWith(`${name}.tar.gz`))?.split(/\s+/)[0];
    const actual = createHash('sha256').update(archive).digest('hex');
    if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${name}.tar.gz (expected ${expected}, got ${actual}): not installed`);
    mkdirSync(TOOLS, { recursive: true });
    const file = join(TOOLS, `${name}.tar.gz`);
    writeFileSync(file, archive);
    try {
        execFileSync('tar', ['-xzf', file, '-C', TOOLS]);
    } finally {
        rmSync(file, { force: true });
    }
    if (!existsSync(binary)) throw new Error(`${binary} missing after unpacking`);
    console.log(`Installed ${binary}`);
}

if (!existsSync(binary)) {
    try {
        await install();
    } catch (err) {
        console.error(`Could not install nats-server: ${err.message}`);
        process.exit(1);
    }
}

if (process.argv.includes('--install')) process.exit(0);

mkdirSync(storeDir, { recursive: true });
const args = ['-a', '127.0.0.1', '-p', String(port), '-js', '-sd', storeDir, '-n', 'lrfe-dev'];
if (monitorPort) args.push('-m', String(monitorPort));
const server = spawn(binary, args, { stdio: ['ignore', 'inherit', 'inherit'] });
server.on('exit', (code, signal) => process.exit(signal ? 0 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
