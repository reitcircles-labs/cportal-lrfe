// The branch keeper's decisions (API-851, scripts/branch-keeper.mjs): when a registered ticket
// checkout is left alone, merged with main, or handed to the branch-keeper agent, and the guards
// that keep it from pushing, rebasing or touching main. Run with `npm run test:branch-keeper` at the
// repository root.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';

import {
  afterAgent,
  afterMerge,
  agentArgs,
  agentAlive,
  agentEnv,
  assertSafeGit,
  checkStatus,
  decide,
  installsFor,
  isTestCommand,
  mergeMessage,
  ticketKey,
} from './branch-keeper.mjs';

/** An hour, in milliseconds. */
const HOUR_MS = 3_600_000;

/** A checkout's state where nothing stops a merge; each test changes one thing. */
const READY = {
  branch: 'api-851-branch-keeper',
  dirty: false,
  busy: false,
  agentRunning: false,
  behind: 2,
  mainSha: 'b2',
  status: {state: 'green', mainSha: 'b1'},
};

describe('decide: what the keeper does with a checkout', () => {
  it('does nothing when main has not moved', () => {
    assert.equal(decide({...READY, behind: 0}), 'up-to-date');
  });

  it('merges when main moved and the checkout is clean and idle', () => {
    assert.equal(decide(READY), 'merge');
  });

  it('waits while there are uncommitted changes', () => {
    assert.equal(decide({...READY, dirty: true}), 'wait-dirty');
  });

  it('waits while a test run is going in the checkout', () => {
    assert.equal(decide({...READY, busy: true}), 'wait-busy');
  });

  it('waits while the branch-keeper agent works on it', () => {
    assert.equal(decide({...READY, agentRunning: true}), 'wait-agent');
  });

  it('never works on main or a detached HEAD', () => {
    assert.equal(decide({...READY, branch: 'main'}), 'not-a-ticket-branch');
    assert.equal(decide({...READY, branch: ''}), 'not-a-ticket-branch');
  });

  it('leaves a blocked branch alone until main moves again', () => {
    const blocked = {state: 'blocked', mainSha: 'b2', reason: 'conflict'};
    assert.equal(decide({...READY, status: blocked}), 'blocked');
    assert.equal(decide({...READY, mainSha: 'b3', status: blocked}), 'merge');
  });
});

describe('ticketKey and mergeMessage: commits name the ticket', () => {
  it('reads the ticket key from the branch name', () => {
    assert.equal(ticketKey('api-851-branch-keeper'), 'API-851');
    assert.equal(ticketKey('cb-121-copy-api-key'), 'CB-121');
    assert.equal(ticketKey('feature-x'), null);
  });

  it('starts the merge commit with the key and ends it with the co-author line', () => {
    const message = mergeMessage('API-851');
    assert.match(message, /^API-851 Update from main\n/);
    assert.match(
      message,
      /\nCo-Authored-By: Claude Opus 5\.5 <noreply@anthropic\.com>$/,
    );
  });
});

describe('installsFor: dependencies after a merge', () => {
  it('reinstalls only where a lock file changed', () => {
    assert.deepEqual(
      installsFor([
        'backend/package-lock.json',
        'angular-app/src/main.ts',
        'e2e/package-lock.json',
      ]),
      ['backend', 'e2e'],
    );
    assert.deepEqual(installsFor(['package-lock.json']), ['.']);
    assert.deepEqual(installsFor(['README.md']), []);
  });
});

describe('isTestCommand: a test run going in the checkout', () => {
  it('recognises test runs and lets other processes through', () => {
    assert.ok(isTestCommand('node /x/node_modules/.bin/playwright test'));
    assert.ok(isTestCommand('npm run -s test:shipping'));
    assert.ok(isTestCommand('node --test scripts/lint-guard.test.mjs'));
    assert.ok(!isTestCommand('node backend/services/gateway/src/server.js'));
    assert.ok(!isTestCommand('ng serve --port 4200'));
  });
});

