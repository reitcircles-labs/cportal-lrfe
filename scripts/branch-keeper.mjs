// The branch keeper (API-851): keeps the ticket branches of registered checkouts up to date with
// main while tickets are built in parallel. Run by cron every 10 minutes; it spends no tokens unless
// something needs fixing.
//
//   node scripts/branch-keeper.mjs register [<dir>]       keep this checkout's ticket branch up to date
//   node scripts/branch-keeper.mjs unregister [<dir>]     stop keeping it
//   node scripts/branch-keeper.mjs run                    check every registered checkout (cron)
//   node scripts/branch-keeper.mjs check [<dir>]          lint + unit tests, record green or failed
//   node scripts/branch-keeper.mjs block <dir> <reason>   mark the branch blocked and email the user
//   node scripts/branch-keeper.mjs status                 one line per registered checkout
//
// When main has moved and the checkout is clean and idle, it merges origin/main into the branch
// (never a rebase: pushed branches are never force-pushed), reinstalls where a lock file changed and
// runs lint and the unit tests. A merge conflict or a failing check starts the branch-keeper agent
// (.claude/agents/branch-keeper.md). It never pushes, rebases, resets or touches main. Its files are
// in ~/lrfe-data/branch-keeper/: <checkout>.log (follow it with tail -f), <checkout>.json (the
// state), <checkout>-check.log, <checkout>-agent.log. Details: docs/ai-workflow/branch-keeper.md.
import {spawn, spawnSync} from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const DATA =
  process.env.BRANCH_KEEPER_DATA ??
  join(homedir(), 'lrfe-data', 'branch-keeper');
const REGISTRY = join(DATA, 'checkouts.json');
const RUN_LOCK = join(DATA, 'run.lock');
/** The user's email notifier; BRANCH_KEEPER_NOTIFY=off (trials) sends nothing. */
const NOTIFY =
  process.env.BRANCH_KEEPER_NOTIFY === 'off'
    ? null
    : join(homedir(), 'lrfe-data', 'notify.mjs');
const MAIN = 'main';
const CO_AUTHOR = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const CURRENT_BRANCH = ['rev-parse', '--abbrev-ref', 'HEAD'];
/** How long an agent may work before it counts as hung. */
const AGENT_MAX_MS = 6 * 60 * 60 * 1000;

/** Git subcommands the keeper never runs: they publish, rewrite history or switch branches. */
const REFUSED_GIT = new Set([
  'push',
  'rebase',
  'reset',
  'checkout',
  'switch',
  'branch',
  'tag',
  'cherry-pick',
  'commit-tree',
  'update-ref',
]);

/**
 * Refuses a git command that could publish, rewrite history or touch main; returns otherwise.
 * @param {string[]} args the git arguments
 */
export function assertSafeGit(args) {
  const forced = args.some(
    arg => arg === '-f' || arg.startsWith('--force') || arg === '--hard',
  );
  if (REFUSED_GIT.has(args[0]) || forced || args.includes(MAIN)) {
    throw new Error(`refused: git ${args.join(' ')}`);
  }
}

/**
 * The ticket key a branch is named after.
 * @param {string} branch e.g. `api-851-branch-keeper`
 * @return {string|null} e.g. `API-851`, or null for a branch without one
 */
