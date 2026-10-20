// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export const ENDPOINTS = {
  title: 'land-records',
  description:
    'Land records: filed EDRMS documents aggregated per parcel, versioned, reviewed by a second person before each version is committed, and sealed. Design: services/land-records/README.md.',
  tags: {
    Records: 'Land records, their versions and seal chain.',
    Documents: 'Filed EDRMS documents, found for land records.',
    Service: 'Health and metadata.',
  },
  routes: {
    'GET /health': {tag: 'Service', summary: 'Health check', auth: 'public'},
    'GET /records/catalogue': {
      tag: 'Service',
      summary: 'Parcel kinds and their JSON Schemas',
      description:
        '`{ parcelKinds: [{ id, label, schemaVersion, schema, draftSchema }] }`. A draft is validated against `draftSchema` (types only), a version submitted for review against `schema`.',
    },
    'GET /records': {
      tag: 'Records',
      summary: 'List and search land records',
      description:
        "`{ items, total }`. `q` searches the record number, the parcel, owners' names and ID numbers, and document references. `status`: `draft` (never committed), `committed`, `in_review` (a version waits for approval), `needs_review` (a linked document was corrected), `new_document` (a document filed for the parcel is not in the record yet). Each record has `needsReview` and `newDocuments`.",
    },
    'GET /records/document-search': {
      tag: 'Documents',
      summary: 'Search filed documents to add to a land record',
      description:
        '`{ items, total }`. The edrms search (words, word starts, spelling variants of names, `docType`, `field.<key>=<value>` filters), each document with `linkedTo` (other records that hold it) and, with `recordId`, `inThisRecord`.',
    },
    'GET /records/{id}/suggestions': {
      tag: 'Documents',
      summary: 'Documents that match this parcel, with the reasons',
      description:
        '`{ parcel, items }`. Each item: the document, `reasons` (property is this parcel; SG diagram cited by, prior title of, or citing a document already in the record), `inThisRecord`, `linkedTo`.',
    },
    'GET /records/document-details/{edrmsDocumentId}': {
      tag: 'Documents',
      summary: "A filed document's metadata, for land records",
      description:
        'The document as `document-search` returns it: `fields` (`k`, `label`, `v`, `edited`) and `linkedTo` (the records that hold it).',
    },
    'POST /records/{id}/flags/dismiss': {
      tag: 'Records',
      summary: 'Dismiss a "new document" flag, with the reason',
      description:
        "`{ edrmsDocumentId, reason }`. The flag moves to the record's `flagLog` (shown with the history), with who dismissed it, when and why. A flag also ends while a draft holds its document (`outcome: added`), and comes back if the document is taken out of that draft.",
    },
    'POST /records/preview': {
      tag: 'Records',
      summary:
        'Before creating a record: the parcel, the documents about it, an existing record',
      description:
        "`{ edrmsDocumentId }` and/or `{ parcel }` (the parcel as corrected). Returns `{ document, read, parcel, missing, suggested, documents, existing }`: `read` the parcel read from the document's property field (null when unclear); `parcel` the one checked (`parcel` given, else `read`); `missing` its required fields still empty; `documents` the filed documents with the same parcel number, each with `matches` and, when not, `mismatch: { missing, otherPortion }` (the parcel's words its property does not name); `suggested` a value for a missing field that all documents describing the parcel agree on, `{ field: { value, from } }`; `existing` the record the parcel already has (with `hasDocument`), or null. Reads only.",
    },
    'POST /records': {
      tag: 'Records',
      summary: 'Create a land record (draft v1)',
      description:
        "`{ parcel }`, or `{ edrmsDocumentId }` to read the parcel from a filed document's property field and link that document. One record per parcel: 409 with `recordId` when the parcel already has one.",
    },
    'PATCH /records/{id}/draft': {
      tag: 'Records',
      summary: 'Edit the draft: core fields, attributes, suggestions',
      description:
        "`{ revision, changes, accept, reason }`. `changes`: parcel (same kind), extent, tenure, owners, encumbrances, attributes (null removes). `accept`: take over the documents' suggested owners, extent or encumbrances. Owners or an extent that differ from the suggestions are marked as entered by hand and need a `reason`. Suggestions (`derived`) and checks are recomputed. 409 when `revision` is not the draft's current revision.",
    },
    'POST /records/{id}/draft/documents': {
      tag: 'Records',
      summary: 'Link a filed document to the draft',
      description:
        '`{ revision, edrmsDocumentId }`. The document is pinned at its current EDRMS version, with its seal and a snapshot of its verified fields.',
    },
    'DELETE /records/{id}/draft/documents/{edrmsDocumentId}': {
      tag: 'Records',
      summary: 'Remove a document from the draft',
      description: "`?revision=` the draft's current revision.",
    },
    'POST /records/{id}/draft/submit': {
      tag: 'Records',
      summary: 'Submit the draft for review',
      description:
        '`{ revision }`. Refused (400) while the data is incomplete (`problems`) or an error check fails (`failing`). The draft is frozen and the bpm process `land-record-review` starts: an approval task for `record.finalize`, never the submitter.',
    },
    'POST /records/{id}/draft/withdraw': {
      tag: 'Records',
      summary: 'Withdraw a version from review',
      description:
        'Only the submitter, before a decision. The review task disappears and the draft is editable again.',
    },
    'GET /records/{id}/review': {
      tag: 'Records',
      summary: 'What the reviewer sees',
      description:
        '`{ record, version, checks, blocking, overrides, diff, currentVersion }`. `diff` against the current committed version: `fields` (path, before, after), `owners` (added, removed, changed), `encumbrances`, `documents` (added, removed, updated to a newer EDRMS version).',
    },
    'POST /records/{id}/versions/{n}/commit': {
      tag: 'Records',
      summary: 'Commit an approved version (bpm only)',
      description:
        '`{ by, comment }`. Seals the version, chains it to the previous one (superseded) and makes it current. `by` must not be the submitter. Repeating it is harmless.',
    },
    'POST /records/{id}/versions/{n}/reject': {
      tag: 'Records',
      summary: 'Return a rejected version to the submitter (bpm only)',
      description:
        '`{ by, comment }`. The version becomes a draft again with the comment.',
    },
    'POST /records/{id}/draft': {
      tag: 'Records',
      summary: 'Open a new draft to change a committed record',
      description:
        'The draft vN+1 is a copy of the current version, which stays current until the new one is approved. One open draft per record (409). The record then carries `draftDiff`: what the draft changes against the current version.',
    },
    'POST /records/{id}/draft/documents/{edrmsDocumentId}/refresh': {
      tag: 'Records',
      summary: "Adopt a document's newer EDRMS version",
      description:
        '`{ revision }`. After a correction in edrms: the pinned version, seal and fields are updated in the draft, suggestions and checks recomputed. Goes through review like any change.',
    },
    'GET /records/{id}/history': {
      tag: 'Records',
      summary: 'History: every committed version',
      description:
        '`{ intact, flags, flagLog, versions }` (`flagLog`: ended "new document" flags, `outcome` `dismissed` with who, when and why, or `added` to a draft), versions newest first: submitter, approver, dates, review comment, seal with `intact` and `linked`, `diff` against the version before, and `anchoring`: `{ status, batch, tx, network, confirmedAt }` with `status` `waiting` (for the next anchoring), `anchored` or `confirmed`, or null when the audit service cannot say.',
    },
    'GET /records/{id}/comments': {
      tag: 'Records',
      summary: 'Comments on a record',
    },
    'POST /records/{id}/comments': {
      tag: 'Records',
      summary: 'Comment on a record',
      description: '`{ body }`. Kept with the version open at the time.',
    },
    'POST /records/lookup': {
      tag: 'Records',
      summary:
        'Land record labels, the documents committed versions are made of, and the versions that pin documents (audit service only)',
      description:
        "Body `{ recordIds?, versions?: [{ recordId, versionNumber }], pinning?: [documentId] }`, up to 1000 record ids and versions and 100 documents. `{ records: [{ id, recordNo, label }], versions: [{ recordId, versionNumber, documents: [{ id, version, edrmsNo, docType, ref }] }], pinnedBy: [{ documentId, version, recordId, versionNumber }] }`: for committed versions (current or superseded) only; drafts never count. `records` has every record asked for or named in the answer. For the audit service's Anchorings screens: what a batch covers (API-696) and the search (API-697).",
    },
    'GET /records/seals': {
      tag: 'Records',
      summary:
        "Every committed version's seal, oldest first (audit service only)",
      description:
        "`{ items: [{ recordId, version, seal, at }], next }`: pass `next` as `after` for the next page; null at the end. Superseded versions included. For the audit service's one-time backfill of its tree (API-669).",
    },
    'GET /records/{id}': {
      tag: 'Records',
      summary: 'One land record with its current version and open draft',
    },
    'GET /records/{id}/versions': {
      tag: 'Records',
      summary:
        'All versions of a record: state, who submitted and approved, seal, changes',
    },
    'GET /records/{id}/versions/{n}': {
      tag: 'Records',
      summary:
        'One version, with its data (core, attributes, pinned documents)',
    },
    'GET /records/{id}/verify': {
      tag: 'Records',
      summary: 'Recompute the seal chain of the committed versions',
      description:
        "`{ intact, versions: [{ versionNumber, seal, intact, linked }] }`. `intact`: the seal matches the version; `linked`: it includes the previous version's seal. Also for the audit service, which checks a proof against it.",
    },
  },
};
