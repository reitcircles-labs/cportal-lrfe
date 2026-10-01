# cportal-lrfe backend

Backend services for the Namibia land-records app in `../angular-app`: EDRMS intake (capture →
extract → verify) and the ERP land-records register (link → finalize → audit).

ESM throughout (`"type": "module"`), Node ≥ 20, npm workspaces. Same open-source stack as
`cportal-be` — Fastify, Sequelize + Postgres, JWT, dotenv, mocha/chai/sinon — on current major
versions (Fastify 5; Fastify 4 and its JWT/proxy plugins have unpatched critical advisories).

## Layout

```
backend/
├── packages/common/        @lrfe/common — shared by every service (import, don't copy)
│   └── src/  config · errors · db · auth (JWT + permission guards) · events · app bootstrap
└── services/
    ├── gateway/            :3500  single /api entry point for the browser; proxies to services
    ├── identity/           :3501  sign-in + MFA, sessions, users, roles, policies, access log
    ├── edrms/              :3502  sealed, versioned documents of record (S3 / local / memory storage)
    ├── bpm/                :3503  workflow engine: processes, task inbox, four-eyes approvals
    └── intake/             :3504  capture, AI extraction (Gemini), field review, filing into edrms
packages/storage/                  @lrfe/storage — S3 / local / memory blob stores, signed file links
```

Planned next: connect the frontend's Capture and Verify screens to intake; **land-records**
(ERP records, linking, finalize); **audit** (hash-chained trail, sign-off, evidence export); **search**.

## Running

```bash
npm install
cp .env_example services/identity/.env     # edit; see the comments in the file
cp .env_example services/gateway/.env

# All five services in one terminal (watch mode, each reads its own .env; Ctrl+C stops all)
npm run dev
npm run dev -- identity gateway            # only some of them

# Quickest: no database, seeded with the 14 demo users; documents stored in ./tmp
IDENTITY_STORE=memory SEED_DEMO_PASSWORD='demo-password-2026' npm run dev:identity
EDRMS_STORE=memory EDRMS_STORAGE=local npm run dev:edrms
BPM_STORE=memory npm run dev:bpm
INTAKE_STORE=memory npm run dev:intake     # extraction uses the mock model unless EXTRACTION_PROVIDER=gemini
npm run dev:gateway

# With Postgres from docker compose (published on localhost:5433;
# DB_CONNECTION_STRING=postgres://lrfe:lrfe@localhost:5433/lrfe)
docker compose up -d postgres
npm run seed:identity                      # creates schema "identity", tables, roles, admin
npm run dev:identity
```

Everything in containers (Postgres + all five services, one image built from `Dockerfile`):

```bash
JWT_SECRET=… SEED_DEMO_PASSWORD='demo-password-2026' docker compose up -d --build
# gateway on http://localhost:3500 (what the frontend's proxy.conf.json points at)
```

Settings come from the shell or `./.env`; see the header of `docker-compose.yml`. Stop any
`npm run dev:*` services first: they use the same ports.

Tests (no database or network needed): `npm test` at the root, or `npm test -w @lrfe/identity`.

## How the services fit together

- The browser only talks to the **gateway** (`/api/...`). The gateway strips the prefix and
  proxies; it does **not** check tokens.
- **Every service verifies the JWT and checks permissions itself** (`app.authenticate`,
  `app.requirePerm(...)` from `@lrfe/common`), with the shared `JWT_SECRET`. The frontend's
  route guards are only for display. Guards are registered as `onRequest` hooks, so an
  unauthenticated request is refused before its body is parsed or validated.
- Access token claims: `{ typ: 'access', sub, name, email, roles, perms, sid }`, valid 15 min.
- Each service owns one Postgres schema (`identity`, later `edrms`, `intake`, …) and never reads
  another service's tables.
- Services publish domain events (`identity.user.invited`, `edrms.document.filed`, …) through
  `createEventBus()`. Today the driver only logs; the audit service will add a broker driver
  (Pub/Sub) and a transactional outbox.
- Service-to-service calls use short-lived service tokens (`signServiceToken(app, 'intake')`,
  guarded by `app.requireService('intake')`). User tokens never pass a service guard, and
  service tokens never pass a user guard.

