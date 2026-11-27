import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Identity started as the install starts it (`node src/index.js`), for the tests of its start-up
 * settings (CB-101, CB-102). Moved here from code-lockout.test.js so more than one test file can
 * use it.
 */

/** The identity service's folder, where `node src/index.js` is run. */
export const IDENTITY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The bootstrap administrator every started identity creates. */
export const ADMIN_EMAIL = 'admin@example.org';

/** The bootstrap administrator's password. */
export const ADMIN_PASSWORD = 'a long bootstrap password for the test';

/**
 * Settings of the test runner's own environment that would change what identity does at start;
 * removed before `settings` are added, so a developer's shell cannot change a test's result.
 */
const INHERITED = /^(MFA_|SETUP_CODE_|SEED_|BOOTSTRAP_ADMIN_|NODE_ENV$)/;

/**
 * A free TCP port on the loopback address.
 * @return {!Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts identity as the install does, in memory, with a bootstrap administrator and `settings`
 * added to the environment (a setting of undefined is left out), from an empty working directory
 * so no local .env file adds to them. Resolves once /health answers; rejects with the process
 * output when it exits first.
 * @param {!Object<string, (string|undefined)>} settings
 * @return {!Promise<{url: string, cwd: string, stop: function(): !Promise<void>,
 *     output: function(): string}>} `output` is everything identity wrote to stdout and stderr
 */
export async function startIdentity(settings) {
  const port = await freePort();
  const cwd = mkdtempSync(join(tmpdir(), 'identity-start-'));
  const childEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!INHERITED.test(name)) {
      childEnv[name] = value;
    }
  }
  const allSettings = {
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'warn',
    LRFE_DOMAIN: 'land',
    IDENTITY_STORE: 'memory',
    EVENT_BUS_DRIVER: 'log',
    MAIL_TRANSPORT: 'none',
    JWT_SECRET: 'identity-start-secret-identity-start-secret',
    COOKIE_SECURE: 'false',
    BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    ...settings,
  };
  for (const [name, value] of Object.entries(allSettings)) {
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }
  const child = spawn(process.execPath, [join(IDENTITY_DIR, 'src/index.js')], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code));
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(cwd, {recursive: true, force: true});
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(
        `identity exited (${child.exitCode}) before it was up: ${output}`,
      );
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return {url, cwd, stop, output: () => output};
      }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`identity did not come up in 15 s: ${output}`);
}

/**
 * Starts identity with `settings` and reports whether it stopped on its own.
 * @param {!Object<string, (string|undefined)>} settings
 * @return {!Promise<{listened: boolean, output: string}>}
 */
export async function runIdentityExpectingExit(settings) {
  try {
    const {stop} = await startIdentity(settings);
    await stop();
    return {listened: true, output: ''};
  } catch (err) {
    return {listened: false, output: err.message};
  }
}
