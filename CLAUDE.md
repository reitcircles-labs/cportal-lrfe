# Land records portal (cportal-lrfe): working rules

A general land registry portal (Namibia is the first client): Angular app, Fastify services, PostgreSQL,
NATS, OpenBao, anchoring on a blockchain. Work is tracked in Jira (project API) and done ticket by ticket.
These rules apply to every ticket; the details are in `docs/ai-workflow/`, read only when a task needs them.

## Git and branches

- **Never merge; push only through the `pr-opener` agent** (`scripts/open-pr.mjs`), and **only when the
  user asks for it in that conversation** (an earlier yes does not carry over): a ticket branch, never
  `main`, never forced, and its PR against `main`, which starts the pipeline. The user merges. Commit only by explicit paths (never `git add -A` or `.`); the
  message starts with the ticket key (`API-123 …`) and ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **One branch ↔ one directory.** New work: `git fetch origin`, then a new branch off `origin/main`, named for the
  epic or ticket. Parallel work goes in a separate clone (`~/projects/cportal-lrfe-<epic>`), never a second
  branch in the same directory.
- **When an epic is done, stop:** list the branch and its commits, and ask the user whether to open its
  PR with `pr-opener` (their call), then to merge. No new work in that directory until they confirm, and check `origin/main` contains it.
- Never commit `backend/services/identity/scripts/nginx-cportal-lrfe.conf`, `backend/nohup.out`,
  `demo/readiness.txt`, scratch files or generated data.
- After a merge or branch switch, install dependencies when a lock file changed (`npm ci` in `backend/`,
  `e2e/`, `angular-app/`), before running tests.

## A ticket, start to close (no per-ticket approval needed)

Starting: the `new-checkout` skill. Closing: the `ticket-close` skill. Agents in `.claude/agents/`:
`reviewer` (the review gate), `e2e-runner`, `ui-evidence-checker`, `jira-reporter`, `demo-release`,
`scale-tester`, `pr-opener` (push and PR, then the checks), `notifier` (emails the user when work waits on their decision).

1. Read the ticket and its "Agreed design"/"Done when"; move it to In Progress (transition 11). A new
   screen needs a design the user has agreed (a design artifact or ticket) before it is built.
2. Build only the agreed scope: no extra endpoints, screens or settings ("don't manufacture
   requirements"). Optional ideas: one line at most.
3. Verify: unit tests, lint and format (`npm run -s lint`, `npm run -s format:check` at the root),
   `cd backend && npm run docs:check`, the e2e suite in memory and on PostgreSQL (`docs/ai-workflow/e2e.md`).
4. A **review agent** checks the uncommitted diff against "Done when", these rules and the Google TS
   style guide. Fix blocking findings; ask the user only for decisions that are theirs.
5. Jira: a "What changed" comment and a "Test results" comment (plain English, short bullets, bold
   lead-ins), and for UI work the **screenshots embedded in a captioned comment** before closing
   (`docs/ai-workflow/jira.md`). Commit, comment the hash, close (transition 21).

## Product rules

- **No backend tool or vendor names in the UI**: not Jev, TypeSafe, Gemini, Cardano, OpenBao. Screens say
  "blockchain", "automatic check". Technical docs may name them. The admin AI-costs screen is the exception.
- **Multi-country:** no hard-coded organisation, country, office or legal convention; site settings, with
  Namibian values only as defaults or demo data. Country-specific logic belongs to the country pack (API-713).
- **Rare-event fixes must not change normal behaviour** (no shorter sessions to handle a revocation, etc.).
- **Audit model:** only on-chain data can be trusted; one sign-off per checkpoint; findings block it; the
  approver owns the record (details: `docs/ai-workflow/product.md`).
- **Code:** Google TypeScript Style Guide (JS backend: the rules that apply), readable by a person: named
  exports, JSDoc, braces, no dense one-liners. Match the comment density of the surrounding code.

## The demo install and the blockchain node: never harm them

- The demo install is compose project `lrfe` in `deploy/` (port 8088, `deploy/.env`). **Never** delete the
  volumes `lrfe_cardano-db` or `lrfe_bao-data`, never `docker compose down -v` or `volume prune` there,
  never stop, restart or recreate the `cardano` or `openbao` containers or the user's preview node.
- A new demo version: `node demo/release.mjs` via the `demo-release` agent (`.claude/agents/`); the user
  chooses upgrade (data kept) or fresh (data erased). Test on the throwaway project `lrfe-rehearsal`.
- Details: `docs/ai-workflow/demo-install.md`.

## Ports per checkout (e2e, load tests)

`~/projects/cportal-lrfe`: 3600/4300 · a second clone: 3700/4400 · `cportal-lrfe-api768`: 3800/4500 ·
demo 8088 · rehearsal 8716. Set `E2E_API_PORT`/`E2E_WEB_PORT` for anything outside the main checkout.

## Keep the context small (it is the main cost)

- **Never open screenshots in the main conversation** unless the user asks to see one: a subagent checks
  them against the design or storyline and answers in text.
- Slim tool output: Jira calls with `responseFields`; tests write `e2e/.progress/progress.log` (API-813): read its totals
  and failures; read logs with `tail`/`grep`, never whole.
- Delegate broad searches, reviews, log triage and long background runs to agents (lower effort for
  mechanical briefs). Send independent calls in parallel; turn multi-step shell work into one script.
- One context per ticket: after closing a ticket, the record is in Jira, git and memory; start fresh.
- Pitfalls met so far, with their fixes: `docs/ai-workflow/pitfalls.md`.

## Communicating

- Plain, short English to the user, the same in Jira. Report results faithfully (failures with their
  output). Never print secrets; never send the user's email address to other services.
- **Every test or long run can be followed with `tail -f`:** its output goes to a log file as it runs,
  and the user gets the `tail -f <log>` command when it starts. No run without one, by an agent or not.
- **Stuck on the user's decision or action:** send it by email through the `notifier` agent (ticket,
  question, options with a recommendation, where the details are), then go on with what doesn't wait on it.
- Asked for progress: one short status with counts ("e2e 89/98, 0 failed; next: deploy").
- The user cannot copy from the terminal: values to copy (addresses, transaction ids, URLs) also go
  into a file, and its full path is given.
- Don't stop on self-imposed caution when the work is isolated (another directory, a throwaway
  install); do stop for the user's decisions (scope, data loss, design) and at the end of an epic.
- Operations and settings changed by a ticket are written into the README or install guide they
  belong to.
