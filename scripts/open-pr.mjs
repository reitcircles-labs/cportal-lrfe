// Pushes this checkout's branch and opens its pull request against main, then follows the checks
// the PR starts (.github/workflows/tests.yml runs on every pull request). Used by the pr-opener
// agent; never merges, never pushes main, never force-pushes.
//
//   node scripts/open-pr.mjs --title "<title>" --body-file <file>   push, open (or find) the PR, follow
//   node scripts/open-pr.mjs --checks                                follow the checks of this branch's PR
//
// Needs the GitHub CLI logged in (`gh auth login`); the push uses git's own credentials. Writes its
// progress to ~/lrfe-data/pr-<branch>.log (follow it with tail -f) and the PR's link to
// ~/lrfe-data/pr-<branch>.txt. The last line is `RESULT {...}`: ok, the PR's url, the checks.
import {execFileSync, spawnSync} from 'node:child_process';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const MAIN = 'main';
const KEY = /^API-\d+ /;
const DATA = join(homedir(), 'lrfe-data');

/** Runs a command, returning its trimmed output; throws with its error output on failure. */
function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Ends the run with a RESULT line. */
function finish(result) {
  log(`RESULT ${JSON.stringify(result)}`);
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

let logFile = null;

/** A line in the progress log, with the time. */
function log(line) {
  const stamped = `${new Date().toTimeString().slice(0, 8)} ${line}`;
  if (logFile) {
    appendFileSync(logFile, `${stamped}\n`);
  }
  if (!line.startsWith('RESULT')) {
    console.log(stamped);
  }
}

/** Refuses the run, before anything was pushed or opened. */
function refuse(reason) {
  finish({ok: false, refused: reason});
}

/** The value after a flag, or null. */
function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

/** Waits for the PR's checks to end, logging each change; returns them as {name: conclusion}. */
function followChecks(branch) {
  log('checks: waiting for the pipeline (.github/workflows/tests.yml)');
  let last = '';
  for (let minute = 0; minute < 60; minute += 0.5) {
    const out = spawnSync(
      'gh',
      ['pr', 'checks', branch, '--json', 'name,state,bucket'],
      {encoding: 'utf8'},
    );
    const checks =
      out.status === 0 || out.status === 8
        ? JSON.parse(out.stdout || '[]')
        : [];
    const line = checks
      .map(c => `${c.name}: ${c.state.toLowerCase()}`)
      .join(' | ');
    if (line && line !== last) {
      log(`checks: ${line}`);
      last = line;
    }
    if (checks.length && checks.every(c => c.bucket !== 'pending')) {
      return Object.fromEntries(checks.map(c => [c.name, c.bucket]));
    }
    spawnSync('sleep', ['30']);
  }
  log('checks: still running after an hour; stopped following');
  return null;
}

const branch = run('git', ['branch', '--show-current']);
mkdirSync(DATA, {recursive: true});
logFile = join(DATA, `pr-${branch}.log`);
log(`== ${branch}`);

if (spawnSync('gh', ['auth', 'status'], {stdio: 'ignore'}).status !== 0) {
  refuse('The GitHub CLI is not logged in: run `gh auth login` once');
}

if (process.argv.includes('--checks')) {
  const checks = followChecks(branch);
  finish({
    ok: !!checks && Object.values(checks).every(b => b === 'pass'),
    checks,
  });
}

const title = option('--title');
const bodyFile = option('--body-file');
if (!title || !bodyFile) {
  refuse('Usage: --title "<title>" --body-file <file>');
}
if (!KEY.test(title)) {
  refuse('The title must start with the ticket key (API-123 …)');
}

// the guards: nothing leaves this machine unless all of them hold
if (!branch || branch === MAIN) {
  refuse(
    `Refusing to push "${branch || 'a detached HEAD'}": only a ticket branch is pushed, never ${MAIN}`,
  );
}
if (run('git', ['status', '--porcelain', '--untracked-files=no'])) {
  refuse(
    'Uncommitted changes to tracked files: commit or set them aside first',
  );
}
run('git', ['fetch', '-q', 'origin']);
if (
  spawnSync('git', ['merge-base', '--is-ancestor', `origin/${MAIN}`, 'HEAD'])
    .status !== 0
) {
  refuse(
    `The branch is not based on the current origin/${MAIN}: bring it up to date first`,
  );
}
const commits = run('git', ['log', '--format=%h %s', `origin/${MAIN}..HEAD`])
  .split('\n')
  .filter(Boolean);
if (!commits.length) {
  refuse(`Nothing to push: the branch has no commits beyond origin/${MAIN}`);
}
const unkeyed = commits.filter(c => !KEY.test(c.slice(c.indexOf(' ') + 1)));
if (unkeyed.length) {
  refuse(`Commits without a ticket key: ${unkeyed.join('; ')}`);
}
log(`commits: ${commits.join(' · ')}`);

// a plain push: a remote branch that moved on is refused by git, never overwritten
const push = spawnSync('git', ['push', '-u', 'origin', branch], {
  encoding: 'utf8',
});
if (push.status !== 0) {
  finish({
    ok: false,
    step: 'push',
    error: push.stderr.trim().split('\n').slice(-3).join(' '),
  });
}
log(`pushed ${branch}`);

let url;
const existing = spawnSync(
  'gh',
  ['pr', 'view', branch, '--json', 'url,state'],
  {encoding: 'utf8'},
);
if (existing.status === 0 && JSON.parse(existing.stdout).state === 'OPEN') {
  url = JSON.parse(existing.stdout).url;
  log(`the PR was open already: ${url} (the push updated it)`);
} else {
  const created = spawnSync(
    'gh',
    [
      'pr',
      'create',
      '--base',
      MAIN,
      '--head',
      branch,
      '--title',
      title,
      '--body-file',
      bodyFile,
    ],
    {encoding: 'utf8'},
  );
  if (created.status !== 0) {
    finish({ok: false, step: 'pr create', error: created.stderr.trim()});
  }
  url = created.stdout.trim().split('\n').pop();
  log(`PR opened: ${url}`);
}
writeFileSync(
  join(DATA, `pr-${branch}.txt`),
  `${title}\n${url}\nbranch ${branch}\n${commits.join('\n')}\n`,
);

const checks = followChecks(branch);
finish({
  ok: !!checks && Object.values(checks).every(b => b === 'pass'),
  url,
  checks,
});
