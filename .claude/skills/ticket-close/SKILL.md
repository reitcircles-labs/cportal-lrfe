---
name: ticket-close
description: Closes a ticket the project's way once its work is done - the e2e runs and screenshots by agents, the review gate, the commit by explicit paths, the Jira comments and the transition - keeping test logs, screenshots and Jira answers out of the main conversation. Use when a ticket's code is written and its unit tests pass.
---

# Closing a ticket

The rules are in `CLAUDE.md`; this is the order, with the agents that keep the main conversation small.

1. **Checks you run yourself:** `npm run -s lint`, `npm run -s format:check` (root), the touched
   packages' unit tests, `cd backend && npm run -s docs:check` if routes changed. Read only totals.
2. **e2e** (when the ticket touches behaviour): the `e2e-runner` agent, in the background, with the
   checkout and its ports: the suite in memory and on PostgreSQL, and `npm run evidence -- <KEY>`
   (or `--spec <file>`) when the ticket has screens. Wait for its report.
3. **Screenshots:** the `ui-evidence-checker` agent with the evidence folder and the reference (the
   ticket's agreed design, the storyline section). Fix what it finds and repeat 2–3. Don't open the
   pictures yourself unless the user asks.
4. **Review gate:** the `reviewer` agent with the ticket key, its "Done when" and what was exercised.
   Fix blocking findings and run it again; take the non-blocking ones that are cheap; ask the user only
   for decisions that are theirs.
5. **Commit:** `git add <explicit paths>`; message `<KEY> <what it does>`, a few bullets, and
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push only through the `pr-opener` agent
   (step 8), never `git push` by hand.
6. **Jira:** for UI work, upload the screenshots here in the main conversation
   (`docs/ai-workflow/jira.md`; agents can't), then the `jira-reporter` agent with the key, the facts
   (changes, test numbers, commit, branch), the uploaded ids with their captions, and "close" (or why
   it stays open).
7. **Memory:** update the open-threads note when something is now waiting on the user. If this was
   the epic's last ticket: stop, list the branch and its commits, and ask the user to push and merge.

8. **Pull request, only when the user asks for it** (ask them at the epic's last ticket; never on your
   own): the `pr-opener` agent with the checkout, the key(s), the title and the facts. It pushes, opens the PR
   against `main` (the pipeline starts) and reports the checks. A failed check: fix it here, commit, and
   run `pr-opener` again (the push updates the PR). Never merge.

Tell the user in a few lines what changed, the test numbers and what is waiting on them.
