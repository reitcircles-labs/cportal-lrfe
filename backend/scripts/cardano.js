#!/usr/bin/env node
/**
 * Local Cardano node and Ogmios for the audit service's anchoring (API-662), installed and run as
 * the portal's own user, like OpenBao:
 *
 *   npm run cardano                  asks: development or production system?
 *   npm run cardano -- --dev         development: install (first run), then start the node and Ogmios in
 *                                    the background, supervised (API-677), and return
 *   npm run cardano -- --dev --foreground   the same in this terminal (Ctrl+C stops), for debugging
 *   npm run cardano -- --stop        stop the background node and Ogmios cleanly
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
 * listens on 127.0.0.1 (OGMIOS_PORT, default 1337). Sync progress is written every 30 seconds to
 * <data>/supervisor.log (to the terminal with --foreground).
 *
 * If Ogmios already answers on its port (a node started separately), that one is used.
 */
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {arch, homedir, platform} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

const NODE_VERSION = '11.0.1';
const OGMIOS_VERSION = '7.0.0';
const OGMIOS_SHA256 = {
  x64: 'a4d07112dbbacf9a302970b6f6f7d35aa06c9a9edf013dff5547f6a7afee295e',
};
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, '.tools');
const README = join(ROOT, 'scripts', 'README.md');
const RULES = `${relative(process.cwd(), README) || README} → "Cardano node: installation rules"`;
const network = (process.env.CARDANO_NETWORK || 'preview').toLowerCase();
const ogmiosPort = Number(process.env.OGMIOS_PORT || 1337);
const dataDir =
  process.env.CARDANO_DATA_DIR ||
  join(homedir(), 'data', 'cportal-lrfe', 'cardano', network);
const args = process.argv.slice(2);

const stateFile = join(dataDir, 'supervisor.json');
const supervisorLog = join(dataDir, 'supervisor.log');