export function ticketKey(branch) {
  const match = /^([a-z]+)-(\d+)\b/i.exec(branch);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

/**
 * The message of the commit that brings main into a ticket branch.
 * @param {string} key the ticket key
 * @return {string}
 */
export function mergeMessage(key) {
  return [
    `${key} Update from main`,
    '',
    'Merge origin/main into this ticket branch (branch keeper, API-851).',
    '',
    CO_AUTHOR,
  ].join('\n');
}

/**
 * What to do with a checkout now.
 * @param {{branch: string, dirty: boolean, busy: boolean, agentRunning: boolean, behind: number,
 *     mainSha: string, status: ?{state: string, mainSha: string}}} checkout its state
 * @return {string} `not-a-ticket-branch`, `wait-agent`, `up-to-date`, `blocked`, `wait-dirty`,
 *     `wait-busy` or `merge`
 */
export function decide(checkout) {
  if (!checkout.branch || checkout.branch === MAIN) {
    return 'not-a-ticket-branch';
  }
  if (checkout.agentRunning) {
    return 'wait-agent';
  }
  if (checkout.behind === 0) {
    return 'up-to-date';
  }
  const status = checkout.status;
  if (status?.state === 'blocked' && status.mainSha === checkout.mainSha) {
    return 'blocked';
  }
  if (checkout.dirty) {
    return 'wait-dirty';
  }
  if (checkout.busy) {
    return 'wait-busy';
  }
  return 'merge';
}

/**
 * The folders whose dependencies must be reinstalled after a merge.
 * @param {string[]} changedFiles the files the merge changed, relative to the checkout
 * @return {string[]} the folders (`.` for the root) whose package-lock.json changed
 */
export function installsFor(changedFiles) {
  return changedFiles
    .filter(file => basename(file) === 'package-lock.json')
    .map(file => dirname(file));
}

/**
 * Whether a process's command line is a test run (which a merge must not disturb).
 * @param {string} commandLine the command and its arguments, space-separated
 * @return {boolean}
 */
export function isTestCommand(commandLine) {
  return /playwright test|node --test|npm (run )?(-s )?test/.test(commandLine);
}

/**
 * The arguments that start the branch-keeper agent on a checkout, headless.
 * @param {string} dir the checkout
 * @param {string} key the ticket key
 * @param {string} reason why it is needed (the conflict or the failing check)
 * @return {string[]}
 */
export function agentArgs(dir, key, reason) {
  const prompt = [
    `Checkout: ${dir}. Ticket: ${key}. Reason: ${reason}.`,
    'Bring this ticket branch up to date with origin/main as your instructions say, then run',
    `\`node scripts/branch-keeper.mjs check ${dir}\`, or \`node scripts/branch-keeper.mjs block`,
    `${dir} "<reason>"\` when it needs the user.`,
  ].join(' ');
  return [
    '-p',
    prompt,
    '--agent',
    'branch-keeper',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Read',
    'Edit',
    'Write',
    'Grep',
    'Glob',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git add:*)',
    'Bash(git commit --no-edit)',
    'Bash(git commit -m:*)',
    'Bash(git merge --abort)',
    'Bash(npm run:*)',
    'Bash(npm test:*)',
    'Bash(npm ci)',
    'Bash(node scripts/branch-keeper.mjs:*)',
    'Bash(tail:*)',
    'Bash(grep:*)',
    'Bash(mkdir -p:*)',
    'Bash(echo:*)',
    'Bash(date:*)',
    '--disallowedTools',
    'Bash(git push:*)',
    'Bash(git rebase:*)',
    'Bash(git reset:*)',
    'Bash(git checkout:*)',
    'Bash(git switch:*)',
    'Bash(git branch:*)',
    'Bash(git commit --amend:*)',
  ];
}

/**
 * The environment the agent runs in: git's network transfers switched off (no protocol is
 * allowed), so that no push can leave the machine however it is spelled.
 * @param {!Object<string, string>} env the keeper's own environment
 * @return {!Object<string, string>}
 */
export function agentEnv(env) {
  return {...env, GIT_ALLOW_PROTOCOL: 'none'};
}

/**
 * What follows a merge: green, the agent, or blocked for the user.
 * @param {{merged: boolean, conflicts: string[], failedCheck: ?string, mergeError: ?string,
 *     hasAgent: boolean}} outcome the merge and, when it went through, the first failing check
 * @return {{next: string, reason: string}} `green`, `agent` or `blocked`, and why
 */
export function afterMerge(outcome) {
  let reason;
  if (!outcome.merged && outcome.conflicts.length === 0) {
    return {next: 'blocked', reason: `the merge failed: ${outcome.mergeError}`};
  }
  if (!outcome.merged) {
    reason = `merge conflict in ${outcome.conflicts.join(', ')}`;
  } else if (outcome.failedCheck) {
    reason = `check failed after the merge: ${outcome.failedCheck}`;
  } else {
    return {next: 'green', reason: ''};
  }
  if (!outcome.hasAgent) {
    return {
      next: 'blocked',
      reason: `${reason} (no claude program registered to fix it)`,
    };
  }
  return {next: 'agent', reason};
}

