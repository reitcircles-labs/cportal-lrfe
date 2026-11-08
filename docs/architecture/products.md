# Products on one platform

The repository holds one platform and the products built on it: the **land registry** today, and
**shipping** (electronic bills of lading, epic CB-1) next. This page describes which code is shared
and which belongs to a product, and what may never change for existing installs. It starts as the
survey of ticket CB-2 (8 November 2026) and becomes the guide to the layout once the split is done.

## The target layout

- **Shared platform:** the services `identity`, `audit`, `extracts`, `edrms`, `search`, `bpm`,
  `gateway`, the packages in `backend/packages/`, and the web library `platform`. They know nothing
  about land or shipping.
- **Products:** product services (`land-records` for the land registry; shipping services later),
  a web app per product, and a **domain pack** per product in `backend/domains/<product>/`.
- **Domain pack:** a JavaScript module that tells the shared services about its product (document
  types, record kind, roles, workflows, wording, extract layout, search fields). One setting,
  `LRFE_DOMAIN` (`land` by default), chooses the pack for an install. Existing installs need no
  change (CB-3, done: see "The domain pack").
- **Guard:** a lint rule stops shared code from importing product code.

## The web app: one workspace, an app per product (CB-2, done)

`angular-app/` is one Angular workspace with three projects:

- `projects/land-registry`: the land registry app.
- `projects/shipping`: the shipping app; only the shared sign-in and an empty home page so far.
- `projects/platform`: the library both use, imported as `@lrfe/platform` (a path in
  `angular-app/tsconfig.json`; it is compiled with each app, not published as a package). It holds
  the sign-in screen, the API client and auth interceptor, roles and permissions, site settings,
  toasts and dialogs, proofs and blockchain checks (`ProofApi`), and the theme. It never imports an
  app's code.

