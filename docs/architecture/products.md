# Products on one platform

The repository holds one platform and the products built on it: the **land registry** today, and
**shipping** (electronic bills of lading, epic CB-1) next. This page is the guide to that split:
where each part lives, how the shared services learn about a product, which names never change,
and how to add a product.

The split was made in CB-2 (the web workspace), CB-3 (domain packs), CB-4 (the record contract)
and CB-5 (the lint guard and this guide).

## The layout

| Where | What | Shared or product |
| --- | --- | --- |
| `angular-app/projects/platform` | the web library `@lrfe/platform`: sign-in, API client, roles and permissions, site settings, toasts and dialogs, proofs and blockchain checks, the theme | shared |
| `angular-app/projects/land-registry` | the land registry web app | land |
| `angular-app/projects/shipping` | the shipping web app: the shared sign-in and an empty home page so far | shipping |
| `backend/packages/common` | `@lrfe/common`: settings, events, auth, database, app start; loads the domain pack | shared |
| `backend/packages/domain-pack` | `@lrfe/domain-pack`: what a pack holds, and its check (`checkDomainPack`) | shared |
| `backend/packages/record-contract` | `@lrfe/record-contract`: the calls a record service answers, their client and the contract test | shared |
| `backend/packages/storage`, `backend/packages/search-index` | file storage and keys; the search index and country pack | shared |
| `backend/services/{identity,audit,extracts,edrms,search,bpm,gateway,intake}` | the shared services | shared |
| `backend/services/land-records` | the land registry's record service | land |
| `backend/services/shipping-records` | the shipping record service: draft B/Ls, versions, seals (CB-27) | shipping |
| `backend/domains/land` | `@lrfe/domain-land`, the land pack | land |
| `backend/domains/shipping` | `@lrfe/domain-shipping`, the shipping pack: the B/L model (DCSA eBL 3.0), the B/L permissions, role and demo data, and its record kind | shipping |

The shared services know nothing about land or shipping. They read their product from the
**domain pack** of the install, chosen by one setting, `LRFE_DOMAIN` (`land` when not set), and
call the product's **record service** through the **record contract**. A **lint guard** keeps
shared code from importing product code.

### Ports

| Port | What | Run with |
| --- | --- | --- |
| 4200 | land registry web app | `npm start` in `angular-app/` |
| 4201 | shipping web app | `npm run start:shipping` in `angular-app/` |
| 3500 | gateway, the only backend entry point of the apps | `npm run dev` in `backend/` |
| 3501 to 3508 | identity, edrms, bpm, intake, land-records, audit, extracts, search | `npm run dev` in `backend/` |
| 3509 | shipping-records (with `LRFE_DOMAIN=shipping`) | `npm run dev -- shipping-records nats` in `backend/` (never started by default) |
| 3510 | API docs | `npm run dev` in `backend/` |

Both apps pass `/api/...` to the gateway on 3500 (`angular-app/proxy.conf.json`). In the e2e
tests the shipping app runs on the web port + 1 (`e2e/stack/config.mjs`), and shipping-records,
in the shipping run, on the API port + 13.

## The web apps (CB-2)

`angular-app/` is one Angular workspace (`angular.json`) with three projects: the library
`platform` and an app per product. The library is imported as `@lrfe/platform` (a path in
`angular-app/tsconfig.json`); it is compiled with each app, not published as a package. It never
imports an app's code. The apps share one `package.json`, so Angular and every package are
updated once for all.

