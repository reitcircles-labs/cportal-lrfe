import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect} from 'chai';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  IDENTITY_DIR,
  runIdentityExpectingExit,
  startIdentity,
} from './identity-process.js';

/**
 * CB-102, identity at start, as the install starts it:
 *
 * - Design decision 9: the setup codes identity gives at start (the first administrator, the demo
 *   users) are written to a file only identity's user can read (mode 0600), never to its console
 *   or service log; the log says only where the file is. The file is SETUP_CODE_FILE, by default
 *   tmp/setup-codes.txt in identity's working directory; the compose install puts it under /data
 *   and the operator reads it with `docker compose exec identity cat <file>`.
 * - The end-to-end tests' SEED_DEMO_MFA_KEY is refused unless NODE_ENV=test.
 */

const REPO_DIR = join(IDENTITY_DIR, '..', '..', '..');

/** A setup code as identity gives it. */
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/g;

/** The lines of `text` that give a setup code, as { email, code }. */
function setupCodesIn(text) {
  const found = [];
  for (const match of text.matchAll(
    /Setup code for (\S+): ([A-Z0-9]{4}-[A-Z0-9]{4})/g,
  )) {
    found.push({email: match[1], code: match[2]});
  }
  return found;
}

/** The permission bits of a file, e.g. 0o600. */
function modeOf(file) {
  return statSync(file).mode & 0o777;
}

