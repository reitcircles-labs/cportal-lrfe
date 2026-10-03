# End-to-end tests

The web app and the backend together, driven in a real browser by [Playwright](https://playwright.dev).
Each run starts its own stack, everything in memory, so it always begins from the same known state
and never touches a real database, bucket, AI or mail server.

## Running

First time only:

```bash
cd e2e
npm install
npm run install-browser     # downloads Playwright's Chromium (see "Ubuntu 20.04" below)
```

Then:

```bash
npm test                    # starts the stack, runs every test, stops the stack (about two minutes)
npm run test:postgres       # the same on PostgreSQL instead of memory (see "On PostgreSQL")
npm run report              # opens the HTML report of the last run
npx playwright test tests/sign-in.spec.ts       # one file
npx playwright test -g "rev \(a.mwandingi\)"    # tests whose title matches
```

A failing test keeps a screenshot, a video and a **trace** under `test-results/`. The trace is a
step-by-step recording of the page, the network and the console:
`npx playwright show-trace test-results/<test>/trace.zip` (or open it from the report).

**Ports.** The test stack uses 3600 (gateway), 3601–3604 (identity, edrms, bpm, intake), 3605
(NATS) and 4300 (the web app), so it runs next to `npm run dev` (3500–3504, 4200). If a test port is busy the run
stops instead of testing whatever is there. Other ports: `E2E_API_PORT=3700 E2E_WEB_PORT=4400 npm test`.

**Keeping the stack up** between runs (faster while writing tests):

```bash
node stack/start-backend.mjs                                         # terminal 1
cd ../angular-app && npx ng serve --port 4300 --proxy-config ../e2e/stack/proxy.e2e.mjs   # terminal 2
E2E_REUSE=1 npx playwright test                                      # terminal 3, as often as needed
```

Tests that change data then see what earlier runs left behind; restart the stack for a clean one.

## Screenshots for Jira

Tests can take named screenshots at their checkpoints, to attach to the Jira ticket they cover:

```bash
npm run evidence -- API-606            # one ticket; several: npm run evidence -- API-606 API-609
```

This runs only the tests tagged with those tickets, with screenshots on, and lists what it took:
`evidence/<ticket>/NN-<title>.png`, numbered in order, plus `manifest.json` with each title, the
test and the commit it was taken on ("+ uncommitted changes" when the tree was not clean). The folder
is gitignored and replaced on every run. Ordinary `npm test` runs take no screenshots.

In a test, tag it with its tickets and call `evidence()` (from `support/evidence.ts`) where a
screenshot shows what the step proves:

```ts
test('…', { tag: ['@API-606'] }, async ({ page }) => {
    …
    await evidence(page, 'API-606', 'Auditor: integrity of version 1.0 verified');
});
```

Scroll the element that matters into view first (`locator.scrollIntoViewIfNeeded()`); full-page
screenshots come out garbled because the app's sidebar and top bar are fixed. The screens show only
the test stack's fictitious data.

## On PostgreSQL

`npm run test:postgres` (or `E2E_DB=postgres` with any Playwright command) runs the same services on
PostgreSQL, with documents stored as files, instead of in memory. The stack creates a private,
throwaway PostgreSQL instance under `.stack/pg` with the server binaries already on the machine
(`PG_BIN`, or the newest `/usr/lib/postgresql/<version>/bin`), on port 3606, TCP only, and stops and
removes it at the end. It never touches another database on the machine. No Docker needed.

## In CI

`.github/workflows/tests.yml` runs the backend unit tests, the API docs check and this suite on
every pull request and push to main; nightly (01:00 UTC) and on demand it also runs the suite on
PostgreSQL. A failed run keeps the HTML report and the screenshots, videos and traces as artifacts.

## What the stack is

`stack/start-backend.mjs` starts the five services with in-memory stores, the AI replaced by its
canned answer (`EXTRACTION_PROVIDER=mock`), emails written to `.stack/mail/` and the 14 fictitious
demo users seeded (identity's `DEMO_USERS`), and a NATS server of its own as the event bus between
the services (`backend/scripts/nats.js`; the first run downloads it into `backend/.tools/`). Each service runs in an empty folder under `.stack/`,
so it does **not** read your `backend/services/<name>/.env`. Playwright also starts a second
`ng serve` on port 4300 whose proxy points at the test gateway (`stack/proxy.e2e.mjs`).

## What is tested

| File | What |
|---|---|
| `tests/auth.setup.ts` | Runs first: enrols every demo user's authenticator (MFA is on by default) and keeps the secrets in `.auth/totp.json` |
| `tests/sign-in.spec.ts` | Sign-in screen for each role (lands on the role's home), wrong password, wrong code, suspended and invited users, first-time authenticator setup, reload keeps the session, sign-out ends it |
| `tests/screens-by-role.spec.ts` | Each role × each screen: the menu shows exactly the allowed screens; an allowed screen opens with its title, with no server errors and no 403 from its own API calls; a forbidden one shows "Access denied" |
| `tests/api-by-role.spec.ts` | Each role × each protected endpoint, at the API: refused with 403 without the permission, let through with it; 401 without a token; service-only endpoints refuse user tokens |
| `tests/deed-workflow.spec.ts` | One deed from scan to sealed record, passed between people: the scan operator uploads it, a reviewer corrects a field, accepts the rest and files it, the records officer sees it (without audit or correction rights), the auditor checks its integrity, a reviewer requests a correction, a second reviewer approves it from the task inbox (the requester does not get the task), and the auditor checks version 2.0 |
| `tests/administration.spec.ts` | As the system administrator: add, edit, suspend and reactivate an office; invite a user who activates the account from the email (read from `.stack/mail/`) and signs in for the first time; role changes decide what the user can open; a duty conflict is flagged before and after saving; a suspended user is signed out and refused until reactivated; policies and the permission matrix are saved, take effect and are put back. Each checked in the access log. |
| `tests/edge-cases.spec.ts` | The less travelled paths: a reviewer rejects a document (the scan operator sees why); two reviewers on one document (the second can look, not change, until the first leaves); a correction rejected by the approver (reason required, record unchanged) or withdrawn by the requester; a TIFF refused at capture; the same scan captured twice; a deed already in the EDRMS flagged and refused; the service refusing to file an unreviewed document |
| `tests/land-record.spec.ts` | The tester guide's records-officer steps: the sample documents in `angular-app/docs/samples/` are filed, then linked into Erf 1873 on the Land record screen, which is finalized with the right owners (the screen is demo data except for this link to the live EDRMS) |

Land records (`#/link`) and Audit (`#/audit`) still show demo data, so the workflow stops at the
EDRMS: linking the document into a land record and the auditor's sign-off follow when those
services exist.

**Sample scan.** `support/deed.ts` draws a fictitious deed of transfer as a one-page PDF in the
browser, so no binary file is kept in the repository. Its wording matches the intake service's canned
AI answer (T 2210/2008, Erf 1873, Klein Windhoek), so the reviewer's fields agree with the scan.

The roles run as one demo user per role plus the two demo users with two roles (`scan+rev`,
`rev+aud`), whose permissions are the union.

### Where the expectations come from

The matrices are not written out by hand; they are read from the application, so a change to a role,
screen or endpoint is tested without editing the tests (`support/catalogue.ts`):

| Expectation | Source |
|---|---|
| Roles, their permissions and home screens | `backend/services/identity/src/catalogue.js` |
| Users | `DEMO_USERS` in `backend/services/identity/src/seed.js` |
| Screens: path, permission, title | `angular-app/src/app/app.routes.ts` (read as text; an unreadable route fails the run) |
| Endpoints and their permission rules | `backend/services/gateway/docs/openapi.yaml`, generated from the route guards |

Because the API matrix reads the generated docs, its first test runs `npm run docs:check` and fails
if they are out of date: after changing a route, run `npm run docs` in `backend/`.

The API matrix sends only GETs with a role that is allowed (they cannot change anything) and sends
writes only with roles that must be refused, so it leaves the stack's data as it was.

## Writing tests

- Sign in with `signInAs(page, email, path)` from `support/auth.ts`: the API sign-in with the
  authenticator code, then the page opens already signed in. Sessions cannot be saved and reused
  between tests (Playwright's `storageState`): the refresh token changes on every use and the
  server ends a session whose old token comes back.
- Don't wait with `waitForLoadState('networkidle')`: a scan shown in the PDF viewer is a request that
  never finishes in the headless browser. Use `trackApi(page)` from `support/api-idle.ts`, which
  waits for the app's API calls only.
- A test that needs a document at a later step gets one from `support/intake.ts`:
  `readyDocument()` (read by the canned AI, waiting for review) or `filedDocument()` (in the EDRMS).
  Each gets its own deed number (`sampleDeed()`): the EDRMS files each deed once, and the canned AI
  reads the number from the file name (`deed-T4821-2008-….pdf`).
- A test that needs a fresh user (so it does not change a demo user other tests rely on) creates one
  with `createUser(adminApi, roles)` from `support/admin.ts`: invited, activated from the email and
  enrolled in MFA through the API.
- An open bug can be pinned with a test marked `test.fail(true, 'API-…: …')`: it stays green while
  the bug is there and turns red ("expected to fail, but passed") once fixed, the cue to remove the mark.
- Find elements the way a user does: `getByRole`, `getByLabel`, `getByText`. Add a `data-testid` to
  the Angular template only where that is ambiguous.
- Each test signs in again, often as the same user in the same 30-second window. That works because
  identity does not yet block a reused code (the TODO in `verifyMfa`). When it does, the tests need
  one sign-in per user and worker, shared through a fixture.

## Ubuntu 20.04

Playwright no longer ships a Chromium build for Ubuntu 20.04. `npm run install-browser` downloads the
Ubuntu 22.04 build instead (`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu22.04-x64`), which runs on
20.04. On a newer system `npx playwright install chromium` is enough. If neither works, the official
Docker image `mcr.microsoft.com/playwright` has everything.