/**
 * The state to record after the checks ran. While the agent works, its state stays (so the keeper
 * keeps waiting for it) and the result is added to it.
 * @param {?Object} current the recorded state
 * @param {?string} failedCheck the first failing check, or null when all passed
 * @param {string} mainSha the main commit the branch contains
 * @return {Object}
 */
export function checkStatus(current, failedCheck, mainSha) {
  if (current?.state === 'agent') {
    return {
      ...current,
      lastCheck: failedCheck ? `failed: ${failedCheck}` : 'green',
    };
  }
  return failedCheck
    ? {state: 'failed', mainSha, reason: failedCheck}
    : {state: 'green', mainSha};
}

/**
 * Whether the agent is still working on a checkout.
 * @param {?Object} status the recorded state
 * @param {function(number): boolean} isAlive whether a process lives
 * @param {number} now the time, in milliseconds
 * @return {boolean}
 */
export function agentAlive(status, isAlive, now) {
  return (
    status?.state === 'agent' &&
    isAlive(status.agentPid) &&
    now - status.startedAt < AGENT_MAX_MS
  );
}

/**
 * What follows an agent that ended: green when its last check passed, it left the checkout clean
 * and the branch contains the main it was bringing in; blocked otherwise.
 * @param {Object} status the recorded state, with the agent's last check
 * @param {boolean} dirty whether the checkout has uncommitted changes
 * @param {number} behind how many commits of that main the branch still lacks
 * @return {{next: string, reason: string}}
 */
export function afterAgent(status, dirty, behind) {
  if (status.lastCheck === 'green' && !dirty && behind === 0) {
    return {next: 'green', reason: ''};
  }
  if (behind > 0) {
    return {
      next: 'blocked',
      reason: `the agent ended without a result (${status.reason}; still ${behind} commits behind main)`,
    };
  }
  const last = status.lastCheck ? `, last check ${status.lastCheck}` : '';
  return {
    next: 'blocked',
    reason: `the agent ended without a result (${status.reason}${last})`,
  };
}

/**
 * Runs git in a checkout, through the guard. The only place the keeper runs git.
 * @param {string} dir the checkout
 * @param {string[]} args the git arguments
 * @return {{ok: boolean, out: string}}
 */
function git(dir, args) {
  assertSafeGit(args);
  const result = spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/**
 * A line in a checkout's progress log, with the time.
 * @param {string} dir the checkout
 * @param {string} line
 */
function log(dir, line) {
  const stamped = `${new Date().toISOString().slice(0, 19)} ${line}`;
  appendFileSync(join(DATA, `${basename(dir)}.log`), `${stamped}\n`);
  console.log(`${basename(dir)}: ${line}`);
}

/**
 * Reads a JSON file.
 * @param {string} file
 * @param {*} fallback returned when the file does not exist
 * @return {*}
 */
function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

/**
 * The registered checkouts and the programs to run them with.
 * @return {{node: string, claude: ?string, checkouts: string[]}}
 */
function registry() {
  return readJson(REGISTRY, {
    node: process.execPath,
    claude: null,
    checkouts: [],
  });
}

/**
 * The keeper's last recorded state of a checkout.
 * @param {string} dir the checkout
 * @return {?Object}
 */
function readStatus(dir) {
  return readJson(join(DATA, `${basename(dir)}.json`), null);
}

/**
 * Records a checkout's state.
 * @param {string} dir the checkout
 * @param {Object} status
 */
function writeStatus(dir, status) {
  writeFileSync(
    join(DATA, `${basename(dir)}.json`),
    `${JSON.stringify({...status, at: new Date().toISOString()}, null, 2)}\n`,
  );
}

/**
 * Whether a process is alive.
 * @param {number} pid
 * @return {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a process is the branch-keeper agent this script started (a process id can be reused
 * by another program).
 * @param {number} pid
 * @return {boolean}
 */
function isClaude(pid) {
  try {
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return commandLine.includes('--agent\0branch-keeper');
  } catch {
    return false;
  }
}

/**
 * Whether a test run is going inside a checkout.
 * @param {string} dir the checkout
 * @return {boolean}
 */
function testRunning(dir) {
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    if (Number(pid) === process.pid) {
      continue;
    }
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd !== dir && !cwd.startsWith(`${dir}/`)) {
        continue;
      }
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .join(' ');
      if (isTestCommand(commandLine)) {
        return true;
      }
    } catch {
      // the process ended, or it is not ours to read
    }
  }
  return false;
}

