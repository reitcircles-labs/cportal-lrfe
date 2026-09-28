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

## Screens (routes)

| Route | Role | What it does |
|---|---|---|
| `#/` | Overview | Swim-lane flow map (who does what, where) and the metadata schema (Namibia field → ERP attribute → NL Kadaster reference) |
| `#/capture` | Scan operator | Live scanner or watched hot folder. Pages stream in, split per instrument, classified. Click any page to open the **viewer** |
| `#/verify` | Metadata reviewer | Scalable **review queue** (search, Open/Filed/All filter, lowest-confidence sort, collapsible batches). Two layouts: *side by side* (page image + fields) and *field focus* (one zoomed field at a time, Enter to accept). Namibian ID format checks. Approve & file to EDRMS |
| `#/link` | Records officer | Two layouts: *chain timeline* and *match queue* (ranked candidate erven with reasons and a document preview). Live owners and undivided shares, record validation (shares = 1, chain of title, extent vs. SG diagram, ID validity), commit record version |
| `#/audit` | Auditor (read-only) | Document strip for the record, page evidence with corrected values outlined, field-level provenance (extracted vs. verified, confidence, reviewer), integrity (EDRMS ID, SHA-256, capture, link), per-document trail, raise finding / mark audited, full hash-chained audit trail |

The **document viewer** (`shared/viewer.component.ts`) works in three contexts: `batch` (capture), `record` (linking, with link/reject actions) and `audit` (read-only). It supports a page strip, next/previous, zoom, rotate and keyboard (← → Esc).

## Structure

```
src/
  styles/industry.css      Design-system tokens + component classes (blueprint frames, buttons, tags, tables, forms)
  styles/app.css           Layout helpers
  app/
    app.component.ts       Shell: header, step navigation, role badge, global viewer
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