Each app describes itself to the library once, with `provideProduct()` in its `app.config.ts`. Its
`ProductConfig` (in its `src/app/product.ts`) holds the title in the browser tab, the default
organisation settings for a site that sets none, its permission list, and its sign-in texts (the
logo placeholder, and optionally a picture under the texts, served from the app's `public/`
folder, like the shipping app's port, CB-6).

| | Land registry | Shipping |
| --- | --- | --- |
| Run | `npm start` (port 4200) | `npm run start:shipping` (port 4201) |
| Build | `npm run build`: `dist/land-registry` | `npm run build:shipping`: `dist/shipping` |
| e2e | the web port | the web port + 1 (`e2e/tests/shipping-app.spec.ts`); the B/L through the API: `npm run test:shipping` (`docs/ai-workflow/e2e.md`) |
| Docker image | `lrfe-web` (`angular-app/Dockerfile`) | none yet |

Screens that are generic but still carry land wording (dashboard, documents, audit, anchorings,
administration) stay in the land registry until shipping needs them; they then move to the
library, without their land wording.

## The domain pack (CB-3)

A pack is a workspace package, `backend/domains/<name>`, named `@lrfe/domain-<name>`, that exports
`pack`. `@lrfe/common` loads the pack named by `LRFE_DOMAIN` once, by a dynamic import of
`@lrfe/domain-<name>`, checks it with `checkDomainPack` from `@lrfe/domain-pack` and freezes it.
Every service reads it as `domain` (`import {domain} from '@lrfe/common'`). A pack that is
missing or fails its check stops the service at start, with the reason. The web container writes
the same value into `/config.json` as `domain`.

A pack never imports `@lrfe/common` (common is loading it) or service code; the services pass it
the helpers it needs. The pack's name is lower-case letters, digits and dashes, and equals its
`LRFE_DOMAIN` value.

What a pack holds (the check, section by section, is in `backend/packages/domain-pack/src/`):

| Section | Read by | What it holds | Land pack (`backend/domains/land/src/`) |
| --- | --- | --- | --- |
| `name` | common | the pack's name | `land` |
| `documents` | edrms, intake, search | document types and their fields (with each field's search role), the reference format, field types and their checks, the reading prompt and its version, checks and cross-checks, the stand-in reader's demo answers | `documents/`: six document types, deed and SG numbers, Namibian ID numbers |
| `identity` | identity | permission groups and permissions, roles, separation-of-duty rules, default offices, demo users | `identity/`: the "Land records" group, the roles `sup`, `scan`, `rev`, `rec`, `aud`, the rules `sod2` and `sod3` |
| `workflows` | bpm | the product's workflow definitions; who acknowledges the audit workflows | `workflows/`: `land-record-review`; `rec` and `sup` acknowledge |
| `recordKind` | audit, and (its `service`) identity, edrms, gateway, extracts, bpm | the record service (`service`), the source of its events, the commit event, the review process key, the linked documents of a record event, the commit permission, the lookup patterns; null when the product has no records | `record-kind.js` |
| `wording` | edrms, identity, audit, extracts | texts per service: the EDRMS business function, the invitation, audit's messages and the evidence pack README, the extract PDF and its number prefix | `wording/` |

What stays in the platform, so that a product without these parts still works: the platform
permission groups and the `adm` role, the rules `sod1` and `sod4`, the audit workflows
(`audit-finding`, `audit-rereview`: started by audit; the pack only says who acknowledges) and
`document-amendment`, the generic reading pipeline (the duplicate check, the `text` field type, a
generic prompt), the extract PDF layout, and the trail, tree and proof formats.

**The shipping pack** (CB-23 to CB-28) holds the bill-of-lading model
(`@lrfe/domain-shipping/bill-of-lading`: DCSA eBL 3.0, the containers-only rule, the B/L formats
of `LRFE_BL_FORMATS`; `backend/domains/shipping/docs/`), and in its sections:

- `identity`: the group "Bills of lading" with `bl.read`, `bl.draft`, `bl.issue` and `bl.endorse`
  (issuing and moving B/Ls, CB-34), the role `bld` (B/L documentation, every one of them), and demo data: the office `HQ` and, with a demo password, an
  administrator and two B/L clerks at `shipping.example` (fictitious; the shipping e2e run signs
  them in).
- `recordKind`: the record service `shipping-records` (`SHIPPING_RECORDS_URL`, default
  `http://localhost:3509`), its source and the committed event `records.record.committed`. A
  committed B/L version is a tree leaf of type 1 and has a `record-version` proof, as a land
  record. No `commitPermission` (a version is committed by the workflow service, by a second
  person), no `lookup` patterns (a B/L number is the carrier's reference: a search goes to the
  record service as words), no business-key processes or linked subjects yet.
- `documents`, `workflows` and `wording`: empty. With `LRFE_DOMAIN=shipping` there are no document
  types (filing says so), only `document-amendment` is deployed; issuing an extract or raising an
  audit finding needs the wording and acknowledgers a fuller pack gives.

A pack without a record kind is still valid: then there is no record service (`/api/records` is
not routed, record calls answer 503, `record-version` proofs answer 400) and lookups search
documents only; the shared services' tests check that case with a pack whose `recordKind` is
null.

**The country pack** (API-713, `backend/packages/search-index/src/country-pack.js`) is a different
thing: a JSON file chosen by a two-letter code, for a country's conventions (names, numbers,
search analysers). The domain pack is a JavaScript module because it also brings code (field
checks, the PDF wording, the event-to-leaf mapping). Both are checked at start and fail early.

## The record contract (CB-4)

The shared services never call a product service by name. The pack names its record service in
`recordKind.service` (land: `{name: 'land-records', label: 'land records', urlSetting:
'RECORDS_URL', defaultUrl: 'http://localhost:3505'}`); `recordServiceOf(domain)` in `@lrfe/common`
gives its name, label and address (from its setting), or null for a pack without records. From it:

- **The callers' allow-lists:** identity lets the record service read `/policies/effective`;
  edrms lets it read documents with a service token, and search documents still in intake for a
  user who may read them (`intake=true`); audit's allow-list likewise.
- **The gateway:** `/api/records/*` goes to the record service, at its setting's address. A pack
  without records has no `/api/records` route, and the gateway starts without that address.
- **The calls:** audit, extracts and bpm send them through one client, `createRecordClient` of
  `@lrfe/record-contract`, over their own transport (their timeouts, error texts, service token).
  Error texts take the service's `label` ("The land records service cannot be reached: ...").
  With no record service every service still starts; a call answers 503 "This install has no
  record service".

Every call needs a service token (`typ: service`); the record service checks the caller.

| Call | Method and path | Query or body | Answer | Called by |
| --- | --- | --- | --- | --- |
| `list` | `GET /records` | `status`, `limit`, `offset`, optionally `q` and `match` (`all` or `parcel`) | `{items, total}`: each record's `id`, `recordNo`, `label`, `status`, `currentVersion`, `draftVersion`, `draftState` | audit (the Audit screen's list, the Anchorings search) |
| `get` | `GET /records/:id` | | the record as in the list, with `current` (its current committed version, with `data`), `draft` and `draftDiff` | audit, extracts |
| `versions` | `GET /records/:id/versions` | | the versions without their data: `versionNumber`, `state`, `seal`, `committedAt`, `approvedByName`, `changes` | audit |
| `version` | `GET /records/:id/versions/:n` | | one version: `versionNumber`, `state`, `data`, `seal`, `previousSeal`, `approvedById`, `approvedByName`, `committedAt` | audit, extracts |
| `lookup` | `POST /records/lookup` | `{recordIds, versions: [{recordId, versionNumber}], pinning: [documentId]}` | `{records: [{id, recordNo, label}], versions: [{recordId, versionNumber, documents: [{id, version}]}], pinnedBy: [{documentId, version, recordId, versionNumber}]}` | audit (Anchorings) |
| `seals` | `GET /records/seals` | `limit`, optionally `after` (the previous page's `next`) | `{items: [{recordId, version, seal, at}], next}`, oldest first; `next` null on the last page | audit (backfill) |
| `verify` | `GET /records/:id/verify` | | `{recordId, recordNo, intact, versions: [{versionNumber, seal, intact, linked}], checkedAt}`: the service's own recomputation | audit |
| `commit` | `POST /records/:id/versions/:n/commit` | `{by: {id, name}, comment}` | the record as `get` answers it, the version now current; a retry by the same person answers the same | bpm (review approved) |
| `reject` | `POST /records/:id/versions/:n/reject` | `{by: {id, name}, comment}` (a comment is required) | the record as `get` answers it, the version a draft again | bpm (review sent back) |

Errors, in the shared error shape: 401 without a valid service token, 403 for a caller the call
does not allow (and for an approver the four-eyes rule excludes), 404 for an unknown record or
version, 400 for a bad query, body or cursor, 409 when the version is no longer in review.

**The contract test.** `describeRecordContract({name, client, fixture})` from
`@lrfe/record-contract/contract-suite` is a mocha suite that calls each of these on a running
service and checks the shapes (never a product's values), the 404s, and commit and reject of a
submitted version. land-records and shipping-records each run it in their
`tests/contract.test.js`, in process over `app.inject`. Details in
[`backend/packages/record-contract/README.md`](../../backend/packages/record-contract/README.md).

## Organisations (CB-18)

Every office and every user belongs to an **organisation**, kept by identity (its README,
"Organisations"). A land install has one, the default organisation; a product with outside parties
(carriers, banks) adds more.

- **Reading the caller's organisation.** A product or shared service takes it from the verified
  token with `organisationOf(request)` from `@lrfe/common` (null for a service, an anonymous call or
  a token issued before CB-20), or from `actorOf(request)`, which returns `{id, name, org}`. Never
  read it from the request body or a query parameter.
- **Audit.** Events carry the actor with its `org` when it has one, so the audit trail hashes and
  anchors who acted for which organisation (CB-21; audit README §1).
- **Default organisation.** Identity creates it at start when there is none, named from
  `LRFE_ORG_NAME`, and keeps its id in the setting `organisations.default`.

## Fixed names: never renamed

Existing installs and the evidence they have already published depend on these names and formats.
A pack maps to them; it never renames them. A new product uses them as they are, or adds its own
beside them.

- **In the anchored audit trail:** the trail hash covers each event's type, source, subjects and
  data (`audit/src/chain.js`). So the source `land-records`, the `records.*` event types,
  `record:<id>` subjects and the `land-record-review` process key are permanent.
- **In the tree:** leaf type 1 (a record version) and the `record-version:<id>:<n>` keys are stored
  and part of published roots; so is the proof kind `record-version`. Every product's record
  versions use them.
- **Offline verifier and proof formats:** `audit/verifier/lrfe-verify.mjs` repeats the land seal
  formula and checks the formats `lrfe-audit-proof/1`, `lrfe-evidence-pack/1` and the on-chain
  marker `lrfe-audit`. They stay byte-compatible; a new product's seal is added to the verifier.
- **Sealed extract PDFs** already issued keep verifying, offline and at `/check/:code`.
- **Stored ids:** role and permission ids (`record.*`, `sup`, `rec`, ..., in the database and in
  tokens), document type ids (in edrms, intake and the search index), the event stream `LRFE`
  (subjects `lrfe.>`) and its durable consumer names.
- **Settings:** `RECORDS_URL` (the land record service's address) and the other settings of
  existing installs keep their names. `LRFE_DOMAIN` not set means `land`.

**Byte-for-byte for land.** The land pack gives the same values the code held before CB-3: the
identity catalogue, the workflow definitions (so bpm deploys no new versions on upgrade), the
reading prompt and its version, the subjects of each trail event in their order, and the extract
PDF (checked by hashing PDFs before and after).

## The lint guard (CB-5)

Shared code may not import product code. The guard is a `no-restricted-imports` block in
`eslint.config.mjs`, part of `npm run -s lint` at the root, so it runs in the pipeline with the
rest of the lint. `npm run test:lint-guard` (`scripts/lint-guard.test.mjs`) shows that it still
catches such imports.

- **Product code:** the packs in `backend/domains/*` (`@lrfe/domain-*`, any later one too;
  `@lrfe/domain-pack` is shared), `backend/services/land-records`, and the apps
  `angular-app/projects/land-registry` and `angular-app/projects/shipping`.
- **Shared code:** `backend/packages/*`, the shared services, the web library
  `angular-app/projects/platform`. Its production code may not import product code.
- **Products may import shared code** (`@lrfe/common`, `@lrfe/platform`, ...).
- **Not covered:** `backend/scripts` (the development and setup tools, which start or set up every
  service, land-records included).
- **Not covered:** the shared services' tests. They may use land as a reference product (fixtures,
  `LRFE_DOMAIN=land` cases), since land is the product that exists.
- **The one way in:** `@lrfe/common` loads the pack by its configured name with a dynamic import
  (`` import(`@lrfe/domain-${name}`) ``), never by a static import of a pack.

## How to add a product

The steps for a new product, say `bol` (bills of lading). Use the shipping pack and app as the
starting point, and land as the full example.

1. **The domain pack.** Create `backend/domains/<name>/` with:
   - a `package.json` named `@lrfe/domain-<name>`, `"type": "module"`, `"exports": {".":
     "./src/index.js"}`, a `test` script (mocha) and `@lrfe/domain-pack` as a dev dependency
     (copy `backend/domains/shipping/package.json`);
   - `src/index.js` exporting `pack`, with `name: '<name>'` and every section (`documents`,
     `identity`, `workflows`, `recordKind`, `wording`); an empty section is allowed, `recordKind`
     may be null;
   - `tests/pack.test.js`, which checks `checkDomainPack(pack, '<name>')` (copy the shipping one).

   Then add its `package.json` to `backend/Dockerfile` (next to `domains/land/package.json`) and
   run `npm install` in `backend/` (the workspace `domains/*` picks it up).
   `npm test -w @lrfe/domain-<name>` runs the check. When the pack reads scans (`documents.reading`),
   change its `promptVersion` whenever the types or prompt texts change.

2. **The pack's content.** Fill the sections the product needs: its document types and fields, its
   roles and permissions, its workflow definitions, the wording of each shared service. Pick ids
   that are new (never reuse a land id for something else): they are stored and cannot be renamed
   later.
3. **The record service** (when the product has records). Create `backend/services/<service>/`, a
   Fastify service like `land-records`, that answers every call of the record contract (above)
   and checks the caller's service token. Service tokens need no new secret: every service signs
   its own with the shared `JWT_SECRET` (`signServiceToken` in `@lrfe/common`), and the caller's
   name in the token is what the allow-lists check. Then:
   - point the pack at it: `recordKind.service: {name, label, urlSetting, defaultUrl}` (a new
     setting name, e.g. `BOL_RECORDS_URL`, and a free port), and `recordKind.source`,
     `committedEvent`, `businessKeyProcesses`, `linkedSubjects`, `commitPermission`, `lookup`;
   - its record versions become tree leaves of type 1 keyed `record-version:<id>:<n>`, so record
     ids must be unique (UUIDs); its seal formula is added to the offline verifier
     (`backend/services/audit/verifier/lrfe-verify.mjs`);
   - add the contract test, `tests/contract.test.js`, calling `describeRecordContract({name,
     client, fixture})` from `@lrfe/record-contract/contract-suite` (copy land-records' test);
   - add the service to `backend/Dockerfile`, `backend/scripts/dev.js`,
     `backend/scripts/db-setup.js` (its schema), `backend/.env_example` and `backend/install.md`
     (its port and schema), and run `npm run docs` in `backend/` for its API docs.

   No shared service needs a change: the allow-lists, the gateway's `/api/records` route and the
   calls follow the pack.

4. **The web app.** Copy `angular-app/projects/shipping` to `angular-app/projects/<app>`, add its
   project to `angular.json` (copy the `shipping` entry; give `serve` a free port), and add
   `start:<app>` and `build:<app>` scripts to `angular-app/package.json`. Write its
   `ProductConfig` in `src/app/product.ts` and pass it to `provideProduct()` in
   `src/app/app.config.ts`. Import shared screens and services from `@lrfe/platform`; never import
   another app's code. Its permission list mirrors the pack's `identity` section.
5. **The guard.** A new pack is covered already (`@lrfe/domain-*`). Add the new record service
   (beside `land-records`: to the `ignores` and the import patterns) and the new app (beside
   `land-registry` and `shipping`) to the guard's block in `eslint.config.mjs`, a case for each to
   `scripts/lint-guard.test.mjs`, and check `npm run -s lint` and `npm run test:lint-guard` at the
   root.
6. **Settings.** An install of the product sets `LRFE_DOMAIN=<name>` (in `deploy/.env`, or in each
   service's `.env` for a server install) and the record service's address setting. Document both
   in `deploy/README.md` and `backend/.env_example`. Choose the product when installing; never
   change it on an install that holds data.
7. **Compose and deploy.** Add the record service to `deploy/docker-compose.yml` (the
   `lrfe-backend` image, its port, its address setting in the services that call it), and a web
   image for the app (a build of the app like `angular-app/Dockerfile`, built by
   `deploy/scripts/build.sh`).
8. **e2e.** Add the app to `e2e/playwright.config.ts` (an `ng serve <app>` web server on a port of
   its own, in `e2e/stack/config.mjs`), its record service to `e2e/stack/start-backend.mjs`, and
   specs under `e2e/tests/` (like `e2e/tests/shipping-app.spec.ts`). The suite must pass in memory
   and on PostgreSQL (`docs/ai-workflow/e2e.md`). Tests of the product's own backend run on a
   stack in its mode, as shipping's: `E2E_DOMAIN=shipping` in `e2e/stack/start-backend.mjs` (every
   service on the pack, its record service instead of land-records), its own Playwright config
   (`e2e/playwright.shipping.config.ts`) and specs (`e2e/tests-shipping/`), `npm run
   test:shipping`.

**What not to change:** the names in "Fixed names" above; the land pack and `land-records`; the
shared services, beyond moving a land term into the pack when the new product needs that part
(land then keeps its value byte for byte); `@lrfe/platform`, beyond moving a generic screen into
it without its product wording.

## Land terms still in the shared services

Parts of the shared code still assume land. A new product that needs one of them moves it into the
pack first:

- **The record's data shape:** extracts' owner check before issuing (`issue-checks.js`,
  `version.data.owners`), the `ownerIndex` field of its API, the owner columns it stores. The
  record contract carries a version's `data` as the product's own; reading owners from it is
  still land's.
- **Stored names:** the `property` key of intake's summaries and search's results (filled from the
  field whose search role is `place`), the office type `registry`.
- **Defaults:** the country `NA` and office `WDH` as default settings of edrms and intake
  (Namibian values as defaults only).
- **Web screens:** the generic screens still in the land registry app (see "The web apps").
- **Not code:** examples in the API docs, the developer scripts that check land sample scans, the
  design history in `services/audit/README.md`.

## History

- **CB-2** surveyed the land terms in every service and screen (the record kind, calls to
  `land-records`, roles, workflows, wording, document types) and split the web app into the
  workspace.
- **CB-3** moved the land terms into the land pack, byte for byte, and added the empty shipping
  pack.
- **CB-4** replaced the calls to `land-records` by name with the record contract.
- **CB-5** added the lint guard and turned this page into the guide.
- **CB-23 to CB-28** gave the shipping pack the B/L model and formats, the B/L permissions, role
  and demo data, and its record service `shipping-records` (the record contract, seals, events),
  wired into the gateway, compose (profile `shipping`) and a shipping e2e run.