/**
 * Runs a program in a checkout, its output appended to a log file.
 * @param {string} cwd where to run it
 * @param {string} cmd the program
 * @param {string[]} args its arguments
 * @param {string} logFile the log it writes to
 * @return {boolean} whether it succeeded
 */
function runLogged(cwd, cmd, args, logFile) {
  appendFileSync(logFile, `\n=== ${cmd} ${args.join(' ')} (in ${cwd})\n`);
  const out = openSync(logFile, 'a');
  try {
    return (
      spawnSync(cmd, args, {cwd, stdio: ['ignore', out, out]}).status === 0
    );
  } finally {
    closeSync(out);
  }
}

/**
 * The checks of one checkout: lint, format, and every unit-test script its packages declare.
 * @param {string} dir the checkout
 * @return {{name: string, cwd: string, args: string[]}[]}
 */
function checksFor(dir) {
  const checks = [
    {name: 'lint', cwd: dir, args: ['run', '-s', 'lint']},
    {name: 'format', cwd: dir, args: ['run', '-s', 'format:check']},
  ];
  for (const folder of ['.', 'angular-app']) {
    const scripts = readJson(join(dir, folder, 'package.json'), {}).scripts;
    for (const name of Object.keys(scripts ?? {})) {
      if (name.startsWith('test:')) {
        checks.push({name, cwd: join(dir, folder), args: ['run', '-s', name]});
      }
    }
  }
  checks.push({
    name: 'backend unit tests',
    cwd: join(dir, 'backend'),
    args: ['test'],
  });
  return checks;
}

/**
 * Runs the checks of a checkout and records green or failed.
 * @param {string} dir the checkout
 * @param {string} mainSha the main commit the branch now contains
 * @return {?string} the first failing check, or null when all passed
 */
function runChecks(dir, mainSha) {
  const logFile = join(DATA, `${basename(dir)}-check.log`);
  writeFileSync(logFile, `${new Date().toISOString()} checks of ${dir}\n`);
  log(dir, `checks: lint + unit tests (follow: tail -f ${logFile})`);
  let failed = null;
  for (const check of checksFor(dir)) {
    if (!runLogged(check.cwd, 'npm', check.args, logFile)) {
      failed = check.name;
      break;
    }
  }
  log(dir, failed ? `check failed: ${failed}` : 'checks passed');
  writeStatus(dir, checkStatus(readStatus(dir), failed, mainSha));
  return failed;
}

/**
 * Marks a checkout blocked and emails the user.
 * @param {string} dir the checkout
 * @param {string} reason what needs the user
 */
function block(dir, reason) {
  if (existsSync(join(dir, '.git', 'MERGE_HEAD'))) {
    git(dir, ['merge', '--abort']);
    log(dir, 'unfinished merge undone, the checkout is left clean');
  }
  const mainSha = git(dir, ['rev-parse', 'origin/main']).out;
  writeStatus(dir, {state: 'blocked', mainSha, reason});
  log(dir, `blocked: ${reason}`);
  if (NOTIFY && existsSync(NOTIFY)) {
    spawnSync(
      registry().node,
      [
        NOTIFY,
        `Branch keeper: ${basename(dir)} is blocked`,
        `${reason}\n\nCheckout: ${dir}\nLog: ${join(DATA, `${basename(dir)}.log`)}`,
      ],
      {stdio: 'ignore'},
    );
  }
}

