#!/usr/bin/env node
/**
 * Local OpenBao (the open-source fork of Vault), the project's secrets vault:
 *
 *   npm run bao                  asks: development or production system?
 *   npm run bao -- --dev         development: install (first run), start, unseal
 *   npm run bao -- --prod        production: refuses, see README.md "OpenBao: installation rules"
 *   npm run bao -- --dev --install   only download it
 *
 * Development only. The first run downloads the official OpenBao release for this machine into
 * backend/.tools/ (in .gitignore) and checks it against the release's SHA-256 checksums; later runs
 * start it straight away. Data (integrated Raft storage) lives outside git, in
 * ~/data/cportal-lrfe/openbao (BAO_DATA_DIR to change), private to this user. It listens on
 * 127.0.0.1 only (BAO_PORT, default 8200), without TLS. No memory locking: OpenBao 2.x never locks
 * memory (mlock was removed in 2.0 and `disable_mlock` is obsolete; Vault's advice for integrated
 * storage was disable_mlock = true anyway). With swap on, key material may reach swap: see README.
 *
 * The first start initialises the vault with a single unseal key and keeps the key and the root
 * token in dev-init.json in the data folder (readable by this user only): fine for development,
 * never for production. Later starts unseal with it. Ctrl+C stops OpenBao.
 *
 * Production: OpenBao must not run as the same user as the portal. An administrator installs it
 * as a dedicated user and service; the script only points to the rules.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const VERSION = '2.7.1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, '.tools');
const README = join(ROOT, 'scripts', 'README.md');
const RULES = `${relative(process.cwd(), README) || README} → "OpenBao: installation rules"`;
const port = Number(process.env.BAO_PORT || 8200);
const dataDir = process.env.BAO_DATA_DIR || join(homedir(), 'data', 'cportal-lrfe', 'openbao');
const addr = `http://127.0.0.1:${port}`;
const args = process.argv.slice(2);

// ---------------------------------------------------------------- development or production?

async function systemKind() {
    if (args.includes('--prod')) return 'prod';
    if (args.includes('--dev')) return 'dev';
    if (!process.stdin.isTTY) {
        console.error('Say which system this is: npm run bao -- --dev (development) or --prod (production).');
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
        console.error('\nNo answer: nothing installed.');      // Ctrl+C / Ctrl+D at the question
        process.exit(2);
    } finally { rl.close(); }
}

if (await systemKind() === 'prod') {
    console.error([
        'Not installed: on a production system OpenBao must not run as the same user as the portal.',
        'An administrator installs it as a dedicated "openbao" user and system service, with TLS,',
        'unseal keys held by named people (or an HSM), and snapshot backups.',
        `Read: ${RULES}`
    ].join('\n'));
    process.exit(2);
}

// ---------------------------------------------------------------- install (first run)

const OS = { linux: 'linux' }[platform()];
const CPU = { x64: 'amd64', arm64: 'arm64' }[arch()];
if (!OS || !CPU) {
    console.error(`No OpenBao download for ${platform()}/${arch()} here: install OpenBao yourself (https://openbao.org/downloads).`);
    process.exit(1);
}
const name = `openbao_${VERSION}_${OS}_${CPU}`;
const installDir = join(TOOLS, `openbao-${VERSION}`);
const binary = join(installDir, 'bao');

async function download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function install() {
    const base = `https://github.com/openbao/openbao/releases/download/v${VERSION}`;
    console.log(`Downloading ${name} (first run only)…`);
    const [archive, sums] = await Promise.all([download(`${base}/${name}.tar.gz`), download(`${base}/checksums.txt`)]);
    const expected = sums.toString().split('\n').find(l => l.trim().endsWith(`${name}.tar.gz`))?.split(/\s+/)[0];
    const actual = createHash('sha256').update(archive).digest('hex');
    if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${name}.tar.gz (expected ${expected}, got ${actual}): not installed`);
    mkdirSync(installDir, { recursive: true });
    const file = join(TOOLS, `${name}.tar.gz`);
    writeFileSync(file, archive);
    try {
        execFileSync('tar', ['-xzf', file, '-C', installDir]);
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
        console.error(`Could not install OpenBao: ${err.message}`);
        process.exit(1);
    }
}
if (args.includes('--install')) process.exit(0);

// ---------------------------------------------------------------- configure and start

// Initialising waits for the first Raft leader election (about 5 s): allow a minute per call
const api = async (path, init, timeoutMs = 60_000) => {
    const res = await fetch(`${addr}/v1/${path}`, { ...init, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(body.errors || body)}`);
    return body;
};
const sealStatus = () => api('sys/seal-status', undefined, 2000);

if (await sealStatus().then(() => true, () => false)) {
    console.error(`Something already answers on ${addr} (another OpenBao?). Stop it, or use another port: BAO_PORT=8210 npm run bao -- --dev`);
    process.exit(1);
}

mkdirSync(join(dataDir, 'raft'), { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const config = join(dataDir, 'openbao.hcl');
writeFileSync(config, `# Written by backend/scripts/bao.js: development only (no TLS, single node).
storage "raft" {
  path    = "${join(dataDir, 'raft')}"
  node_id = "bao-dev"
}
listener "tcp" {
  address     = "127.0.0.1:${port}"
  tls_disable = true
}
api_addr     = "${addr}"
cluster_addr = "http://127.0.0.1:${port + 1}"
# No disable_mlock: OpenBao 2.x never locks memory (mlock removed in 2.0, the setting is obsolete).
`, { mode: 0o600 });

const server = spawn(binary, ['server', `-config=${config}`], { stdio: ['ignore', 'inherit', 'inherit'] });
server.on('exit', (code, signal) => process.exit(signal ? 0 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

// ---------------------------------------------------------------- initialise (first start), unseal

const initFile = join(dataDir, 'dev-init.json');
try {
    let status;
    for (let i = 0; ; i++) {
        status = await sealStatus().catch(() => null);
        if (status) break;
        if (i >= 50) throw new Error(`OpenBao did not answer on ${addr}`);
        await new Promise(r => setTimeout(r, 200));
    }
    if (!status.initialized) {
        const init = await api('sys/init', { method: 'PUT', body: JSON.stringify({ secret_shares: 1, secret_threshold: 1 }) });
        writeFileSync(initFile, JSON.stringify({
            warning: 'DEVELOPMENT ONLY. Unseal key and root token of the local OpenBao; never use this setup in production.',
            addr, unsealKey: init.keys_base64[0], rootToken: init.root_token, createdAt: new Date().toISOString()
        }, null, 1) + '\n', { mode: 0o600 });
        console.log(`Initialised the vault; unseal key and root token in ${initFile} (this user only)`);
        status = await sealStatus();
    }
    if (status.sealed) {
        if (!existsSync(initFile)) throw new Error(`The vault is initialised but ${initFile} is missing (e.g. the first start was interrupted before the keys were saved), so it cannot be unsealed. Unseal it with its key (bao operator unseal), or, on a development system, delete ${dataDir} to start over`);
        const { unsealKey } = JSON.parse(readFileSync(initFile, 'utf8'));
        status = await api('sys/unseal', { method: 'PUT', body: JSON.stringify({ key: unsealKey }) });
        if (status.sealed) throw new Error('Unsealing failed: the key in dev-init.json does not belong to this vault');
    }
    console.log(`OpenBao ${VERSION} (development) on ${addr}: initialised, unsealed. Data in ${dataDir}.`);
    console.log(`  export BAO_ADDR=${addr}   # the root token is in ${initFile}`);
} catch (err) {
    console.error(`OpenBao: ${err.message}`);
    server.kill('SIGTERM');
    process.exitCode = 1;
}