describe('identity at start (CB-102)', function () {
  this.timeout(90_000);
  let identity;
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb102-setup-codes-'));
  });

  afterEach(async () => {
    if (identity) {
      await identity.stop();
      identity = null;
    }
    rmSync(dir, {recursive: true, force: true});
  });

  describe('decision 9: the setup codes given at start go to a file only identity can read', () => {
    it("SETUP_CODE_FILE: the first administrator's code is written there, mode 0600", async () => {
      const file = join(dir, 'codes', 'setup-codes.txt');
      identity = await startIdentity({SETUP_CODE_FILE: file});
      expect(existsSync(file), file).to.equal(true);
      expect(modeOf(file).toString(8)).to.equal('600');
      const codes = setupCodesIn(readFileSync(file, 'utf8'));
      expect(codes.map(c => c.email)).to.deep.equal([ADMIN_EMAIL]);
    });

    it('the code in the file is the one that works at the first sign-in', async () => {
      const file = join(dir, 'setup-codes.txt');
      identity = await startIdentity({SETUP_CODE_FILE: file});
      const [{code}] = setupCodesIn(readFileSync(file, 'utf8'));
      const login = await fetch(`${identity.url}/auth/login`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({email: ADMIN_EMAIL, password: ADMIN_PASSWORD}),
      });
      const {challenge, next} = await login.json();
      expect(next).to.equal('setup-code');
      const res = await fetch(`${identity.url}/auth/setup-code`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({challenge, setupCode: code}),
      });
      expect(res.status).to.equal(200);
      expect((await res.json()).next).to.equal('mfa-enroll');
    });

    it('nothing with a code goes to the console or the service log; the log says where the file is', async () => {
      const file = join(dir, 'setup-codes.txt');
      identity = await startIdentity({
        SETUP_CODE_FILE: file,
        LOG_LEVEL: 'trace',
      });
      const [{code}] = setupCodesIn(readFileSync(file, 'utf8'));
      const output = identity.output();
      expect(output).to.not.include(code);
      expect(output).to.not.include('Setup code for');
      expect(output.match(CODE) || []).to.deep.equal([]);
      expect(output).to.include(file);
    });

    it('the demo users get their codes in the same file, none on the console', async () => {
      const file = join(dir, 'setup-codes.txt');
      identity = await startIdentity({
        SETUP_CODE_FILE: file,
        SEED_DEMO_PASSWORD: 'a long demo password for the test',
        LOG_LEVEL: 'info',
      });
      const codes = setupCodesIn(readFileSync(file, 'utf8'));
      expect(codes.length).to.be.greaterThan(1);
      expect(codes.map(c => c.email)).to.include(ADMIN_EMAIL);
      const output = identity.output();
      expect(output).to.not.include('Setup code for');
      for (const {code} of codes) {
        expect(output).to.not.include(code);
      }
    });

    it('without SETUP_CODE_FILE, the file is tmp/setup-codes.txt in the working directory, mode 0600', async () => {
      identity = await startIdentity({LOG_LEVEL: 'info'});
      const file = join(identity.cwd, 'tmp', 'setup-codes.txt');
      expect(existsSync(file), file).to.equal(true);
      expect(modeOf(file).toString(8)).to.equal('600');
      expect(
        setupCodesIn(readFileSync(file, 'utf8')).map(c => c.email),
      ).to.deep.equal([ADMIN_EMAIL]);
      expect(identity.output()).to.not.include('Setup code for');
    });

    it('a file that is already there, readable by others, is added to and made 0600', async () => {
      const file = join(dir, 'setup-codes.txt');
      writeFileSync(file, 'an earlier line\n');
      chmodSync(file, 0o644);
      identity = await startIdentity({SETUP_CODE_FILE: file});
      const text = readFileSync(file, 'utf8');
      expect(text.startsWith('an earlier line\n')).to.equal(true);
      expect(setupCodesIn(text).map(c => c.email)).to.deep.equal([ADMIN_EMAIL]);
      expect(modeOf(file).toString(8)).to.equal('600');
    });

    it('no user created at start (no administrator, no demo users): no file is written', async () => {
      const file = join(dir, 'setup-codes.txt');
      identity = await startIdentity({
        SETUP_CODE_FILE: file,
        BOOTSTRAP_ADMIN_EMAIL: undefined,
        BOOTSTRAP_ADMIN_PASSWORD: undefined,
      });
      expect(existsSync(file)).to.equal(false);
    });

    it('a file that cannot be written: identity still starts and says why, naming the file, with no code', async () => {
      // a regular file where the folder should be: the setup-code file cannot be made
      const blocker = join(dir, 'not-a-folder');
      writeFileSync(blocker, '');
      const file = join(blocker, 'setup-codes.txt');
      identity = await startIdentity({SETUP_CODE_FILE: file});
      const output = identity.output();
      expect(output).to.include(file);
      expect(output).to.not.include('Setup code for');
      expect(output.match(CODE) || []).to.deep.equal([]);
    });
  });

  describe('SEED_DEMO_MFA_KEY is only for the end-to-end tests', () => {
    for (const nodeEnv of ['production', 'development', undefined]) {
      it(`refused with NODE_ENV=${nodeEnv ?? '(not set)'}: identity stops at start, naming it`, async () => {
        const run = await runIdentityExpectingExit({
          SETUP_CODE_FILE: join(dir, 'setup-codes.txt'),
          SEED_DEMO_PASSWORD: 'a long demo password for the test',
          SEED_DEMO_MFA_KEY: 'a test key',
          NODE_ENV: nodeEnv,
        });
        expect(run.listened).to.equal(false);
        expect(run.output).to.include('SEED_DEMO_MFA_KEY');
      });
    }

    it('honoured with NODE_ENV=test: the demo users need no setup code', async () => {
      const file = join(dir, 'setup-codes.txt');
      identity = await startIdentity({
        SETUP_CODE_FILE: file,
        SEED_DEMO_PASSWORD: 'a long demo password for the test',
        SEED_DEMO_MFA_KEY: 'a test key',
        NODE_ENV: 'test',
      });
      // only the first administrator, who has no derived authenticator, gets a code
      expect(
        setupCodesIn(readFileSync(file, 'utf8')).map(c => c.email),
      ).to.deep.equal([ADMIN_EMAIL]);
    });
  });

  describe('the install and the demo guides send the operator to the file, not the log', () => {
    const read = path => readFileSync(join(REPO_DIR, path), 'utf8');
    const GUIDES = [
      'deploy/README.md',
      'demo/README.md',
      'demo/SHIPPING-STORYLINE.md',
      'demo/check-readiness.mjs',
      'backend/services/identity/README.md',
    ];

    it('the compose install sets SETUP_CODE_FILE for identity, under /data (writable by its user)', () => {
      const compose = read('deploy/docker-compose.yml');
      const match = /^ {2}identity:\n((?: {4}.*\n|\s*\n)+)/m.exec(compose);
      expect(match, 'identity in deploy/docker-compose.yml').to.not.equal(null);
      expect(match[1]).to.match(/^\s+SETUP_CODE_FILE: \/data\/\S+$/m);
    });

    for (const guide of GUIDES) {
      it(`${guide} never sends the operator to the service log for a setup code`, () => {
        expect(read(guide)).to.not.match(/logs identity[^\n]*Setup code/);
      });
    }

    for (const guide of [
      'deploy/README.md',
      'demo/README.md',
      'demo/check-readiness.mjs',
    ]) {
      it(`${guide} says how to read the file: docker compose exec identity cat`, () => {
        const compose = read('deploy/docker-compose.yml');
        const file = /^\s+SETUP_CODE_FILE: (\S+)$/m.exec(compose)?.[1];
        expect(file, 'SETUP_CODE_FILE in the compose file').to.be.a('string');
        expect(read(guide)).to.include(
          `docker compose exec identity cat ${file}`,
        );
      });
    }
  });
});
