#!/usr/bin/env node
/**
 * Run every backend service in watch mode from one terminal:
 *
 *   npm run dev                      NATS, all seven services, and the API docs on http://localhost:3510
 *   npm run dev -- identity intake   only these (add `nats` for the event bus, `docs` for the API docs,
 *                                    `bao` for OpenBao, `cardano` for the Cardano node; each is added
 *                                    anyway when one of them needs it)
 *
 * NATS (scripts/nats.js, port 4222) is the event bus between the services. When it is part of the
 * run, the services use it (EVENT_BUS_DRIVER=nats, NATS_URL), whatever their .env says; set
 * EVENT_BUS_DRIVER in the shell to choose otherwise (e.g. EVENT_BUS_DRIVER=log npm run dev).
 * The first run downloads nats-server into backend/.tools/.
 *
 * OpenBao (scripts/bao.js --dev, port 8200) is started first when a selected service encrypts with
 * it (EDRMS_ENCRYPTION=bao or INTAKE_ENCRYPTION=bao, in its .env or this shell), when the audit
 * service anchors on Cardano (CARDANO_PROVIDER set: its wallet key is in OpenBao), or when `bao` is
 * named. Those services wait for the vault at startup (up to a minute). If port 8200 is taken by an
 * OpenBao started separately, that one is used.
 *
 * The Cardano node and Ogmios (scripts/cardano.js --dev, Ogmios on port 1337, API-662) are started
 * when the audit service anchors through them (CARDANO_PROVIDER=ogmios in its .env or this shell), or
 * when `cardano` is named. If Ogmios already answers on its port, that one is used. They run in the
 * background under their supervisor (API-677), so Ctrl+C here leaves them running; stop them with
 * `npm run cardano -- --stop`.
 *
 * Each service starts in its own directory, so it reads its own .env exactly as
 * `npm run dev:<name>` does. Output lines are prefixed with the service name. Ctrl+C stops all
 * of them; if one exits for good, the others are stopped too. (With --watch a crash does not
 * exit: node waits for a file change and restarts, so a typo does not take the others down.)
 * The API docs (scripts/docs-server.js) are optional: if they cannot start, the services keep running.
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// gateway after the services it proxies to; docs last
const PROCESSES = {
  // the vault first, when a service encrypts with it; those services wait for it at startup
  bao: {cwd: ROOT, args: ['scripts/bao.js', '--dev'], optional: true},
  // the local Cardano node and Ogmios, when the audit service anchors through them
  cardano: {cwd: ROOT, args: ['scripts/cardano.js', '--dev'], optional: true},
  // the event bus; the services connect when it is up (and retry until then)
  nats: {cwd: ROOT, args: ['scripts/nats.js'], optional: true},
  identity: {
    cwd: join(ROOT, 'services', 'identity'),
    args: ['--watch', 'src/index.js'],
  },
  edrms: {
    cwd: join(ROOT, 'services', 'edrms'),
    args: ['--watch', 'src/index.js'],
  },
  bpm: {cwd: join(ROOT, 'services', 'bpm'), args: ['--watch', 'src/index.js']},
  intake: {
    cwd: join(ROOT, 'services', 'intake'),
    args: ['--watch', 'src/index.js'],
  },
  'land-records': {
    cwd: join(ROOT, 'services', 'land-records'),
    args: ['--watch', 'src/index.js'],
  },
  audit: {
    cwd: join(ROOT, 'services', 'audit'),
    args: ['--watch', 'src/index.js'],
  },
  extracts: {
    cwd: join(ROOT, 'services', 'extracts'),
    args: ['--watch', 'src/index.js'],
  },
  gateway: {
    cwd: join(ROOT, 'services', 'gateway'),
    args: ['--watch', 'src/index.js'],
  },
  // reads docs/openapi.yaml on every request: `npm run docs` updates it without a restart
  docs: {cwd: ROOT, args: ['scripts/docs-server.js'], optional: true},
};
const SERVICES = Object.keys(PROCESSES);
const COLORS = [31, 92, 37, 36, 33, 35, 32, 94, 34, 95, 96, 90];

const wanted = process.argv.slice(2);
const unknown = wanted.filter(s => !SERVICES.includes(s));
if (unknown.length) {
  console.error(
    `Unknown service(s): ${unknown.join(', ')}. Choose from: ${SERVICES.join(', ')}`,
  );
  process.exit(1);
}
/**
 * The services (among `selected`) that use OpenBao, by their .env or this shell: edrms and intake
 * when they encrypt with it, audit when it anchors on Cardano (its wallet key is there).
 */
