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
  change.
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
organisation settings for a site that sets none, its permission list, and its sign-in texts.
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

These are what the land pack must provide:

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

## Country pack and domain pack

The country pack (API-713, `backend/packages/search-index/src/country-pack.js`) is a JSON file
checked at start, with examples that double as self-tests, chosen by a two-letter code. The domain
pack follows the same ideas (checked at start, fails early, one selector) but is a JavaScript
module, because it also brings code: connectors, the PDF layout, reading checks, the event-to-leaf
mapping. It is loaded in one place (`@lrfe/common`) instead of one setting per service.
