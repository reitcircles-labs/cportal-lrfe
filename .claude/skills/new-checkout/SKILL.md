---
name: new-checkout
description: Starts a piece of work (an epic or ticket) on the right branch and directory - by default a new branch off an up-to-date main in this checkout, one piece of work at a time; a separate clone only when the user asks for parallel work. Use when the user asks to start an epic or a ticket that is not on the current branch.
---

# Starting work in the right place

One branch ↔ one directory (`CLAUDE.md`, "Git and branches"). Work goes **one piece at a time**:
parallel branches can depend on each other in ways nobody sees beforehand (the same lines, a helper
one renames and the other uses, code one needs from the other), and the cost shows up at merge time.

1. `git fetch origin`. Check `git status` for uncommitted changes, and whether the directory's
   current branch holds unmerged work (`git log origin/main..HEAD` not empty).
2. **Unmerged work here: stop and ask the user.** Never choose a clone or another directory yourself.
   Ask, naming the branch and its commits, with these options:
   - **Merge it first (recommended):** push it and open its PR with `pr-opener` (only on the user's
     yes), the user merges, then step 3 from the new `origin/main`.
   - **Stack on it:** when the new ticket needs that work, branch from it
     (`git checkout -b <name> <current branch>`); its PR goes in after the first one is merged.
   - **Parallel in a separate clone:** only when the user chooses it (step 4).
3. **In this checkout:** `git checkout -b <epic-or-ticket-name> origin/main` (for example
   `api-794-demo-release`).
4. **In parallel, only on the user's instruction:** a clone, not a worktree:
   `git clone <origin url> ~/projects/cportal-lrfe-<epic>`, the branch off `origin/main`, `git config`
   user.name and user.email as in this checkout, `npm ci` in the root, `backend/`, `angular-app/`, `e2e/`.
   Give it free ports (`CLAUDE.md`, "Ports per checkout": 3700/4400, 3800/4500, …) and use them for
   every e2e or load-test run there. **Always** register it with the branch keeper as soon as the
   clone is on its ticket branch (`node scripts/branch-keeper.mjs register <clone>`,
   `docs/ai-workflow/branch-keeper.md`): it merges each new `main` into the branch and keeps it
   green, so the two branches never meet only at merge time. Unregister it when its PR is merged;
   a clone that is deleted is unregistered by the keeper's next run.
5. Move the first ticket to In Progress (project API: transition 11; project CB: transition 21,
   check with `listJiraIssueTransitions` for others) and write a memory note: the directory, the
   branch, its ports, the epic.

Tell the user in one line where the work is and on which branch.