describe('guards: never push, rebase, force or touch main', () => {
  it('refuses git commands that would publish or rewrite history', () => {
    for (const args of [
      ['push', 'origin', 'HEAD'],
      ['rebase', 'origin/main'],
      ['merge', '--ff-only', 'origin/main', '--force'],
      ['checkout', 'main'],
      ['switch', 'main'],
      ['reset', '--hard', 'origin/main'],
      ['branch', '-f', 'main'],
    ]) {
      assert.throws(() => assertSafeGit(args), /refused/, args.join(' '));
    }
  });

  it('allows what an update needs', () => {
    for (const args of [
      ['fetch', 'origin'],
      ['merge', '--no-ff', '--no-edit', 'origin/main'],
      ['status', '--porcelain', '--untracked-files=no'],
      ['rev-list', '--count', 'HEAD..origin/main'],
      ['diff', '--name-only', 'a', 'b'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
    ]) {
      assert.doesNotThrow(() => assertSafeGit(args), args.join(' '));
    }
  });

  it('starts the agent with push, rebase, reset and amend disallowed', () => {
    const args = agentArgs('/repo', 'API-851', 'merge conflict');
    const disallowed = args.slice(args.indexOf('--disallowedTools') + 1);
    assert.ok(args.includes('--agent') && args.includes('branch-keeper'));
    for (const tool of [
      'Bash(git push:*)',
      'Bash(git rebase:*)',
      'Bash(git reset:*)',
      'Bash(git commit --amend:*)',
    ]) {
      assert.ok(disallowed.includes(tool), tool);
    }
  });

  it('starts the agent with git network transfers off', () => {
    const env = agentEnv({PATH: '/usr/bin', HOME: '/home/x'});
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/x');
    assert.equal(env.GIT_ALLOW_PROTOCOL, 'none');
  });

  it('allows the agent no command that runs arbitrary code', () => {
    const args = agentArgs('/repo', 'API-851', 'merge conflict');
    const allowed = args.slice(
      args.indexOf('--allowedTools') + 1,
      args.indexOf('--disallowedTools'),
    );
    for (const tool of ['Bash(node:*)', 'Bash(npx:*)', 'Bash(npm:*)']) {
      assert.ok(!allowed.includes(tool), tool);
    }
    assert.ok(allowed.includes('Bash(node scripts/branch-keeper.mjs:*)'));
  });

  it('runs every git command of the script through the guard', () => {
    const source = readFileSync(
      new URL('./branch-keeper.mjs', import.meta.url),
      'utf8',
    );
    const direct = source.match(/(execFileSync|spawnSync|spawn)\(\s*'git'/g);
    assert.equal(direct?.length ?? 0, 1, 'one place runs git: git()');
    // every git call the script makes must pass the guard, or it would fail when it runs
    for (const call of source.matchAll(/git\(dir, \[([^\]]*)\]/g)) {
      const args = [...call[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
      assert.doesNotThrow(() => assertSafeGit(args), args.join(' '));
    }
  });
});

describe('afterMerge: what follows a merge (hand to the agent or not)', () => {
  it('is green when the merge and the checks passed', () => {
    assert.deepEqual(
      afterMerge({
        merged: true,
        conflicts: [],
        failedCheck: null,
        hasAgent: true,
      }),
      {next: 'green', reason: ''},
    );
  });

  it('hands a conflict to the agent', () => {
    assert.deepEqual(
      afterMerge({merged: false, conflicts: ['a.ts', 'b.ts'], hasAgent: true}),
      {next: 'agent', reason: 'merge conflict in a.ts, b.ts'},
    );
  });

  it('hands a failing check to the agent', () => {
    assert.deepEqual(
      afterMerge({
        merged: true,
        conflicts: [],
        failedCheck: 'lint',
        hasAgent: true,
      }),
      {next: 'agent', reason: 'check failed after the merge: lint'},
    );
  });

  it('blocks when there is no agent program to hand to', () => {
    const result = afterMerge({
      merged: false,
      conflicts: ['a.ts'],
      hasAgent: false,
    });
    assert.equal(result.next, 'blocked');
    assert.match(result.reason, /^merge conflict in a\.ts \(no claude program/);
  });

  it('blocks a merge that failed without a conflict', () => {
    assert.deepEqual(
      afterMerge({
        merged: false,
        conflicts: [],
        mergeError: 'untracked file would be overwritten',
        hasAgent: true,
      }),
      {
        next: 'blocked',
        reason: 'the merge failed: untracked file would be overwritten',
      },
    );
  });
});

describe('checkStatus: a check run while the agent works keeps the agent state', () => {
  it('records green or failed when the keeper runs the checks', () => {
    assert.deepEqual(checkStatus({state: 'updating'}, null, 'm1'), {
      state: 'green',
      mainSha: 'm1',
    });
    assert.deepEqual(checkStatus(null, 'lint', 'm1'), {
      state: 'failed',
      mainSha: 'm1',
      reason: 'lint',
    });
  });

  it('keeps the agent state and its process, adding the result', () => {
    const working = {
      state: 'agent',
      agentPid: 42,
      startedAt: 1,
      reason: 'x',
      mainSha: 'm1',
    };
    assert.deepEqual(checkStatus(working, null, 'm1'), {
      ...working,
      lastCheck: 'green',
    });
    assert.deepEqual(checkStatus(working, 'lint', 'm1'), {
      ...working,
      lastCheck: 'failed: lint',
    });
  });
});

describe('agentAlive and afterAgent: an agent that ended', () => {
  const working = {state: 'agent', agentPid: 42, startedAt: 0};

  it('counts the agent as working while its process lives, for at most 6 hours', () => {
    assert.ok(agentAlive(working, () => true, HOUR_MS));
    assert.ok(!agentAlive(working, () => false, HOUR_MS));
    assert.ok(!agentAlive(working, () => true, 7 * HOUR_MS), 'hung');
    assert.ok(!agentAlive({state: 'green'}, () => true, HOUR_MS));
  });

  it('is green when its last check passed and it left the checkout clean', () => {
    assert.deepEqual(afterAgent({...working, lastCheck: 'green'}, false, 0), {
      next: 'green',
      reason: '',
    });
  });

  it('blocks when it left the branch behind main, even with a green check', () => {
    const status = {...working, reason: 'conflict', lastCheck: 'green'};
    const result = afterAgent(status, false, 3);
    assert.equal(result.next, 'blocked');
    assert.match(result.reason, /still 3 commits behind main/);
  });

  it('blocks when it ended without a green check or left changes behind', () => {
    for (const [status, dirty] of [
      [{...working, reason: 'conflict'}, false],
      [{...working, reason: 'conflict', lastCheck: 'failed: lint'}, false],
      [{...working, reason: 'conflict', lastCheck: 'green'}, true],
    ]) {
      const result = afterAgent(status, dirty, 0);
      assert.equal(result.next, 'blocked');
      assert.match(
        result.reason,
        /^the agent ended without a result \(conflict/,
      );
    }
  });
});
