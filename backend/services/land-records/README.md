# land-records service (design)

*Design for epic API-642, written 5 October 2026 (API-643) before the implementation (API-644 to
API-651). Updated at the end of the epic if the implementation changes anything.*

A **land record** brings together the filed EDRMS documents of one parcel (an erf, a farm portion,
a sectional unit) with the parcel's current facts: extent, tenure, owners and their shares,
encumbrances. Records evolve: documents are added, removed or replaced by newer versions, and
**every change is reviewed by a second person before it becomes the current version**.

The service runs on port 3505, behind the gateway at `/api/records`, with its own PostgreSQL schema
`records`. edrms stays the store of documents: a record only **points** at documents and never
copies their files.

## 1. Concepts

| Term | Meaning |
|---|---|
| **Land record** | One per parcel. Has a record number (`LR-NA-2026-000001`) and a parcel key that is unique |
| **Parcel key** | `kind` + registration division + township or farm + number + portion, normalised (e.g. `erf:K:KLEIN WINDHOEK:1873`) |
| **Version** | One complete state of the record as a JSON document. Committed versions are sealed and never change; at most one draft is open at a time |
| **Current version** | The latest committed version. A draft does not change it until it is approved |
| **Pinned document** | A reference to one **version** of an EDRMS document, with that version's seal and a snapshot of its verified fields |

## 2. A version (JSON)

A typed **core** that checks and search rely on, free **attributes**, and the **documents**.

```json
{
  "schemaVersion": "erf/1",
  "parcel":   { "kind": "erf", "number": "1873", "portion": null, "township": "Klein Windhoek", "regDiv": "K", "region": "Khomas" },
  "extent":   { "value": 1214, "unit": "m2", "source": { "from": "document", "edrmsNo": "EDR-NA-2026-000003" } },
  "tenure":   "freehold",
  "owners": [
    { "name": "Maria Nghishidi",   "idNo": "75060200418", "share": "1/2", "since": "T 4521/2019", "source": { "from": "document", "edrmsNo": "EDR-NA-2026-000005" } },
    { "name": "Ndapewa Nghishidi", "idNo": "98030100562", "share": "1/4", "since": "T 4521/2019", "source": { "from": "document", "edrmsNo": "EDR-NA-2026-000005" } },
    { "name": "Tomas Nghishidi",   "idNo": "01112500379", "share": "1/4", "since": "T 4521/2019", "source": { "from": "document", "edrmsNo": "EDR-NA-2026-000005" } }
  ],
  "encumbrances": [],
  "attributes": { "zoning": "Residential" },
  "documents": [
    { "edrmsDocumentId": "…", "edrmsNo": "EDR-NA-2026-000005", "version": 1, "seal": "1b11…",
      "docType": "deed_of_transfer", "ref": "T 4521/2019", "addedBy": "u7", "addedAt": "2026-10-05T09:12:00Z",
      "fields": { "deedNo": "T 4521/2019", "regDate": "9 July 2019", "priorTitle": "T 2210/2008", "tee1": "Ndapewa Nghishidi", "…": "…" } }
  ]
}
```

- **Core fields:** `parcel`, `extent`, `tenure`, `owners` (name, ID number, share as a fraction,
  the deed they hold under), `encumbrances` (type such as bond or servitude, reference, in favour
  of). Owners and extent carry their **source**: `document` (with the EDRMS number) or `manual`
  (with the officer and a reason).
- **`attributes`:** free JSON for what does not fit the core (zoning, municipal account, notes).
  Not used by checks; searchable as text.
- **`documents`:** each pinned to a version, with that version's seal and a snapshot of its
  verified fields. The snapshot makes a committed version self-contained: its owners, chain and
  checks can be recomputed and verified later without asking edrms, and the seal covers exactly what
  the reviewer saw.

### Parcel kinds and schemas

A catalogue (like the document types in intake) defines the parcel kinds and a **JSON Schema** per
kind, versioned:

| Kind | Core required | Notes |
|---|---|---|
| `erf` | parcel (number, township, regDiv), extent, tenure | urban erven |
| `farm_portion` | parcel (farm name and number, portion, regDiv), extent in hectares, tenure | rural land |
| `sectional_unit` | parcel (scheme name and number, unit), participation quota, tenure | sectional titles |

Each version records its `schemaVersion` (e.g. `erf/1`) and is validated against that schema.
A schema change gets a new number; old versions keep validating against the schema they were
committed with. `attributes` stays free unless a schema chooses to describe parts of it.

## 3. Owners and extent: suggested from documents, confirmed

When documents are added or removed, the service **suggests** the core facts from them; the officer
confirms each suggestion or overrides it (an override needs a reason and is shown to the reviewer).

- **Owners and shares:** the transferees (or grantees) of the **latest** linked deed of transfer or
  grant by registration date, with their ID numbers; shares from the deed's share field ("½ share
  each" → 1/2 each, "¼ share each" → 1/4 each; a single transferee holds 1/1). Estate transfers work
  the same way (the heirs are the transferees).
- **Extent:** from the linked SG diagram; else from the latest deed.
- **Encumbrances:** from linked mortgage bonds (bond number, mortgagee) that are not cancelled.
- **Chain of title:** the deeds in registration order, each citing its prior title.

## 4. Checks

Computed on every draft change and shown with the reason. Errors block submitting.

| Check | Rule | Level |
|---|---|---|
| `shares_sum` | the owners' shares add up to exactly 1 | error |
| `chain_of_title` | every deed's prior title is in the record (back to the first linked title), and its transferor was a holder under that prior title | error |
| `extent_vs_sg` | the extent equals the SG diagram's area (within 0.5 %) | error |
| `id_numbers` | every owner's ID number is a valid 11-digit Namibian ID (companies: registration number) | error |
| `parcel_match` | every linked document describes this parcel (property field) | error |
| `documents_current` | every pinned document is at its current EDRMS version | warning (see §8) |
| `overrides` | owners or extent entered by hand | warning (shown to the reviewer) |