function baoUsers(selected) {
  const uses = {
    edrms: get => (get('EDRMS_ENCRYPTION') ?? 'off').toLowerCase() === 'bao',
    intake: get => (get('INTAKE_ENCRYPTION') ?? 'off').toLowerCase() === 'bao',
    audit: get =>
      ['ogmios', 'blockfrost'].includes(
        (get('CARDANO_PROVIDER') ?? '').toLowerCase(),
      ),
  };
  return selected.filter(name => {
    if (!uses[name] || !PROCESSES[name]) return false;
    const file = join(PROCESSES[name].cwd, '.env');
    const env = existsSync(file) ? dotenv.parse(readFileSync(file)) : {};
    return uses[name](key => process.env[key] ?? env[key]);
  });
}
/** The services (among `selected`) that anchor through the local Cardano node (Ogmios). */
function cardanoUsers(selected) {
  return selected.filter(name => {
    if (name !== 'audit' || !PROCESSES[name]) return false;
    const file = join(PROCESSES[name].cwd, '.env');
    const fromFile = existsSync(file)
      ? dotenv.parse(readFileSync(file)).CARDANO_PROVIDER
      : undefined;
    return (
      (process.env.CARDANO_PROVIDER ?? fromFile ?? '').toLowerCase() ===
      'ogmios'
    );
  });
}
// Everything but OpenBao and the Cardano node by default; each when named, or when a selected service needs it
const ON_DEMAND = ['bao', 'cardano'];
const selected = wanted.length
  ? SERVICES.filter(s => wanted.includes(s))
  : SERVICES.filter(s => !ON_DEMAND.includes(s));
const needBao = baoUsers(selected);
const needCardano = cardanoUsers(selected);
const names = [
  ...(needBao.length && !selected.includes('bao') ? ['bao'] : []),
  ...(needCardano.length && !selected.includes('cardano') ? ['cardano'] : []),
  ...selected,
];
if (needBao.length && !wanted.includes('bao')) {
  console.log(
    `OpenBao is started too: ${needBao.map(n => `${n} encrypts its files with it`).join(', ')}.`,
  );
}
if (needCardano.length && !wanted.includes('cardano')) {
  console.log(
    'The Cardano node and Ogmios are started too: the audit service anchors through them.',
  );
}

const width = Math.max(...names.map(n => n.length));
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const label = name => {
  const text = name.padEnd(width);
  return color
    ? `\x1b[${COLORS[SERVICES.indexOf(name)]}m${text}\x1b[0m │ `
    : `${text} │ `;
};

// A PORT set in this shell would override every service's .env (dotenv never overrides), and all
// five would try to bind the same port.
const env = {...process.env};
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
      if (busy) {
        out.write(
          `${prefix}↳ ${busy[1]} is taken, probably by a copy started separately (${name === 'docs' ? 'npm run docs:serve' : `npm run dev:${name}`}). Stop it, or leave ${name} out: npm run dev -- <the others>\n`,
        );
      }
      if (name === 'nats' && /address already in use/.test(line)) {
        out.write(
          `${prefix}↳ port ${process.env.NATS_PORT || 4222} is taken, probably by another NATS (npm run nats, Docker); the services will use that one\n`,
        );
      }
      if (name === 'bao' && /already answers/.test(line)) {
        out.write(
          `${prefix}↳ another OpenBao is running on that port (npm run bao); the services will use that one\n`,
        );
      }
    }
  });
  stream.on('end', () => {
    if (rest) out.write(prefix + rest + '\n');
  });
}

function stopAll(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill(signal);
  // a service that ignores the signal must not keep the terminal busy
  setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
  }, 8000).unref();
}

for (const name of names) {
  const {cwd, args, optional} = PROCESSES[name];
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  pipe(child.stdout, process.stdout, label(name), name);
  pipe(child.stderr, process.stderr, label(name), name);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!stopping && name === 'cardano' && code === 0) {
      // started (or found) in the background, supervised: it outlives npm run dev (API-677)
    } else if (!stopping && optional) {
      console.error(
        `${label(name)}exited (${signal || `code ${code}`}); the services keep running`,
      );
    } else if (!stopping) {
      console.error(
        `${label(name)}exited (${signal || `code ${code}`}); stopping the other services`,
      );
      process.exitCode = code || 1;
      stopAll();
    }
    if (!children.size) process.exit();
  });
}

console.log(`Starting ${names.join(', ')}. Ctrl+C stops all.`);
process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