/** The running supervisor's state, or null (none, or a stale file from one that died). */
function supervisor() {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    process.kill(state.pid, 0);
    // the pid is still this script, not a process that got the number since
    const cmd = readFileSync(`/proc/${state.pid}/cmdline`, 'utf8');
    if (!cmd.includes('cardano.js') || !/--supervise|--foreground/.test(cmd)) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

if (args.includes('--stop')) {
  const s = supervisor();
  if (!s) {
    console.log('The Cardano node is not running under the supervisor.');
    process.exit(0);
  }
  console.log(
    `Stopping the Cardano node (supervisor pid ${s.pid}); the node shuts down cleanly, this can take a minute…`,
  );
  process.kill(s.pid, 'SIGTERM');
  for (let i = 0; i < 180 && supervisor(); i++) {
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(
    supervisor() ? `Still stopping; see ${supervisorLog}` : 'Stopped.',
  );
  process.exit(0);
}

// ---------------------------------------------------------------- development or production?

async function systemKind() {
  if (args.includes('--prod')) return 'prod';
  if (args.includes('--dev')) return 'dev';
  if (!process.stdin.isTTY) {
    console.error(
      'Say which system this is: npm run cardano -- --dev (development) or --prod (production).',
    );
    process.exit(2);
  }
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    for (;;) {
      const a = (
        await rl.question(
          'Is this a development or a production system? [dev/prod] ',
        )
      )
        .trim()
        .toLowerCase();
      if (['dev', 'development', 'd'].includes(a)) return 'dev';
      if (['prod', 'production', 'p'].includes(a)) return 'prod';
    }
  } catch {
    console.error('\nNo answer: nothing installed.');
    process.exit(2);
  } finally {
    rl.close();
  }
}

if ((await systemKind()) === 'prod') {
  console.error(
    [
      "Not installed: on a production system the Cardano node does not run as the portal's user.",
      'An administrator runs cardano-node and Ogmios as a dedicated "cardano" user and system service,',
      'on mainnet with enough memory and disk, monitored and backed up.',
      `Read: ${RULES}`,
    ].join('\n'),
  );
  process.exit(2);
}
if (!['preview', 'preprod'].includes(network)) {
  console.error(
    `CARDANO_NETWORK=${network}: this script runs the test networks only (preview, preprod). Mainnet: ${RULES}`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------- install (first run)

if (platform() !== 'linux' || arch() !== 'x64') {
  console.error(
    `No download for ${platform()}/${arch()} here: install cardano-node ${NODE_VERSION} and Ogmios ${OGMIOS_VERSION} yourself.`,
  );
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
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function installNode() {
  const name = `cardano-node-${NODE_VERSION}-linux-amd64.tar.gz`;
  const base = `https://github.com/IntersectMBO/cardano-node/releases/download/${NODE_VERSION}`;
  console.log(`Downloading ${name} (about 200 MB, first run only)…`);
  const [archive, sums] = await Promise.all([
    download(`${base}/${name}`),
    download(`${base}/cardano-node-${NODE_VERSION}-sha256sums.txt`),
  ]);
  const expected = sums
    .toString()
    .split('\n')
    .find(l => l.trim().endsWith(name))
    ?.split(/\s+/)[0];
  const actual = sha256(archive);
  if (!expected || expected !== actual) {
    throw new Error(
      `Checksum mismatch for ${name} (expected ${expected}, got ${actual}): not installed`,
    );
  }
  unpack(archive, name, nodeDir, file =>
    execFileSync('tar', ['-xzf', file, '-C', nodeDir]),
  );
  if (!existsSync(nodeBin)) {
    throw new Error(`${nodeBin} missing after unpacking`);
  }
  console.log(`Installed ${nodeBin}`);
}

async function installOgmios() {
  const name = `ogmios-v${OGMIOS_VERSION}-x86_64-linux.zip`;
  console.log(`Downloading ${name} (first run only)…`);
  const archive = await download(
    `https://github.com/CardanoSolutions/ogmios/releases/download/v${OGMIOS_VERSION}/${name}`,
  );
  const actual = sha256(archive);
  if (actual !== OGMIOS_SHA256.x64) {
    throw new Error(
      `Checksum mismatch for ${name} (expected ${OGMIOS_SHA256.x64}, got ${actual}): not installed`,
    );
  }
  unpack(archive, name, ogmiosDir, file =>
    execFileSync('unzip', ['-oq', file, '-d', ogmiosDir]),
  );
  chmodSync(ogmiosBin, 0o755);
  console.log(`Installed ${ogmiosBin}`);
}

function unpack(archive, name, dir, extract) {
  mkdirSync(dir, {recursive: true});
  const file = join(TOOLS, name);
  writeFileSync(file, archive);
  try {
    extract(file);
  } finally {
    rmSync(file, {force: true});
  }
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
    const res = await fetch(`http://127.0.0.1:${ogmiosPort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- supervisor (API-677)
//
// By default the node and Ogmios run under a supervisor detached from the terminal (like nohup and
// setsid): closing the terminal or stopping `npm run dev` leaves them running, so the next start
// needs no check of the stored chain. The supervisor restarts the node when it exits by itself
// (waits growing from 5 s to 5 min) or has had no new block for CARDANO_STALL_MINUTES (10), and
// Ogmios when it exits or stays disconnected from the node for 3 minutes.
// Its state is in <data>/supervisor.json, its output in <data>/supervisor.log.

const running = supervisor();
if (running && !args.includes('--supervise')) {
  console.log(
    `The Cardano node already runs ${running.detached ? 'in the background' : 'in a terminal (--foreground)'} (supervisor pid ${running.pid}, since ${running.startedAt}).`,
  );
  console.log(
    '  Status: npm run cardano:status · Stop: npm run cardano -- --stop',
  );
  process.exit(0);
}
if (!args.includes('--supervise') && (await health())) {
  console.log(
    `Ogmios already answers on 127.0.0.1:${ogmiosPort} (a node started separately): the services will use that one.`,
  );
  process.exit(0);
}

mkdirSync(dataDir, {recursive: true, mode: 0o700});
chmodSync(dataDir, 0o700);

if (!args.includes('--foreground') && !args.includes('--supervise')) {
  // start the supervisor detached: its own session, no terminal, output to its log file
  const out = openSync(supervisorLog, 'a');
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...args, '--supervise'],
    {detached: true, stdio: ['ignore', out, out], env: process.env},
  );
  child.unref();
  for (let i = 0; i < 50 && supervisor()?.pid !== child.pid; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  const now = supervisor();
  if (now && now.pid !== child.pid) {
    console.log(
      `The Cardano node already runs in the background (supervisor pid ${now.pid}): started at the same moment elsewhere.`,
    );
    process.exit(0);
  }
  if (!now) {
    console.error(`The supervisor did not start; see ${supervisorLog}`);
    process.exit(1);
  }
  console.log(
    [
      `Cardano ${network}: node and Ogmios started in the background (supervisor pid ${child.pid}); they keep running when this terminal closes.`,
      `  Progress: npm run cardano:status (-- --follow) · Log: ${supervisorLog}`,
      '  Stop:     npm run cardano -- --stop',
    ].join('\n'),
  );
  process.exit(0);
}

const configDir = join(dataDir, 'config');
if (!existsSync(join(configDir, 'config.json'))) {
  // copied once: a later node upgrade does not silently change this network's configuration
  cpSync(join(nodeDir, 'share', network), configDir, {recursive: true});
}
// a client only: it connects out to its peers and runs no server that others could connect to,
// also no metrics server (the release's tracing opens Prometheus and EKG ports); plain log lines
const configFile = join(configDir, 'config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const root = config.TraceOptions?.[''];
const backends = root?.backends
  ?.filter(b => !/^(EKGBackend|PrometheusSimple)/.test(b))
  .map(b => b.replace('HumanFormatColoured', 'HumanFormatUncoloured'));
const patched = {
  ...config,
  DiffusionMode: 'InitiatorOnly',
  ...(root && {
    TraceOptions: {...config.TraceOptions, '': {...root, backends}},
  }),
};
if (JSON.stringify(patched) !== JSON.stringify(config)) {
  writeFileSync(configFile, JSON.stringify(patched, null, 2));
}
const socket = join(dataDir, 'node.socket');

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const say = msg => console.log(`${stamp()} ${msg}`);
const state = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  network,
  detached: args.includes('--supervise'),
  restarts: {node: 0, ogmios: 0},
  lastRestart: null,
};
// best effort: a full disk must not take the supervisor down (the node keeps running without it)
const saveState = () => {
  try {
    writeFileSync(stateFile, JSON.stringify(state, null, 2), {mode: 0o600});
  } catch (err) {
    say(`could not write ${stateFile}: ${err.message}`);
  }
};
// one supervisor per data directory, also when two starts race: the state file is the lock
try {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
} catch (err) {
  const other = supervisor();
  if (err.code === 'EEXIST' && other && other.pid !== process.pid) {
    say(`another supervisor runs already (pid ${other.pid}); this one stops`);
    process.exit(0);
  }
  saveState(); // a stale file from one that died
}

const procs = {node: null, ogmios: null};
const backoff = {node: 0, ogmios: 0};
let stopping = false;
let restarting = null; // the node being restarted (stalled): asked once, not every round
const wait = name => Math.min(300_000, 5000 * 2 ** backoff[name]);

function launch(name, bin, argv, log, onExit) {
  // straight into its log file, and in its own process group: it does not depend on the supervisor's
  // pipes, and a Ctrl+C in the terminal (--foreground) reaches only the supervisor, which stops it once
  const fd = openSync(join(dataDir, log), 'a');
  const child = spawn(bin, argv, {stdio: ['ignore', fd, fd], detached: true});
  closeSync(fd);
  child.on('error', err => say(`${name} could not be started: ${err.message}`));
  const started = Date.now();
  child.on('exit', (code, signal) => {
    procs[name] = null;
    if (stopping) return finish();
    // a run of 10 minutes or more counts as healthy: the next restart waits the shortest time again
    if (Date.now() - started >= 600_000) backoff[name] = 0;
    onExit(code, signal);
  });
  procs[name] = child;
  return child;
}

function restart(name, why, fn) {
  const ms = wait(name);
  backoff[name]++;
  state.restarts[name]++;
  state.lastRestart = {what: name, why, at: new Date().toISOString()};
  saveState();
  say(
    `${name === 'node' ? 'cardano-node' : 'Ogmios'} ${why}; starting it again in ${Math.round(ms / 1000)} s (restart ${state.restarts[name]}; see ${join(dataDir, name === 'node' ? 'node.log' : 'ogmios.log')})`,
  );
  setTimeout(() => {
    if (!stopping) fn();
  }, ms).unref?.();
}

function startNode() {
  say(
    `Cardano ${network}: node ${NODE_VERSION} (client only, no listening port), data in ${dataDir}`,
  );
  rmSync(socket, {force: true});
  launch(
    'node',
    nodeBin,
    [
      'run',
      '--config',
      join(configDir, 'config.json'),
      '--topology',
      join(configDir, 'topology.json'),
      '--database-path',
      join(dataDir, 'db'),
      '--socket-path',
      socket,
    ],
    'node.log',
    (code, signal) => {
      procs.ogmios?.kill('SIGTERM'); // it needs the node; started again with it
      restart('node', `stopped (${signal || `exit ${code}`})`, startNode);
    },
  );
  waitForSocket();
}

async function waitForSocket() {
  const node = procs.node;
  // after an unclean stop the node checks its stored chain first (API-670): this can take half an hour
  for (let i = 0; !existsSync(socket); i++) {
    if (stopping || procs.node !== node) return;
    if (i % 150 === 149) {
      say(
        'waiting for the node to open its socket (npm run cardano:status shows what it is doing)',
      );
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  startOgmios();
}

let disconnectedSince = null;
function startOgmios() {
  if (stopping || !procs.node || procs.ogmios) return;
  say(`Ogmios ${OGMIOS_VERSION} on http://127.0.0.1:${ogmiosPort}`);
  disconnectedSince = null;
  launch(
    'ogmios',
    ogmiosBin,
    [
      '--node-socket',
      socket,
      '--node-config',
      join(configDir, 'config.json'),
      '--host',
      '127.0.0.1',
      '--port',
      String(ogmiosPort),
    ],
    'ogmios.log',
    (code, signal) => {
      if (procs.node) {
        restart('ogmios', `stopped (${signal || `exit ${code}`})`, startOgmios);
      }
    },
  );
}

function finish() {
  if (procs.node || procs.ogmios) return;
  try {
    if (JSON.parse(readFileSync(stateFile, 'utf8')).pid === process.pid) {
      rmSync(stateFile, {force: true});
    }
  } catch {
    /* gone */
  }
  say('stopped');
  process.exit(0);
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  say(
    `stopping (${signal}): the node shuts down cleanly, so the next start needs no check of its stored chain`,
  );
  procs.ogmios?.kill('SIGTERM');
  if (restarting !== procs.node) procs.node?.kill('SIGINT'); // already asked: a second SIGINT would stop it uncleanly
  // only if the node hangs: a forced stop means the chain is checked at the next start
  setTimeout(() => {
    for (const c of Object.values(procs)) c?.kill('SIGKILL');
  }, 120_000).unref();
  finish();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig));
if (args.includes('--supervise')) process.on('SIGHUP', () => {}); // no terminal to hang up on

startNode();

// no new block for this long while Ogmios is connected: the node hangs or has lost all its peers
const stallMs = Number(process.env.CARDANO_STALL_MINUTES || 10) * 60_000;
function restartNode(why) {
  const node = procs.node;
  if (!node || restarting === node) return;
  restarting = node;
  say(
    `cardano-node ${why}; restarting it (stopped by force if it does not stop within 2 minutes)`,
  );
  node.kill('SIGINT'); // a clean stop first: no check of the chain next time
  setTimeout(() => {
    if (procs.node === node) node.kill('SIGKILL');
  }, 120_000).unref();
}

let synced = false;
const watch = async () => {
  if (stopping) return;
  const h = await health();
  if (
    procs.node &&
    h?.connectionStatus === 'connected' &&
    h.lastTipUpdate &&
    Date.now() - Date.parse(h.lastTipUpdate) >= stallMs &&
    h.startTime &&
    Date.now() - Date.parse(h.startTime) >= stallMs
  ) {
    const minutes = Math.round(
      (Date.now() - Date.parse(h.lastTipUpdate)) / 60_000,
    );
    restartNode(
      `has had no new block for ${minutes} minute${minutes === 1 ? '' : 's'}`,
    );
    return;
  }
  // Ogmios up but not connected to the node (or not answering) for 3 minutes: restart it
  if (procs.ogmios) {
    const connected = h && h.connectionStatus === 'connected';
    if (connected) disconnectedSince = null;
    else if (!disconnectedSince) disconnectedSince = Date.now();
    else if (Date.now() - disconnectedSince >= 180_000) {
      disconnectedSince = null;
      say(
        `Ogmios ${h ? 'has been disconnected from the node' : 'has not answered'} for 3 minutes; restarting it`,
      );
      const ogmios = procs.ogmios;
      ogmios.kill('SIGTERM');
      setTimeout(() => {
        if (procs.ogmios === ogmios) ogmios.kill('SIGKILL');
      }, 30_000).unref();
    }
  }
  if (!h) return;
  const pct = Math.floor((h.networkSynchronization ?? 0) * 10000) / 100;
  const tip = h.lastKnownTip?.slot ?? '?';
  if (pct >= 100 && !synced) {
    synced = true;
    say(`Cardano ${network}: in sync (slot ${tip}, era ${h.currentEra})`);
  } else if (pct < 99.9 && synced) {
    synced = false;
  }
  if (!synced) {
    say(
      `Cardano ${network}: syncing ${pct}% (slot ${tip}, era ${h.currentEra ?? '?'})`,
    );
  }
};
setInterval(watch, 30_000);