## 5. Lifecycle

```
                    ┌──────────── reject (comment) ─────────────┐
                    ▼                                           │
create ──► draft ──submit──► in review ──approve (second person)──► committed vN  (current)
            ▲  │ withdraw ◄───────┘                                     │
            │  └── edit (metadata, documents)                           │ change
            └───────────────────── new draft vN+1 (copy of vN) ◄────────┘
```

- **Record states:** `draft` (never committed), `committed` (has a current version), `committed
  with draft` (a change in progress), `in review`, `needs review` (a linked document was corrected,
  §8).
- **Version states:** `draft`, `in_review`, `committed`, `superseded` (an older committed version).
  A rejected or withdrawn version goes back to `draft` with the reviewer's comment.
- **One open draft per record.** Edits carry the draft's revision number; an edit on an older
  revision is refused (someone else changed it: reload).
- **Submitting** is refused while any error check fails (the list is returned). The draft is frozen
  until approved, rejected or withdrawn.

## 6. Review and commit (four-eyes, through bpm)

- Submitting starts a bpm process **`land-record-review`** with the record, the version and the
  submitter. Its approval task is for users with `record.finalize`, **excluding the submitter**,
  and appears in the task inbox (the bell), like document corrections.
- With the security policy **"Four-eyes finalization"** on (default), the approver must also differ
  from the reviewers who filed the record's documents in edrms (the policy's existing wording).
- **What the reviewer sees:** the submitted version, the checks, the overrides, and the **difference
  from the current committed version**: core fields changed (path, before, after), owners and
  shares, documents added, removed or moved to a newer version.
- **Approve:** bpm calls land-records (service token) to commit: the version becomes `committed`
  and current, the previous one `superseded`, the seal is computed, the event
  `records.record.committed` is published.
- **Reject:** a comment is required; the version returns to the submitter as a draft with the
  comment.
- **Withdraw:** the submitter withdraws before a decision; the task disappears.

## 7. Seal and history

The seal of a committed version is SHA-256 over the canonical JSON (sorted keys, as edrms'
`canonicalJson`) of:

```
{ recordId, recordNo, versionNumber, data (the whole version JSON, documents with their seals and
  field snapshots), submittedBy, approvedBy, committedAt, previousSeal }
```

Each seal includes the previous version's seal, so the versions form a chain: changing any earlier
version breaks every later seal. A verify endpoint recomputes the chain and, optionally, checks that
each pinned document's seal still matches edrms. The history shows every committed version with
submitter, approver, date and the difference from the one before.

## 8. When edrms corrects a document

edrms publishes `edrms.document.amended` (over NATS) when a filed document gets a new version.
land-records finds every record whose current version or draft pins an older version of that
document and marks it **needs review** ("document updated: EDR-NA-… v1 → v2"). The current version
does **not** change by itself. Adopting the newer version is a draft change like any other: the
pinned version, seal and field snapshot are updated, the owners and checks recomputed, and the
change goes through review. The flag clears when a committed version pins the current document
version.

## 9. Finding documents

Search over filed documents by their verified metadata (deed or diagram number, property, owner
name, ID number, document type, free text) and "matches this parcel" suggestions, with the reason
and whether a document is already in this or another record: API-645. edrms search moves to
PostgreSQL full-text and trigram search behind one search function; a dedicated engine
(OpenSearch) can replace it later.

## 10. API (planned)

All under `/api/records` through the gateway; every service checks the token and permission itself.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /records?q=&status=` | `record.view` | list and search records |
| `GET /records/:id` | `record.view` | the record with its current version, open draft and flags |
| `GET /records/:id/versions/:n` · `…/verify` | `record.view` | a version · verify the seal chain |
| `POST /records {parcel}` | `record.create` | create a record (draft v1) |
| `PATCH /records/:id/draft {revision, changes}` | `record.create` or `record.link` | edit core fields and attributes; confirm or override suggestions |
| `POST /records/:id/draft/documents {edrmsDocumentId}` | `record.link` | pin a document (its current version) |
| `DELETE /records/:id/draft/documents/:edrmsDocumentId` | `record.unlink` | remove a document |
| `POST /records/:id/draft` | `record.create` or `record.link` | open a new draft from the current version |
| `POST /records/:id/draft/submit` · `…/withdraw` | `record.link` | submit for review · withdraw |
| `GET /records/:id/comments` · `POST` | `record.view` · `record.comment` | discussion |
| `GET /documents/search?…` · `GET /records/:id/suggestions` | `record.view` | find documents (API-645) |
| `POST /records/:id/versions/:n/commit` · `…/reject` | service token from bpm | decisions from the review process |

## 11. Events

`records.record.created`, `records.draft.changed`, `records.draft.submitted`,
`records.record.committed`, `records.draft.rejected`, `records.record.flagged`; consumed:
`edrms.document.amended`.

## 12. Permissions (already in the catalogue)

| Permission | Records officer | Registrar |
|---|---|---|
| `record.view` | ✓ | ✓ |
| `record.create`, `record.link`, `record.unlink` | ✓ | |
| `record.comment` | ✓ | ✓ |
| `record.finalize` (approve a change) | ✓ (not their own) | ✓ |

Existing separation-of-duties rules still apply (whoever finalizes cannot sign off audits;
administrators cannot finalize).

## 13. Not in this epic

Tokenization of committed records; AI suggestions of matching documents (API-626); migrating the
frontend's demo records; per-records-series keys and retention (storage epics).