## Identity API (via gateway)

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /api/auth/login` `{email, password}` | public | → signed in, or `{next: 'mfa' \| 'mfa-enroll', challenge, secret?, otpauthUrl?}` |
| `POST /api/auth/mfa` `{challenge, code}` | public | TOTP step; enrols on first use |
| `POST /api/auth/refresh` | refresh cookie | new access token, rotates the cookie |
| `POST /api/auth/logout` | refresh cookie | ends the session |
| `POST /api/invitations/accept` `{token, password}` | public | activate an invited account |
| `GET /api/auth/me` | signed in | user, roles, perms, home route, timeout/four-eyes policy |
| `GET /api/catalogue` · `GET /api/roles` | signed in | permission groups/labels, the six roles |
| `GET /api/users` · `POST /api/users` | `admin.users` | list (with SoD conflicts) · invite |
| `PUT /api/users/:id/roles` | `admin.users` | assign roles |
| `POST /api/users/:id/suspend` · `/reactivate` · `/mfa-reset` · `/invitation` | `admin.users` | account actions (`{reason}` optional) |
| `PUT /api/roles/permissions` `{matrix: {roleId: [perm]}}` | `admin.roles` | edit the permission matrix |
| `GET /api/policies` | `admin.policies` or `admin.users` | policies + SoD rules |
| `PUT /api/policies` `{policies, sod: [{id, on}]}` | `admin.policies` | save |
| `GET /api/access-log?kind=&limit=&offset=` | `admin.users` | admin access log |

Sign-in responses: `{ accessToken, expiresIn, me }`; the refresh token is set as an httpOnly,
`SameSite=Strict` cookie `lrfe_rt` on path `/api/auth`, never exposed to JavaScript.

### Decisions worth knowing

- **Roles are fixed**: the six roles in `services/identity/src/catalogue.js` (mirrors the
  frontend). They cannot be created or deleted; only their permissions are editable.
- **Segregation of duties is reported, not blocked, at role assignment** (like the demo's
  warning badge). Enforcement belongs at action time in the services that own the action
  (e.g. land-records refuses to let the finalizer sign off the same record).
- **Lock-out guard**: no change (roles, suspension, matrix) may leave zero active users holding
  `admin.roles`. Nobody can change their own roles or status.
- **Sessions**: idle timeout comes from the security policy and is enforced on refresh. Refresh
  tokens rotate on every use; replaying an old one revokes the session. Suspending a user
  revokes all their sessions. Permission changes reach a user at their next refresh (≤ 15 min).
- **MFA**: TOTP (authenticator app), implemented with `node:crypto` against the RFC 6238
  vectors. When the policy requires MFA, users enrol at their next sign-in.
- **Passwords**: scrypt; minimum 12 characters; set by the user when accepting an invitation.

## EDRMS API (via gateway)

A document is created once — by **filing**, which only the intake service can do after metadata
review — and is never deleted. Every version is immutable and **sealed**: a SHA-256 over the
content hash plus the fields and record metadata that version asserts. Corrections are
**amendments**: a new major version with a mandatory reason; earlier versions stay readable.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/documents` (multipart: `meta` JSON **first**, then `file`) | intake service token | file a reviewed document → `EDR-NA-<year>-<nnnnnn>`, v1.0. Idempotent on `meta.sourceId` (201 new / 200 existing) |
| `GET /api/documents?q=&docType=&batchId=&field.<key>=<value>&limit=&offset=` | read* | list/filter, e.g. `field.property=Erf 1873, Klein Windhoek` |
| `GET /api/documents/lookup?edrmsNo=` / `instrumentRef=` / `sourceId=` | read* | find one document |
| `GET /api/documents/:id` | read* | document, current fields and version history |
| `GET /api/documents/:id/versions/:n` | read* | one version's fields, metadata, hash, seal |
| `GET /api/documents/:id/content?version=` | read* | short-lived viewer URL (S3 presigned, or a signed `/api/document-content/...` link) |
| `POST /api/documents/:id/amendments` | **bpm service only** | apply an approved change `{reason, expectedVersion, changes: [{k, v}], recordMetadata?, actor, approvedBy}`; users request changes through bpm (below) |
| `GET /api/documents/:id/versions/:n/verify` | `audit.view` | re-hash stored content and recompute the seal: `{intact, contentIntact, sealIntact}` |
| `GET /api/document-catalogue` | signed in | document types and the ISO 23081 record-metadata fields |

\* read = a user with any of `capture.view`, `verify.view`, `record.view`, `audit.view`, or the
intake / land-records / audit / search service.

### Decisions worth knowing

