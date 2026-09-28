# cportal-lrfe — Land records intake (frontend demo)

Angular 18 demo of Phase 1 of the national land-tokenization programme: scanned deeds go into an **EDRMS** as documents of record, reviewers verify the extracted metadata, and records officers link the documents into **ERP** land records (one record per erf or farm portion). An auditor can inspect every document, its metadata and its history.

The data is local mock data for Namibia (Deeds Registries Act 14 of 2015 conventions, with the Dutch Kadaster used as a reference). All names, ID numbers and deed references are fictitious.

## Run

```bash
npm install
npm start          # http://localhost:4200
npm run build      # production build in dist/cportal-lrfe
```

Requires Node 18.19+ or 20+.

## Look & feel

Government-enterprise theme (`src/styles/theme.css`): white cards on a light grey ground, deep navy sidebar, one blue accent, Public Sans throughout. Namibian flag colours appear as the brand stripe and in status semantics (green = done, gold = needs attention, red = danger). Light and dark mode (toggle in the top bar; follows the OS on first visit). The coat-of-arms tile is a placeholder, so swap in the official artwork before any public demo.

## Screens (routes)

| Route | Who | What |
|---|---|---|
| `#/login` | Everyone | Split sign-in: programme panel + form, role picker, national eID button (demo: any credentials) |
| `#/` | Registrar / all | Dashboard: KPIs, batch pipeline, tokenization readiness, 7-day throughput, queue by batch, recent activity |
| `#/capture` | Scan operator | Live scanner or hot folder; pages stream in; click any page to open the viewer |
| `#/verify` | Metadata reviewer | Review queue (search, filter, sort, batches) + side-by-side or field-focus verification |
| `#/link` | Records officer | **Land record (create/finalize)**: browse and search all land records, create a new record, see every linked document (view / remove), search the EDRMS and add documents (parcel matches ranked first), chain of title, comment thread, owners and record checks, finalize (with confirmation) |
| `#/audit` | Auditor | Evidence per document, provenance, integrity, findings/sign-off (with confirmation), full trail |
| `#/flow` | Programme | Swim-lane process map and metadata schema (Namibia ↔ ERP ↔ NL Kadaster) |

The sidebar role switcher changes the acting user and jumps to that role's queue. Toasts confirm every state change; destructive or irreversible actions ask first. Below 960px the sidebar becomes a drawer.

## Structure

```
src/
  styles/theme.css         Tokens (light/dark), buttons, tags, forms, tables, cards, dialogs
  styles/app.css           Layout helpers
  app/
    app.component.ts       Shell: navy sidebar, role switcher, top bar, mobile drawer, viewer + overlays
    state/auth.service.ts  Demo roles, sign-in, route guard
    state/theme.service.ts Light/dark
    state/toast.service.ts, confirm.service.ts
    features/login, features/dashboard
    app.routes.ts
    data/models.ts         Types: LandDoc, DocField, Batch, Candidate, AuditEntry…
    data/mock-data.ts      Sample instruments, queue generator, candidates, flow model, schema
    state/registry.store.ts  Signals store: capture, field edits, filing, linking, owners, checks, audit trail
    state/viewer.service.ts
    shared/                doc-page (renders a scanned page), viewer, icon (Lucide, 1.5 stroke)
    features/              flow, capture, verify, link, audit
```

## Moving past the demo

- Replace `RegistryStore` methods with calls to the EDRMS API (ingest, metadata, file) and the ERP API (candidate search, link, commit).
- Serve real page images (PDF/A, TIFF) in `DocPageComponent`, with extraction bounding boxes driving the highlights.
- Put every mutating action behind server-side audit logging; the client-side hash chain here only illustrates the idea.

## Publishing to GitHub

```bash
cd angular-app
git init
git add .
git commit -m "Land records EDRMS → ERP frontend demo (Angular 18)"
git branch -M main
git remote add origin https://github.com/reitcircles-labs/cportal-lrfe.git
git push -u origin main
```