/**
 * Starts the branch-keeper agent on a checkout, in the background.
 * @param {string} dir the checkout
 * @param {string} key the ticket key
 * @param {string} mainSha the main commit being brought in
 * @param {string} reason the conflict or the failing check
 */
function startAgent(dir, key, mainSha, reason) {
  const logFile = join(DATA, `${basename(dir)}-agent.log`);
  const out = openSync(logFile, 'a');
  const child = spawn(registry().claude, agentArgs(dir, key, reason), {
    cwd: dir,
    detached: true,
    stdio: ['ignore', out, out],
    env: agentEnv(process.env),
  });
  closeSync(out);
  child.unref();
  writeStatus(dir, {
    state: 'agent',
    mainSha,
    reason,
    agentPid: child.pid,
    startedAt: Date.now(),
  });
  log(dir, `agent started for: ${reason} (follow: tail -f ${logFile})`);
}

/**
 * Acts on what follows a merge or an agent: records green, starts the agent, or blocks.
 * @param {string} dir the checkout
 * @param {string} key the ticket key
 * @param {string} mainSha the main commit being brought in
 * @param {{next: string, reason: string}} result
 */
function follow(dir, key, mainSha, result) {
  if (result.next === 'green') {
    writeStatus(dir, {state: 'green', mainSha});
    log(dir, 'up to date with main and green');
  } else if (result.next === 'agent') {
    startAgent(dir, key, mainSha, result.reason);
  } else {
    block(dir, result.reason);
  }
}

/**
 * Brings main into a ticket branch and checks the result.
 * @param {string} dir the checkout
 * @param {string} key the ticket key
 * @param {string} mainSha the main commit to bring in
 */
function update(dir, key, mainSha) {
  writeStatus(dir, {state: 'updating', mainSha});
  const before = git(dir, ['rev-parse', 'HEAD']).out;
  log(dir, `merging origin/main (${mainSha.slice(0, 7)})`);
  const merge = git(dir, [
    'merge',
    '--no-ff',
    '-m',
    mergeMessage(key),
    'origin/main',
  ]);
  const hasAgent = Boolean(registry().claude);
  if (!merge.ok) {
    const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).out;
    const outcome = {
      merged: false,
      conflicts: conflicts ? conflicts.split('\n') : [],
      mergeError: merge.out.split('\n')[0],
      hasAgent,
    };
    follow(dir, key, mainSha, afterMerge(outcome));
    return;
  }
  const changed = git(dir, ['diff', '--name-only', before, 'HEAD']).out;
  for (const folder of installsFor(changed ? changed.split('\n') : [])) {
    const logFile = join(DATA, `${basename(dir)}-check.log`);
    log(dir, `npm ci in ${folder} (lock file changed)`);
    if (!runLogged(join(dir, folder), 'npm', ['ci'], logFile)) {
      block(dir, `npm ci failed in ${folder}`);
      return;
    }
  }
  const failedCheck = runChecks(dir, mainSha);
  const outcome = {merged: true, conflicts: [], failedCheck, hasAgent};
  follow(dir, key, mainSha, afterMerge(outcome));
}

/**
 * Looks at one registered checkout and does what it needs.
 * @param {string} dir the checkout
 */
function keep(dir) {
  if (!existsSync(join(dir, '.git'))) {
    console.log(`${dir}: not a checkout, skipped`);
    return;
  }
  const fetched = git(dir, ['fetch', '--quiet', 'origin']);
  if (!fetched.ok) {
    log(dir, `fetch failed: ${fetched.out.split('\n')[0]}`);
    return;
  }
  const head = git(dir, CURRENT_BRANCH).out;
  const branch = head === 'HEAD' ? '' : head;
  const key = ticketKey(branch);
  const status = readStatus(dir);
  const agentRunning = agentAlive(status, isClaude, Date.now());
  const dirty =
    git(dir, ['status', '--porcelain', '--untracked-files=no']).out !== '';
  if (status?.state === 'agent' && !agentRunning) {
    const range = `HEAD..${status.mainSha}`;
    const behind = Number(git(dir, ['rev-list', '--count', range]).out);
    follow(dir, key, status.mainSha, afterAgent(status, dirty, behind));
    return;
  }
  const mainSha = git(dir, ['rev-parse', 'origin/main']).out;
  const checkout = {
    branch: key ? branch : '',
    dirty,
    busy: testRunning(dir),
    agentRunning,
    behind: Number(git(dir, ['rev-list', '--count', 'HEAD..origin/main']).out),
    mainSha,
    status,
  };
  const action = decide(checkout);
  if (action === 'merge') {
    update(dir, key, mainSha);
    return;
  }
  if (action === 'up-to-date' && status === null) {
    writeStatus(dir, {state: 'up-to-date', mainSha});
  }
  if (action !== 'up-to-date' || status === null) {
    log(dir, `${branch || 'no branch'}: ${action}`);
  }
}