- **Instrument references are unique** (`T 2210/2008`, `A 412/2007`), normalized from the
  document's own `deedNo` / `sgNo` field, so the same deed can't be filed twice — including
  via an amendment that changes the number.
- **EDRMS numbers are gap-free per year**: allocated inside the same transaction that inserts
  the record, so a failed filing doesn't consume a number.
- **Content is streamed, never buffered**: hashed while it is written to storage (default upload
  limit 200 MB, `EDRMS_MAX_FILE_MB`). If the record can't be committed, the stored object is
  deleted. The gateway drops `Expect: 100-continue` so large uploads proxy cleanly.
- **One storage key per version** (`edrms/<documentId>/v<n>/<file>`), as in cportal-be. An
  amendment that only corrects fields reuses the previous version's content object.
- **Links to land records live in land-records**, not here — edrms doesn't know about erven.
- **Record metadata (ISO 23081)** is filled at filing: business function "Deeds registration",
  capturer and reviewer as agents, retention `permanent` / `retain`. Ported whitelist from
  cportal-be; unknown keys are rejected.
- **Amendments are four-eyes**: requester (`actor`) and approver (`approvedBy`) must differ,
  and both are sealed into the new version.
- Dropped from cportal-be on purpose: check-out/check-in (review locking belongs to intake) and
  admin purge (records of the deeds registry are not deleted).

## BPM (workflow) API (via gateway)

A persisted, token-based process engine ported from `cportal-be/services/bpm` (node types:
start, humanTask, serviceTask, exclusiveGateway, parallelGateway, join, multiInstanceTask,
miEnd, end; conditions in JsonLogic). Domain services keep their own data; bpm decides **who
does what, in which order**, and calls the owning service (via connectors, with a bpm service
token) when a step is due.

Process definitions are JSON files in `services/bpm/src/definitions/`, deployed at boot.
Unchanged files are skipped; a changed file becomes a new version, and running instances keep
the version they started on.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/processes` | signed in | available processes, who may start them, their variables schema |
| `POST /api/processes/:key/instances` `{variables}` | the definition's `start.perm` (or listed services) | start; the definition's precheck may reject it up front |
| `GET /api/process-instances?definitionKey=&businessKey=&status=&mine=` | signed in | list (e.g. "is a change already open for this document?") |
| `GET /api/process-instances/:id` | signed in | variables, tasks and full history |
| `POST /api/process-instances/:id/cancel` `{reason?}` | requester or `managePerm` | withdraw; open tasks are cancelled |
| `POST /api/process-instances/:id/retry` | `managePerm` | re-run the step that failed (e.g. edrms was down) |
| `GET /api/tasks` | signed in | my inbox: open tasks I may do + tasks I claimed (`overdue` flag) |
| `GET /api/tasks/:id` | eligible / involved | the task with its input (e.g. the before/after preview) |
| `POST /api/tasks/:id/claim` · `/release` | eligible | take / hand back |
| `POST /api/tasks/:id/complete` `{output: {outcome, comment?}}` | eligible / claimer | finish the task; the process moves on |

### Process: `document-amendment` — change to a filed document

1. A user with `verify.edit` starts it with `{documentId, expectedVersion, reason, changes}`.
   The precheck (edrms) rejects a stale version, unknown fields or a change that changes
   nothing, and stores a before/after **preview** for the approver. One open request per document.
2. **Approve** task for `verify.file`, **excluding the requester** (four-eyes); outcomes
   `approved` / `rejected` (a rejection needs a comment); due in 48 h.
3. Approved → bpm calls edrms, which creates the new major version sealed with requester and
   approver. If the record changed meanwhile, edrms answers 409, the instance goes to `error`,
   and it can be cancelled (or retried once resolved).

### Engine additions over cportal-be

Assignment by permission (role permissions are editable), `exclude` rules (four-eyes),
declared `outcomes` and comment rules, due dates, a `precheck` before an instance exists, start
permissions per definition, JSON-schema validated variables, one open instance per business
key, `cancel` and `retry`, and a failed step parks its token instead of losing its place.

## Intake & extraction (via gateway, `/api/intake/...`)

```
upload ─▶ intake (staging store, job queue) ─▶ extraction worker ─▶ Gemini (PDF in, JSON out)
                                                  │ normalise + format checks + evidence checks
                                                  │ cross-checks against edrms (duplicate, prior title, chain, SG area)
                                                  │ weak result → re-read by the escalation model; disagreements flagged
                     review (field by field) ◀────┘
                     file ─▶ edrms v1.0, sealed, with the extraction's provenance
