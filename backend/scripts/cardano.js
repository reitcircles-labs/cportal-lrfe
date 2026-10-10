#!/usr/bin/env node
/**
 * Local Cardano node and Ogmios for the audit service's anchoring (API-662), installed and run as
 * the portal's own user, like OpenBao:
 *
 *   npm run cardano                  asks: development or production system?
 *   npm run cardano -- --dev         development: install (first run), start the node, then Ogmios
 *   npm run cardano -- --prod        production: refuses, see scripts/README.md "Cardano node: installation rules"
 *   npm run cardano -- --dev --install   only download them
 *
 * Development and test only, on the preview test network (CARDANO_NETWORK=preview, or preprod).
 * The first run downloads the official cardano-node release (checked against the release's SHA-256
 * sums) and Ogmios (checked against the SHA-256 pinned below; Ogmios publishes none) into
 * backend/.tools/ (in .gitignore). The pair is the one Ogmios was tested with.
 *
 * Data lives outside git in ~/data/cportal-lrfe/cardano/<network> (CARDANO_DATA_DIR), private to
 * this user: the chain database, the node's socket, the network's configuration (copied once from
 * the release) and the logs. Nothing listens on a public address: the node runs as a client only
 * (DiffusionMode InitiatorOnly: it connects out to its peers and accepts no connections), and Ogmios
 * listens on 127.0.0.1 (OGMIOS_PORT, default 1337). Sync progress is printed every 30 seconds.
 * Ctrl+C stops both.
 *
 * If Ogmios already answers on its port (a node started separately), that one is used.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '11.0.1';
const OGMIOS_VERSION = '7.0.0';
const OGMIOS_SHA256 = { x64: 'a4d07112dbbacf9a302970b6f6f7d35aa06c9a9edf013dff5547f6a7afee295e' };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, '.tools');
const README = join(ROOT, 'scripts', 'README.md');
const RULES = `${relative(process.cwd(), README) || README} → "Cardano node: installation rules"`;
const network = (process.env.CARDANO_NETWORK || 'preview').toLowerCase();
const ogmiosPort = Number(process.env.OGMIOS_PORT || 1337);
const dataDir = process.env.CARDANO_DATA_DIR || join(homedir(), 'data', 'cportal-lrfe', 'cardano', network);
const args = process.argv.slice(2);

// ---------------------------------------------------------------- development or production?

async function systemKind() {
    if (args.includes('--prod')) return 'prod';
    if (args.includes('--dev')) return 'dev';
    if (!process.stdin.isTTY) {
        console.error('Say which system this is: npm run cardano -- --dev (development) or --prod (production).');
        process.exit(2);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        for (;;) {
            const a = (await rl.question('Is this a development or a production system? [dev/prod] ')).trim().toLowerCase();
            if (['dev', 'development', 'd'].includes(a)) return 'dev';
            if (['prod', 'production', 'p'].includes(a)) return 'prod';
        }
    } catch {
        console.error('\nNo answer: nothing installed.');
        process.exit(2);
    } finally { rl.close(); }
}

if (await systemKind() === 'prod') {
    console.error([
        'Not installed: on a production system the Cardano node does not run as the portal\'s user.',
        'An administrator runs cardano-node and Ogmios as a dedicated "cardano" user and system service,',
        'on mainnet with enough memory and disk, monitored and backed up.',
        `Read: ${RULES}`
    ].join('\n'));
    process.exit(2);
}
if (!['preview', 'preprod'].includes(network)) {
    console.error(`CARDANO_NETWORK=${network}: this script runs the test networks only (preview, preprod). Mainnet: ${RULES}`);
    process.exit(2);
}

// ---------------------------------------------------------------- install (first run)

if (platform() !== 'linux' || arch() !== 'x64') {
    console.error(`No download for ${platform()}/${arch()} here: install cardano-node ${NODE_VERSION} and Ogmios ${OGMIOS_VERSION} yourself.`);
    process.exit(1);
}
const nodeDir = join(TOOLS, `cardano-node-${NODE_VERSION}`);
const nodeBin = join(nodeDir, 'bin', 'cardano-node');
const ogmiosDir = join(TOOLS, `ogmios-${OGMIOS_VERSION}`);
const ogmiosBin = join(ogmiosDir, 'bin', 'ogmios');

async function download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function installNode() {
    const name = `cardano-node-${NODE_VERSION}-linux-amd64.tar.gz`;
    const base = `https://github.com/IntersectMBO/cardano-node/releases/download/${NODE_VERSION}`;
    console.log(`Downloading ${name} (about 200 MB, first run only)…`);
    const [archive, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/cardano-node-${NODE_VERSION}-sha256sums.txt`)]);
    const expected = sums.toString().split('\n').find(l => l.trim().endsWith(name))?.split(/\s+/)[0];
    const actual = sha256(archive);
    if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${name} (expected ${expected}, got ${actual}): not installed`);
    unpack(archive, name, nodeDir, (file) => execFileSync('tar', ['-xzf', file, '-C', nodeDir]));
    if (!existsSync(nodeBin)) throw new Error(`${nodeBin} missing after unpacking`);
    console.log(`Installed ${nodeBin}`);
}

async function installOgmios() {
    const name = `ogmios-v${OGMIOS_VERSION}-x86_64-linux.zip`;
    console.log(`Downloading ${name} (first run only)…`);
    const archive = await download(`https://github.com/CardanoSolutions/ogmios/releases/download/v${OGMIOS_VERSION}/${name}`);
    const actual = sha256(archive);
    if (actual !== OGMIOS_SHA256.x64) throw new Error(`Checksum mismatch for ${name} (expected ${OGMIOS_SHA256.x64}, got ${actual}): not installed`);
    unpack(archive, name, ogmiosDir, (file) => execFileSync('unzip', ['-oq', file, '-d', ogmiosDir]));
    chmodSync(ogmiosBin, 0o755);
    console.log(`Installed ${ogmiosBin}`);
}

function unpack(archive, name, dir, extract) {
    mkdirSync(dir, { recursive: true });
    const file = join(TOOLS, name);
    writeFileSync(file, archive);
    try { extract(file); } finally { rmSync(file, { force: true }); }
}

try {
    if (!existsSync(nodeBin)) await installNode();
    if (!existsSync(ogmiosBin)) await installOgmios();
} catch (err) {
    console.error(`Could not install: ${err.message}`);
    process.exit(1);
}
if (args.includes('--install')) process.exit(0);

// ---------------------------------------------------------------- start

const health = async () => {
    try {
        const res = await fetch(`http://127.0.0.1:${ogmiosPort}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok ? await res.json() : null;
    } catch { return null; }
};

if (await health()) {
    console.log(`Ogmios already answers on 127.0.0.1:${ogmiosPort} (a node started separately): the services will use that one.`);
    process.exit(0);
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const configDir = join(dataDir, 'config');
if (!existsSync(join(configDir, 'config.json'))) {
    // copied once: a later node upgrade does not silently change this network's configuration
    cpSync(join(nodeDir, 'share', network), configDir, { recursive: true });
}
// a client only: it connects out to its peers and runs no server that others could connect to,
// also no metrics server (the release's tracing opens Prometheus and EKG ports); plain log lines
const configFile = join(configDir, 'config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const root = config.TraceOptions?.[''];
const backends = root?.backends?.filter(b => !/^(EKGBackend|PrometheusSimple)/.test(b)).map(b => b.replace('HumanFormatColoured', 'HumanFormatUncoloured'));
const patched = { ...config, DiffusionMode: 'InitiatorOnly', ...(root && { TraceOptions: { ...config.TraceOptions, '': { ...root, backends } } }) };
if (JSON.stringify(patched) !== JSON.stringify(config)) writeFileSync(configFile, JSON.stringify(patched, null, 2));
const socket = join(dataDir, 'node.socket');
const children = [];
let stopping = false;
let failed = false;          // one of them stopped by itself (not Ctrl+C)
function stop(signal = 'SIGINT') {
    if (stopping) return;
    stopping = true;
    for (const c of children) c.kill(signal);
    setTimeout(() => { for (const c of children) c.kill('SIGKILL'); process.exit(0); }, 15_000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig));

function start(name, bin, argv, log) {
    const out = createWriteStream(join(dataDir, log), { flags: 'a' });
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('exit', (code, signal) => {
        if (!stopping) {
            failed = true;
            console.error(`${name} stopped (${signal || `exit ${code}`}); see ${join(dataDir, log)}`);
        }
        stop();
        if (children.every(c => c.exitCode !== null || c.signalCode)) process.exit(failed ? 1 : 0);
    });
    children.push(child);
    return child;
}

console.log(`Cardano ${network}: node ${NODE_VERSION} (client only, no listening port), data in ${dataDir}`);
rmSync(socket, { force: true });
start('cardano-node', nodeBin, [
    'run', '--config', join(configDir, 'config.json'), '--topology', join(configDir, 'topology.json'),
    '--database-path', join(dataDir, 'db'), '--socket-path', socket
], 'node.log');

for (let i = 0; !existsSync(socket); i++) {
    if (stopping) await new Promise(() => {});      // the node's exit handler ends the process
    if (i === 300) { console.error(`The node did not open its socket within 10 minutes; see ${join(dataDir, 'node.log')}`); stop(); }
    await new Promise(r => setTimeout(r, 2000));
}
console.log(`Ogmios ${OGMIOS_VERSION} on http://127.0.0.1:${ogmiosPort}`);
start('ogmios', ogmiosBin, [
    '--node-socket', socket, '--node-config', join(configDir, 'config.json'), '--host', '127.0.0.1', '--port', String(ogmiosPort)
], 'ogmios.log');

let synced = false;
const report = async () => {
    const h = await health();
    if (!h) return;
    const pct = Math.floor((h.networkSynchronization ?? 0) * 10000) / 100;
    const tip = h.lastKnownTip?.slot ?? '?';
    if (pct >= 100 && !synced) { synced = true; console.log(`Cardano ${network}: in sync (slot ${tip}, era ${h.currentEra})`); }
    else if (!synced) console.log(`Cardano ${network}: syncing ${pct}% (slot ${tip}, era ${h.currentEra ?? '?'})`);
};
setTimeout(report, 10_000);
setInterval(report, 30_000).unref?.();
