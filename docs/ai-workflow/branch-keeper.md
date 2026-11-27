# The branch keeper (API-851)

Tickets built in parallel, each in its own clone, drift from `main` and used to meet each other only
at merge time. The branch keeper keeps every registered ticket branch up to date with `main`, so
each one stays ready for its pull request.

## How it works

`scripts/branch-keeper.mjs run`, every 10 minutes from cron, looks at each registered checkout:

1. `git fetch`; if the branch already contains `origin/main`, nothing happens (no agent, no tokens).
2. **Only at a safe moment:** no uncommitted changes (untracked files don't count) and no test run
   going in the checkout. Otherwise it waits for the next check.
3. **Merge, never rebase:** it merges `origin/main` into the branch with the commit
   `<KEY> Update from main`. A pushed branch is never rewritten, so an open PR just gets the new commit.
4. `npm ci` where a `package-lock.json` changed, then **lint, format and the unit tests** (every
   `test:*` script of the root and `angular-app`, and `npm test` in `backend`). The e2e suites run
   before the PR, as part of `ticket-close`, not on every update.
5. A **merge conflict** or a **failing check** starts the `branch-keeper` agent headless
   (`.claude/agents/branch-keeper.md`). It resolves or adapts, commits, reruns the checks, and leaves
   the branch green, or marks it **blocked** and emails the user (`~/lrfe-data/notify.mjs`) when
   the fix is the user's decision. Before blocking, an unfinished merge is undone so the checkout is
   left clean. A blocked branch is left alone until `main` moves again.

It never pushes, rebases, resets, force-pushes, switches branches or writes to `main`: every git
command of the script goes through one guard (`assertSafeGit`); the agent may run only git's
everyday commands, `npm run`/`npm test`/`npm ci` and the keeper script, with push, rebase, reset,
checkout and `--amend` disallowed, and it runs with git's network transfers switched off
(`GIT_ALLOW_PROTOCOL=none`), so no push can leave the machine. The tests check all three (`npm run test:branch-keeper`). While the agent works,
its checks are added to its state (`lastCheck`) and the keeper waits; when it ends, a green last
check on a clean checkout that contains main counts as green, anything else is blocked. An agent
is trusted for at most 6 hours. Pushing stays with `pr-opener`,
on the user's request.

**What it cannot see:** two parallel branches that are both unmerged. Each is kept working with the
current `main`; when the first is merged, the second adapts at its next check.

## Using it

```bash
node scripts/branch-keeper.mjs register ~/projects/cportal-lrfe-<epic>   # after new-checkout makes the clone
node scripts/branch-keeper.mjs status                                     # one line per checkout
node scripts/branch-keeper.mjs unregister ~/projects/cportal-lrfe-<epic> # when its PR is merged
```

Every clone made for a ticket is registered as soon as it is on its ticket branch (the
`new-checkout` skill does it). A registered directory that no longer exists (the clone was
deleted) is unregistered by the next `run`, which writes a line to that checkout's log.

`register` refuses a checkout that is not on a ticket branch (`api-123-…`, `cb-45-…`) and records
the `node` and `claude` programs to use, since cron has a short `PATH`.

Files, in `~/lrfe-data/branch-keeper/`:

| File | What |
| --- | --- |
| `<checkout>.log` | the progress log: `tail -f` it |
| `<checkout>.json` | the state: `green`, `up-to-date`, `updating`, `agent`, `failed` or `blocked` with the reason |
| `<checkout>-check.log` | the output of the last checks |
| `<checkout>-agent.log` | the agent's output |
| `checkouts.json` | the registered checkouts |
| `cron.txt` | what each cron run printed |

The cron line (`crontab -e`; the node path is the one `register` records):

```cron
*/10 * * * * $HOME/.nvm/versions/node/v24.22.1/bin/node $HOME/projects/cportal-lrfe/scripts/branch-keeper.mjs run >> $HOME/lrfe-data/branch-keeper/cron.txt 2>&1
```

For a trial on a throwaway repository, set `BRANCH_KEEPER_DATA=<folder>` (its own state files) and
`BRANCH_KEEPER_NOTIFY=off` (no email).
