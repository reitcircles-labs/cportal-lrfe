---
name: new-checkout
description: Starts a piece of work (an epic or ticket) on the right branch and directory - a new branch off an up-to-date main in this checkout, or a separate clone with its own ports for work that runs in parallel. Use when the user asks to start an epic or a ticket that is not on the current branch.
---

# Starting work in the right place

One branch ↔ one directory (`CLAUDE.md`, "Git and branches").

1. `git fetch origin`. Check the directory's current branch: if it holds unmerged work
   (`git log origin/main..HEAD` not empty), that work must be merged first; ask the user to push and
   merge it, or use a separate clone. Check `git status` for uncommitted changes.
2. **In this checkout:** `git checkout -b <epic-or-ticket-name> origin/main` (for example
   `api-794-demo-release`).
3. **In parallel, with other work going on here:** a clone, not a worktree:
   `git clone <origin url> ~/projects/cportal-lrfe-<epic>`, the branch off `origin/main`, `git config`
   user.name and user.email as in this checkout, `npm ci` in the root, `backend/`, `angular-app/`, `e2e/`.
   Give it free ports (`CLAUDE.md`, "Ports per checkout": 3700/4400, 3800/4500, …) and use them for
   every e2e or load-test run there.
4. Move the first ticket to In Progress (transition 11) and write a memory note: the directory, the
   branch, its ports, the epic.

Tell the user in one line where the work is and on which branch.
