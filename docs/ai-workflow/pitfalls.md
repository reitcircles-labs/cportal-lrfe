# Pitfalls met so far, and their fixes

Mined from the session transcripts (API-789, 476 user messages and every tool error). Cause → fix.

## Tools

- **Write or Edit on a file not read in this session** (the most frequent error, 30×) → Read it first,
  or make the change with a short script when its text is known.
- **Jira `transitionJiraIssue` without `transitionId`**, **`createJiraIssue` without `issueType`** →
  always pass them (11 In Progress, 21 Done; "Task", "Epic").
- **Jira HTML comments with `<b>`** are rejected → `<strong>`; or write the comment in markdown.
- **Inline images in a comment** need the upload's `data.id` and the collection name; one upload token
  covers the whole collection (`docs/ai-workflow/jira.md`).
- **A foreground `sleep`** is blocked → run long work in the background and wait for its notification.
- **An unquoted heredoc** (`<<EOF`) runs the backticks and `$( )` inside it → `<<'EOF'`, and pass values
  through the environment.
- **Old git** (no `merge-tree --write-tree`) → dry-run a merge in a throwaway worktree. **No `gh`
  CLI** → the user gives the PR links. **No `pdftoppm`** → render PDFs with `gs -sDEVICE=png16m`.
- **`eslint --fix` after `prettier --write`** can leave a file unformatted (it added braces), and CI's
  `npm run format:check` fails → run prettier last, then both checks on a clean copy of the branch
  (`git worktree add` of the commit), since local scratch files can hide or add findings.

## Dependencies and environment

- **`Cannot find package …` after a merge** (`@fastify/rate-limit`, `js-yaml`) → `npm ci` where the
  lock file changed; a host-side check (the API docs check in e2e) is the first to fail.
- **Port 8080 belongs to another user's process** → the demo runs on 8088.
- **Rootless Docker** needs `slirp4netns` (passt isn't supported by this Docker).
- **A throwaway PostgreSQL that won't start** (ECONNREFUSED) → a stale data dir or a port in use: read
  its log, use a fresh dir and the checkout's ports.

## Docker Compose and the demo install

- **`--profile x`** replaces `COMPOSE_PROFILES`: a `down` with it misses the other profiles'
  containers → set `COMPOSE_PROFILES` to every profile used.
- **"dependency failed: … unhealthy"** on a fresh install with OpenBao → OpenBao is sealed or not set
  up: initialise, unseal and run the setup first. A malformed unseal key: "'key' must be valid hex".
- **`docker inspect` templates on `.State.Health`** fail for a container without a health check →
  guard the template, or read `.State.Status`.
- **`up --wait` exits 1 on the very first start** of an empty install while it settles → run it once more
  before calling it a failure.
- **Unset `LRFE_TIME_ZONE`** → the extract PDF prints UTC, unlike the screens.

## Playwright and e2e

- **Strict mode violations** (13×): two matching elements (a second h1, a toast) → scope the locator to
  its section or dialog.
- **30-second timeouts** (25×) → wait for an explicit state (`expect(...).toHaveText`), not a fixed
  time; give known slow steps a longer timeout.
- **A flaky step in a serial suite** → comment out that step only, with the reason; `test.fixme` on
  the whole test breaks the later tests that need what it creates.
- **Batches on the test blockchain** take every waiting version → a spec that makes batches runs in its
  own project, after the main suite.
- **The public check's rate limit** → the test stacks raise `PUBLIC_RATE_LIMIT_MAX`.
- **Screenshots at 1440 px** hid the side panel → take evidence at 1600 px, on the committed code.
- **A component class named like a global one** (`.bar`) hid a header that the assertions didn't
  cover → check the screenshots (by agent) before trusting a passing run on layout.
- **Navigating to the URL already shown** does nothing in a hash-routed app → `about:blank` first.
- **A script that imports the services' code loads `backend/.env`** (`@lrfe/common` runs dotenv),
  so `DB_CONNECTION_STRING` there names the developer's own database → the scale scripts take only
  `SCALE_DATABASE_URL`, never `DB_CONNECTION_STRING`.