Each app describes itself to the library once, with `provideProduct()` in its `app.config.ts`
(`ProductConfig`, in its `src/app/product.ts`): the title in the browser tab, the default
organisation settings for a site that sets none, its permission list, and its sign-in texts
(the logo placeholder, and optionally a picture under the texts, served from the app's `public/`
folder: the shipping app's port, CB-6).
Screens that are generic but still carry land wording (dashboard, documents, audit, anchorings,
administration) stay in the land registry until shipping needs them.

| | Land registry | Shipping |
|---|---|---|
| Run | `npm start` (port 4200) | `npm run start:shipping` (port 4201) |
| Build | `npm run build`: `dist/land-registry` | `npm run build:shipping`: `dist/shipping` |
| e2e | the web port | the web port + 1 (`e2e/tests/shipping-app.spec.ts`) |

The docker image (`angular-app/Dockerfile`) is the land registry's; the shipping app gets its
own image when it is deployed.

## Survey: the backend today

| Unit | What it does | Today |
|---|---|---|
| `identity` | users, roles, sessions, MFA, offices, invitation mail | shared, with land bits |
| `audit` | audit trail, Merkle tree, blockchain anchoring, proofs, sign-offs, evidence pack, offline verifier | shared, with many land bits |
| `bpm` | workflow engine, its definitions and connectors | shared, with land bits |
| `edrms` | filed documents, versions, seals, storage | shared, with land bits |
| `extracts` | sealed PDF extracts, check codes, public check | shared, with many land bits (built as an ownership extract) |
| `gateway` | routes requests to the services | shared (only its routing table names `land-records`) |
| `search` | search entries from intake and edrms events | shared, with a few land bits |
| `intake` | batches, automatic reading of scans, review | a generic pipeline with land document types and checks |
| `land-records` | land records, versions, seals, owners | land only |
| `packages/common` | settings, events, auth, database | shared (default organisation name says "Deeds Registry") |
| `packages/storage` | file storage, encryption keys | shared |
| `packages/search-index` | search mapping and queries, country pack | shared |

### Land-specific parts of the shared services, by kind

The survey as written for CB-2. CB-3 moved them into the land pack (see "The domain pack" below),
except the calls to the product service and the record's own data shape, which are CB-4.

- **Document types and their fields:** `edrms/src/catalogue.js` (deed of transfer, mortgage bond,
  SG diagram, the deed-number format), `intake/src/doc-types.js`, the reading prompt and checks in
  `intake/src/extraction/`, the party fields in `search/src/entry.js`.
- **The record kind:** the audit subject kind and business key (`audit/src/subjects.js`), the tree
  leaf for a record version (`audit/src/mmr.js`, `audit/src/tree.service.js`), proof kinds
  (`audit/src/proof.service.js`), lookup patterns (`audit/src/lookup.service.js`).
- **Calls to the product service:** audit, extracts and bpm call `land-records` over HTTP
  (`/records`, versions, lookup, seals, verify, commit and reject). Search calls `intake`. The
  allow-lists of service callers in identity, edrms and audit name `land-records`.
- **Roles and permissions:** the "Land records" permission group, `record.*` permissions, the
  Registrar role, separation-of-duty rules and offices (`identity/src/catalogue.js`), demo users
  (`identity/src/seed.js`).
- **Workflows:** `bpm/src/definitions/land-record-review.json`, the registrar steps in the audit
  workflows, and the records connector (`bpm/src/connectors/records.js`).
- **Wording and layouts:** the extract PDF and its wording (`extracts/src/pdf/`), the extract number
  prefix, the evidence pack README and sign-off messages (audit), the invitation mail (identity),
  the EDRMS defaults.
- **Extract owner columns:** `extracts/src/repo/models.js` stores the record and owner of each
  extract.

There is no SQL across schemas: each service has its own schema.

## Survey: the web app today

| Folder | Today |
|---|---|
| `api/` | mixed: `records.api.ts` is land; `extracts.api.ts`, `intake.api.ts` carry land fields; the rest is shared |
| `shared/` | mixed: `record-diff` is land; the inbox and viewer contain land values (`erf1873`) |
| `state/` | mixed: `registry.store.ts` is land; the rest is shared |
| `data/` | land only (models and mock data) |
| `features/link`, `features/check-extract` | land only |
| `features/dashboard`, `flow`, `capture`, `verify`, `documents`, `audit`, `anchorings`, `login` | generic screens with land wording or fields |
| `features/admin`, `check-proof`, `invite`, `denied` | shared |

Moving the app into a workspace touches `angular.json`, `tsconfig.app.json`, the Dockerfile (it
copies `dist/cportal-lrfe/browser`), the test scripts in `package.json`, the e2e stack
(`e2e/stack/config.mjs`, `playwright.config.ts`, `e2e/support/catalogue.ts` which reads
`app.routes.ts`, `e2e/support/samples.ts`), the lint configuration (`eslint.config.mjs`,
`scripts/lint-report.mjs`).

## What may never change

Existing installs and the evidence they have already published depend on these names and formats.
The pack maps to them; it never renames them.

- **In the anchored audit trail:** the trail hash covers each event's type, source, subjects and
  data (`audit/src/chain.js`). So `source: 'land-records'`, the `records.*` event types,
  `record:<id>` subjects and the `land-record-review` key are permanent.
- **In the tree:** leaf type 1 (record version) and the `record-version:` keys are stored and part of
  published roots.
- **Offline verifier:** `audit/verifier/lrfe-verify.mjs` repeats the land seal formula and checks
  the formats `lrfe-audit-proof/1`, `lrfe-evidence-pack/1` and the on-chain marker `lrfe-audit`.
  They stay byte-compatible; a new product's seal is added to the verifier.
- **Sealed extract PDFs** already issued keep verifying, offline and at `/check/:code`.
- **Stored ids:** role and permission ids (`record.*`, `sup`, `rec`, in the database and in tokens),
  document type ids (in edrms, intake and the search index), the event stream `LRFE` and its durable
  consumer names.

## The domain pack (CB-3, done)

A pack is a workspace package, `backend/domains/<name>` published as `@lrfe/domain-<name>`, that
exports `pack`. `@lrfe/common` loads the pack named by `LRFE_DOMAIN` (`land` when not set) once,
with a top-level `await`, checks it with `@lrfe/domain-pack` and freezes it; every service reads
it as `domain` (`import {domain} from '@lrfe/common'`). A pack that is missing or fails its check
stops the service at start, like the country pack (API-713). The web container writes the same
value into `/config.json` as `domain`. A pack never imports `@lrfe/common` (common is loading it)
or service code; the services pass it the helpers it needs.

| Section | Read by | Land pack (`backend/domains/land/src/`) |
|---|---|---|
| `documents` | edrms, intake, search | `documents/`: the six document types and their fields (with each field's search role), the reference format ("T 2210/2008"), the field types and their checks (deed and SG numbers, Namibian ID numbers, dates, extents, money), the reading prompt and its version, the land checks and cross-checks, the stand-in reader's demo answers |
| `identity` | identity | `identity/`: the "Land records" group and its permissions, the roles `sup`, `scan`, `rev`, `rec`, `aud`, the rules `sod2` and `sod3`, the default offices, the demo users |
| `workflows` | bpm | `workflows/`: `land-record-review`; who acknowledges the audit workflows (`rec`, `sup`); their descriptions |
| `recordKind` | audit; its `service`: identity, edrms, gateway, audit, extracts, bpm (CB-4) | `record-kind.js`: the record service (`service`: `land-records`, its label and `RECORDS_URL`), the source `land-records`, the commit event, the review process key, the linked documents of a record event, the commit permission, the lookup patterns (record and deed numbers). Null in a pack without records |
| `wording` | edrms, identity, audit, extracts | `wording/`: the EDRMS business function and examples, the invitation's "land records system", "land record" in audit's messages and the evidence pack README, every text of the extract PDF and its number prefix `EX` |

What stays in the platform, so that a product without these parts still works: the platform
permission groups and the `adm` role, the rules `sod1` and `sod4`, the audit workflows
(`audit-finding`, `audit-rereview`: started by audit, so their variables are audit's contract; the
pack only says who acknowledges) and `document-amendment`, the generic reading pipeline (the
duplicate check, the `text` field type, a generic prompt), the extract PDF layout, and the trail,
tree and proof formats.

**The shipping pack** (`backend/domains/shipping`) has every section and nothing in it. With
`LRFE_DOMAIN=shipping` the services start: no document types (filing says so), only the `adm`
role and no demo users, only `document-amendment` deployed, no record leaves or record proofs
(`record-version` proofs answer 400), lookups search documents only. It is a starting point, not a
product: issuing an extract or raising an audit finding needs the wording and acknowledgers a
real pack gives (the bill-of-lading pack, epic CB-1).

**Byte-for-byte for land.** The land pack maps to the fixed names below and gives the same
values the code held: the identity catalogue, the workflow definitions (so bpm deploys no new
versions on upgrade), the reading prompt and its version, the subjects of each trail event in
their order, and the extract PDF (checked by hashing PDFs before and after) are unchanged.

**Adding a product:** a new folder `backend/domains/<name>` with its `package.json`, the pack
exported as `pack`, a test that it passes `checkDomainPack`; add it to `backend/Dockerfile` (its
`package.json`), and run `npm install` in `backend/`. A pack's prompt version
(`documents.reading.promptVersion`) changes whenever its types or prompt texts change.

### Land terms still in the shared services

The calls to the record service by name are gone (CB-4, see the record contract below). What
remains:

- **The record's data shape:** extracts' owner check before issuing (`issue-checks.js`,
  `version.data.owners`), the `ownerIndex` field of its API, the owner columns it stores. The
  record contract carries a version's `data` as the product's own; reading owners from it is
  still land's.
- **Stored names:** the `property` key of intake's summaries and search's results (filled from the
  field whose search role is `place`), the office type `registry`.
- **Defaults:** the country `NA` and office `WDH` as default settings of edrms and intake
  (Namibian values as defaults only).
- **Not code:** examples in the API docs, the developer scripts that check land sample scans, the
  design history in `services/audit/README.md`.

## The record contract (CB-4)

The shared services never call a product service by name. The pack names its record service in
`recordKind.service` (land: `{name: 'land-records', label: 'land records', urlSetting:
'RECORDS_URL', defaultUrl: 'http://localhost:3505'}`); `recordServiceOf(domain)` in `@lrfe/common`
gives its name, label and address (from its setting), or null for a pack without records. From it:

- **The callers' allow-lists:** identity lets the record service read `/policies/effective`;
  edrms lets it read documents with a service token, and search documents still in intake for a
  user who may read them (`intake=true`); audit's allow-list likewise.
- **The gateway:** `/api/records/*` goes to the record service, at its setting's address
  (`RECORDS_URL` for land, unchanged). A pack without records has no `/api/records` route, and the
  gateway starts without that address.
- **The calls:** audit, extracts and bpm send them through one client, `createRecordClient` of
  `@lrfe/record-contract`, over their own transport (their timeouts, error texts, service token).
  Error texts take the service's `label` ("The land records service cannot be reached: ..."). With
  no record service (the shipping pack today) every service still starts; a call answers 503
  "This install has no record service".

Fixed names stay as they are, since they are stored or anchored: the event source `land-records`,
the `records.*` events, the setting `RECORDS_URL`.

Every call needs a service token (`typ: service`); the record service checks the caller.

| Call | Method and path | Query or body | Answer | Called by |
|---|---|---|---|---|
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
submitted version. land-records runs it in `services/land-records/tests/contract.test.js`, in
process over `app.inject`; the bill-of-lading service will run the same suite. Details in
[`backend/packages/record-contract/README.md`](../../backend/packages/record-contract/README.md).

## Country pack and domain pack

The country pack (API-713, `backend/packages/search-index/src/country-pack.js`) is a JSON file
checked at start, with examples that double as self-tests, chosen by a two-letter code. The domain
pack follows the same ideas (checked at start, fails early, one selector) but is a JavaScript
module, because it also brings code: connectors, the PDF layout, reading checks, the event-to-leaf
mapping. It is loaded in one place (`@lrfe/common`) instead of one setting per service.