```

- **Extracted values are proposals.** They live in intake next to the reviewer's decision
  (`extracted`, `value`, `status` pending/accepted/edited, `evidence` page + quote, `checks`,
  `flag` ok/check/conflict/missing, `alt` from the other model). Only reviewed values are filed.
- **One schema per document type** (`src/doc-types.js`) generates the prompt, the JSON schema
  Gemini answers in, the validators and the review labels.
- **The model reads; the code checks.** Model self-confidence is not used. Flags come from format
  checks (11-digit IDs, deed-number pattern, dates in English/Afrikaans/German, m²/ha), from
  checking that each value's quoted evidence is really on the cited page, and from EDRMS
  cross-checks. Errors (bad ID length, duplicate instrument) block filing until corrected.
- **Cost control:** every model call is stored with tokens and cost (`src/extraction/pricing.js`,
  prices as of 2026-09-29); the worker pauses at `EXTRACTION_MONTHLY_BUDGET_USD`; `GET /usage`.
  Defaults: `gemini-3.1-flash-lite`, medium resolution, low thinking; escalation `gemini-3.1-pro-preview`.
- **Provider** is swappable (`src/extraction/providers.js`): Gemini Developer API (`GEMINI_API_KEY`)
  or Vertex AI (`GEMINI_VERTEX=true`, project, region); `mock` needs no key and costs nothing (default).
- **Worker** runs inside the service for local work, or alone (`npm run worker -w @lrfe/intake`,
  several in parallel — Postgres `SKIP LOCKED`). Retries with backoff; non-retryable errors fail at once.

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /api/intake/batches` · `POST /api/intake/batches {source}` | read / `capture.scan` | batches with status counts · open a batch (`WDH-B001`…) |
| `POST /api/intake/batches/:id/documents` (multipart `file`: PDF/PNG/JPEG ≤ 50 MB) | `capture.scan` | capture; the same file twice → 409 with the existing id |
| `GET /api/intake/documents?batchId=&status=&q=` · `GET /api/intake/documents/:id` | read | queue · document with fields, checks, transcription, model calls |
| `GET /api/intake/documents/:id/file-link` · `GET /api/intake/files/:id?exp&sig` | read / signed | the staged file for the viewer |
| `POST .../claim` · `.../release` | `verify.edit` | review lock (30 min) |
| `PUT /api/intake/documents/:id/fields/:k {value}` or `{status: accepted\|pending}` | `verify.edit` | correct (normalised and re-checked) or accept a field |
| `POST .../accept-clean` · `POST .../extract {escalate?}` | `verify.edit` | accept all clean fields · read again (optionally with the stronger model) |
| `POST .../file` · `POST .../reject {reason}` | `verify.file` | file into edrms (409 lists what blocks it) · reject |
| `GET /api/intake/usage?month=YYYY-MM` | `audit.view` or `admin.policies` | model calls, tokens and cost by model |

read = `capture.view` or `verify.view`.

### Not done yet

- Intake: TIFF input (convert to PDF/PNG first); Gemini Batch API mode for back-scanning (half
  price); Vertex AI input over 15 MB (Cloud Storage); segregation-of-duties rule "scan operators
  cannot file what they capture" at filing; review assignment and rescans through bpm.
- BPM: replacing the **file** of a filed document (needs a staged upload that the approval can
  reference); escalation of overdue tasks; a transition spanning several rows is not one DB
  transaction (conditional updates prevent double completion; a crash mid-step needs `retry`).
- EDRMS: `provenance` on v1.0 (sealed; versions without it keep their old seal). Its column is
  added at boot by an idempotent `ALTER TABLE` until real migrations exist.
- EDRMS: page thumbnails / web-sized renditions for the viewer; full-text search (the search
  service will consume `edrms.document.filed` / `.amended`); legal-hold and disposition
  workflow beyond storing the metadata.
- Invitation email: the `identity.user.invited` event carries the link; nothing sends it yet.
  In dev, `IDENTITY_EXPOSE_INVITE_LINKS=true` returns it to the admin.
- National eID sign-in and the IP allow-list: stored as policy switches, not enforced.
- Login rate limiting, TOTP replay protection, MFA secrets encrypted at rest, an absolute
  session lifetime, and real migrations (`DB_SYNC` / `npm run seed:identity` use `sequelize.sync()`).