/**
 * Takes the run lock, so that two cron runs never work at once; a lock left by a run that died is
 * taken over.
 * @return {boolean} whether this run holds the lock
 */
function takeLock() {
  try {
    writeFileSync(RUN_LOCK, String(process.pid), {flag: 'wx'});
    return true;
  } catch {
    const holder = Number(readFileSync(RUN_LOCK, 'utf8'));
    if (holder > 0 && alive(holder)) {
      console.log(`another run is going (pid ${holder})`);
      return false;
    }
    rmSync(RUN_LOCK, {force: true});
    writeFileSync(RUN_LOCK, String(process.pid), {flag: 'wx'});
    return true;
  }
}

/** Checks every registered checkout, one run at a time. */
function runAll() {
  if (!takeLock()) {
    return;
  }
  try {
    for (const dir of registry().checkouts) {
      try {
        keep(dir);
      } catch (e) {
        log(dir, `error: ${e.message}`);
      }
    }
  } finally {
    rmSync(RUN_LOCK, {force: true});
  }
}

/**
 * Adds or removes a checkout from the registry.
 * @param {string} dir the checkout
 * @param {boolean} add
 */
function register(dir, add) {
  const current = registry();
  const branch = git(dir, CURRENT_BRANCH).out;
  if (add && !ticketKey(branch)) {
    throw new Error(`${dir} is on "${branch}", not a ticket branch`);
  }
  const which = spawnSync('sh', ['-c', 'command -v claude'], {
    encoding: 'utf8',
  });
  current.node = process.execPath;
  current.claude = which.stdout.trim() || current.claude;
  current.checkouts = current.checkouts.filter(d => d !== dir);
  if (add) {
    current.checkouts.push(dir);
  }
  writeFileSync(REGISTRY, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`${add ? 'keeping' : 'no longer keeping'} ${dir} (${branch})`);
  if (add) {
    console.log(`follow: tail -f ${join(DATA, `${basename(dir)}.log`)}`);
  }
}

/** Prints one line per registered checkout. */
function printStatus() {
  for (const dir of registry().checkouts) {
    const s = readStatus(dir);
    const branch = git(dir, CURRENT_BRANCH).out;
    const detail = s?.reason ? ` (${s.reason})` : '';
    console.log(
      `${dir}  ${branch}  ${s?.state ?? 'not checked yet'}${detail}  ${s?.at ?? ''}`,
    );
  }
}

/** The command line. */
function main() {
  mkdirSync(DATA, {recursive: true});
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
  const [command, target, ...rest] = process.argv.slice(2);
  const dir = resolve(target ?? process.cwd());
  switch (command) {
    case 'register':
      register(dir, true);
      break;
    case 'unregister':
      register(dir, false);
      break;
    case 'run':
      runAll();
      break;
    case 'check': {
      const failed = runChecks(dir, git(dir, ['rev-parse', 'origin/main']).out);
      process.exitCode = failed ? 1 : 0;
      break;
    }
    case 'block':
      block(dir, rest.join(' ') || 'blocked by the agent');
      break;
    case 'status':
      printStatus();
      break;
    default:
      console.log(
        readFileSync(fileURLToPath(import.meta.url), 'utf8')
          .split('\n')
          .filter(line => line.startsWith('//'))
          .slice(0, 10)
          .join('\n'),
      );
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
