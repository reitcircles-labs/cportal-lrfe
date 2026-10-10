#!/usr/bin/env node
/**
 * How the local Cardano node (scripts/cardano.js) is doing, from its logs and Ogmios:
 *
 *   npm run cardano:status                  sync, tip, speed, time left, disk, recent warnings
 *   npm run cardano:status -- --log [n]     also the node's last n log lines (default 30)
 *   npm run cardano:status -- --follow      the node's log as it is written (Notice and above; Ctrl+C ends)
 *
 * Reads only: it never starts or stops anything. Same settings as cardano.js (CARDANO_NETWORK,
 * CARDANO_DATA_DIR, OGMIOS_PORT).
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const network = (process.env.CARDANO_NETWORK || 'preview').toLowerCase();
const ogmiosPort = Number(process.env.OGMIOS_PORT || 1337);
const dataDir = process.env.CARDANO_DATA_DIR || join(homedir(), 'data', 'cportal-lrfe', 'cardano', network);
const nodeLog = join(dataDir, 'node.log');
const ogmiosLog = join(dataDir, 'ogmios.log');
const args = process.argv.slice(2);

// [2026-10-10 10:39:04.96Z][host:ChainDB.AddBlockEvent.AddedToCurrentChain](Notice,22) Chain extended, … at slot 5827220
const LINE = /^\[([^\]]+)\]\[[^:\]]*:([^\]]+)\]\((\w+),\d+\)\s*(.*)$/;
const SEVERITIES = ['Debug', 'Info', 'Notice', 'Warning', 'Error', 'Critical', 'Alert', 'Emergency'];
const atLeast = (severity, min) => SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(min);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function parse(raw) {
    const m = LINE.exec(plain(raw));
    return m && { time: new Date(m[1].replace(' ', 'T')), namespace: m[2], severity: m[3], message: m[4] };
}

/** The last `bytes` of a file as lines (the log grows to hundreds of MB; never read it whole). */
function tailLines(file, bytes = 1 << 20) {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return start > 0 ? lines.slice(1) : lines;       // the first line may be cut off
}

// output piped into head or less that closes early: just stop
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });

/** Warnings the node logs all the time and that need no action. */
const NORMAL_WHILE_SYNCING = {
    'BlockchainTime.CurrentSlotUnknown': 'normal while syncing',
    'Net.PeerSelection.Actions.ConnectionError': 'normal: some peers do not answer, the node tries others'
};

const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hms = (date) => date.toISOString().slice(11, 19);
function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '?';
    const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
}

// ---------------------------------------------------------------- follow

if (args.includes('--follow')) {
    if (!existsSync(nodeLog)) { console.error(`No log yet: ${nodeLog}`); process.exit(1); }
    console.log(`Following ${nodeLog} (Notice and above). Ctrl+C ends.`);
    const tail = spawn('tail', ['-n', '0', '-F', nodeLog], { stdio: ['ignore', 'pipe', 'inherit'] });
    let rest = '';
    tail.stdout.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const raw of lines) {
            const e = parse(raw);
            if (e && atLeast(e.severity, 'Notice')) console.log(`${hms(e.time)} ${e.severity.padEnd(7)} ${short(e.message)}`);
        }
    });
    process.on('SIGINT', () => { tail.kill(); process.exit(0); });
    await new Promise(() => {});
}

// ---------------------------------------------------------------- status

async function health() {
    try {
        const res = await fetch(`http://127.0.0.1:${ogmiosPort}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

console.log(`Cardano ${network} (data in ${dataDir})`);
if (!existsSync(dataDir)) {
    console.log('  Not installed here yet: npm run cardano -- --dev');
    process.exit(1);
}

const h = await health();
if (!h) {
    console.log(`  Ogmios does not answer on 127.0.0.1:${ogmiosPort}: the node is not running (npm run cardano -- --dev).`);
} else {
    const sync = h.networkSynchronization ?? 0;
    const pct = Math.floor(sync * 10000) / 100;
    const tip = h.lastKnownTip || {};
    const ago = h.lastTipUpdate ? Math.round((Date.now() - Date.parse(h.lastTipUpdate)) / 1000) : null;
    console.log(`  Ogmios     ${h.version ?? '?'} on 127.0.0.1:${ogmiosPort}, node ${h.connectionStatus ?? '?'}`);
    console.log(`  Sync       ${pct >= 100 ? 'in sync' : `${pct}%`}  (slot ${tip.slot ?? '?'}, block ${tip.height ?? '?'}, era ${h.currentEra ?? '?'}, epoch ${h.currentEpoch ?? '?'})`);
    console.log(`  Last block ${ago === null ? '?' : `${ago} s ago`}`);

    // speed from the node's own "Chain extended … at slot N" lines over the last minutes
    const blocks = tailLines(nodeLog).map(parse).filter(e => e?.namespace.endsWith('AddedToCurrentChain'))
        .map(e => ({ time: e.time, slot: Number(/at slot (\d+)/.exec(e.message)?.[1]) })).filter(e => e.slot);
    const last = blocks.at(-1);
    const first = last && blocks.find(b => last.time - b.time <= 5 * 60_000);
    if (pct < 100 && first && last.time > first.time && sync > 0) {
        const perSecond = (last.slot - first.slot) / ((last.time - first.time) / 1000);
        const target = tip.slot / sync;                     // the network's tip, from Ogmios' estimate
        console.log(`  Speed      ${Math.round(perSecond).toLocaleString('en')} slots/s (last ${duration((last.time - first.time) / 1000)}); about ${duration((target - tip.slot) / perSecond)} left`);
    }
}

try {
    const du = (p) => execFileSync('du', ['-sh', p]).toString().split('\t')[0];
    console.log(`  Disk       chain ${du(join(dataDir, 'db'))}, logs ${du(nodeLog)} + ${du(ogmiosLog)}`);
} catch { /* not created yet */ }

// recent warnings and errors (node and Ogmios), one line per kind: how often, the last one
const kinds = new Map();
const note = (key, time, text) => {
    const k = kinds.get(key) || { count: 0 };
    kinds.set(key, { count: k.count + 1, time, text });
};
for (const e of tailLines(nodeLog).map(parse)) {
    if (e && atLeast(e.severity, 'Warning')) note(`node ${e.severity} ${e.namespace}`, hms(e.time), e.message);
}
for (const raw of tailLines(ogmiosLog, 256 << 10)) {
    let e;
    try { e = JSON.parse(raw); } catch { continue; }      // not a JSON line
    if (atLeast(e.severity, 'Warning')) note(`ogmios ${e.severity} ${Object.keys(e.message || {})[0] ?? ''}`, e.timestamp.slice(11, 19), JSON.stringify(e.message));
}
if (!kinds.size) console.log('  Recent warnings: none');
else {
    console.log('  Recent warnings (last 1 MB of the logs):');
    for (const [key, k] of [...kinds].sort((a, b) => a[1].time.localeCompare(b[1].time))) {
        const normal = NORMAL_WHILE_SYNCING[key.split(' ')[2]];
        console.log(`    ${k.time} ${key} ×${k.count}${normal ? ` (${normal})` : ''}\n      ${short(k.text, 140)}`);
    }
}

const i = args.indexOf('--log');
if (i >= 0) {
    const n = Number(args[i + 1]) || 30;
    console.log(`\nLast ${n} lines of ${nodeLog}:`);
    for (const raw of tailLines(nodeLog).slice(-n)) {
        const e = parse(raw);
        console.log(e ? `${hms(e.time)} ${e.severity.padEnd(7)} ${short(e.message)}` : short(plain(raw)));
    }
}
