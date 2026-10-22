# Running the e2e tests

The full guide is `e2e/README.md`; this page is what a ticket needs, in the order it needs it.

## The runs a ticket needs

From `e2e/`, with the checkout's ports (`CLAUDE.md`, "Ports per checkout"):

```bash
npx playwright test --reporter=line 2>&1 | tail -n 5               # in memory
npm run -s test:postgres -- --reporter=line 2>&1 | tail -n 5       # on PostgreSQL
```

- Run them in the background and wait for the notification; read only the totals and the failures
  (`grep -nE "^\s+[0-9]+\) \[" -A16 <log>`), never the whole log.
- Before a run after a merge or branch switch: `npm ci` where a lock file changed. A missing package
  shows up as `ERR_MODULE_NOT_FOUND` in a host-side spec (the API docs check), not as a product failure.
- Release images: `node demo/release.mjs test --version <v>` (the docker e2e, its log written as it runs).

## Projects and order

`playwright.config.ts` runs `setup` (enrols the demo users), then `chromium` (the main suite in
parallel), then `own batches` (`ownership-extracts.spec.ts`), then `extract check`
(`check-extract.spec.ts`). Specs that make their own blockchain batches
(`POST /api/audit/test/anchorings`) must not run beside `land-record.spec.ts`: a batch takes every
waiting version. A new spec that makes batches gets its own project after the others.

To run one spec alone: list its setup too and drop the dependencies, one worker:

```bash
npx playwright test tests/auth.setup.ts tests/<spec> --project=setup --project='<project>' --no-deps --workers=1 --reporter=line
```

## Screenshots for Jira

`await evidence(page, 'API-123', '<caption>')` in the spec; `npm run evidence -- API-123` runs the tagged
tests with screenshots on and numbers them into `e2e/evidence/API-123/` with a `manifest.json` of
captions. For one spec only (for example one that runs after the main suite):
`npm run evidence -- API-123 --spec tests/<file>.spec.ts`. Upload: `docs/ai-workflow/jira.md`.

Check the screenshots with an agent (does each match the design or storyline?), not in the main
conversation.

## Writing tests that stay stable

- Serial suites (`test.describe.serial`) share state: later tests use what earlier ones created.
  Never `test.fixme` one of them to silence a flaky step; comment out only that step, with the reason.
- Navigating to the URL the page already shows does nothing in a hash-routed app: go to
  `about:blank` first, or reload.
- The public check is rate-limited per client address: the test stack raises the limit
  (`PUBLIC_RATE_LIMIT_MAX`); a state that the stack cannot produce on demand is shown with
  `page.route` and a made-up answer, said so in the spec's header.
- A class name in a component can collide with a global style (`.bar` hid a header): look at the
  screenshot (by agent) before trusting a passing assertion on layout.
