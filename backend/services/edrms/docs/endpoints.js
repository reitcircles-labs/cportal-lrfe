// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.
//
//   'METHOD /path': { summary, description?, tag, status? (success code), auth? (routes without a guard), upload? }
//   auth: 'public' | 'refresh-cookie' | 'signed-link'

export const ENDPOINTS = {
  title: 'edrms',
  description:
    'Sealed, versioned documents of record. Read by anyone who works with documents; written only by services (intake files, bpm applies approved amendments).',
  tags: {
    Documents: 'Filed documents of record, their versions and content.',
    Filing:
      'Service-to-service writes. Browsers cannot call these: they need a service token.',
    Service: 'Health and metadata.',
  },
  routes: {
    'GET /health': {tag: 'Service', summary: 'Health check', auth: 'public'},
    'GET /catalogue': {
      tag: 'Service',
      summary: 'Document types and record-metadata fields',
      description: '`{ docTypes, recordMetadataFields }`.',
    },

    'GET /documents': {
      tag: 'Documents',
      summary: 'Search documents',
      description:
        "`{ items, total, totalCapped? }`. `q` searches numbers, references and field values. Filter on any extracted field with `field.<key>=<value>`, e.g. `field.property=Erf 1873, Klein Windhoek`. Each item has `status`: `filed`, or `intake` for a document still in intake (only with `EDRMS_SEARCH=opensearch`, and only for a user with intake's read permission, or for land-records with `intake=true` on such a user's behalf): `{ id (intake's), status, intakeStatus, docType, instrumentRef, party, props.property, fields }`. Through the index a total above 1,000 is given as 1000 with `totalCapped: true` (more than that); when the index cannot answer, 503.",
    },
    'GET /documents/lookup': {
      tag: 'Documents',
      summary: 'Find one document by a reference',
      description:
        'By `edrmsNo`, `instrumentRef` (e.g. T 2210/2008) or `sourceId` (the intake document id). 404 when there is none.',
    },
    'GET /documents/seals': {
      tag: 'Documents',
      summary:
        "Every document version's seal, oldest first (audit service only)",
      description:
        "`{ items: [{ documentId, version, seal, at }], next }`: pass `next` as `after` for the next page; null at the end. For the audit service's one-time backfill of its tree (API-669).",
    },
    'GET /documents/changed': {
      tag: 'Documents',
      summary: 'Documents changed since a moment (search service only)',
      description:
        '`{ items: [{ id, sourceId, updatedAt }], next, total }`, filed or corrected at or after `since` (date-time, all when left out), oldest change first; `limit` (≤ 500). Pass `next` as `after` for the next page; null at the end. `total` on the first page only. For the search re-index and rebuild (API-808, API-804).',
    },
    'GET /documents/{id}': {
      tag: 'Documents',
      summary:
        'One document with its fields, record metadata and version history',
      description:
        'For a user, each version also has `anchoring`: `{ status, batch, tx, network, confirmedAt }` with `status` `waiting` (for the next anchoring), `anchored` or `confirmed`, or null when the audit service cannot say. Services reading the document do not get it.',
    },
    'GET /documents/{id}/versions/{n}': {
      tag: 'Documents',
      summary: 'One version of a document',
      description:
        'The version with its fields, record metadata, seal and provenance, and `text`: `{ pages }` when the page text belongs to this version (the filed one), else null. Intake checks it before clearing its copy of a filed document (API-807).',
    },
    'GET /documents/{id}/reading': {
      tag: 'Documents',
      summary:
        "A filed document's page text and AI values (search service only)",
      description:
        "`{ documentId, pages: [{ page, text }], extracted }`: the AI's page text, decrypted, and the values it read (version 1.0's provenance). For the search index once intake has cleared its copy (API-807); never served to a browser.",
    },
    'GET /documents/{id}/content': {
      tag: 'Documents',
      summary: 'Short-lived link to the file',
      description:
        '`{ url, version, mimeType, sha256, expiresIn }`. `?version=` defaults to the current version. Open `url` directly (it needs no token): a presigned S3 URL, or GET /content/{id}/{n} for local storage.',
    },
    'GET /content/{id}/{n}': {
      tag: 'Documents',
      auth: 'signed-link',
      summary: 'File content behind a signed link (local/memory storage)',
      description:
        'Use the `url` from GET /documents/{id}/content; `exp` and `sig` authorise it. 404 when expired or tampered with.',
    },
    'GET /documents/{id}/versions/{n}/file': {
      tag: 'Documents',
      summary: "A version's file, for the audit service's evidence pack",
      description:
        'The stored bytes (decrypted when the store encrypts), as filed. Audit service token only.',
    },
    'GET /documents/{id}/versions/{n}/verify': {
      tag: 'Documents',
      summary: 'Integrity check of a version',
      description:
        'Recomputes the SHA-256 of the stored file and checks the seal: `{ intact, contentIntact, sealIntact, version, checkedAt, … }`.',
    },

    'POST /documents': {
      tag: 'Filing',
      summary: 'File a document (intake only)',
      upload: {
        meta: 'JSON: document type, fields, provenance (at most 64 kB)… (must come before the file)',
        transcription:
          "optional JSON: the AI's page text `[{ page, text }]`, stored encrypted beside the file (before the file)",
        file: 'the scanned file',
      },
      description:
        'multipart/form-data with a `meta` JSON field FIRST, then `file`. 201 `{ document, created: true }`, or 200 `{ document, created: false }` when the same source was already filed.',
    },
    'PUT /documents/{id}/transcription': {
      tag: 'Filing',
      summary: 'Add the page text of a document filed without it (intake only)',
      description:
        "`{ pages: [{ page, text }] }`: the AI's page text, stored encrypted beside the filed scan. " +
        "Intake's back-fill for documents filed before the text came with the filing. " +
        '201 `{ created: true }`, or 200 `{ created: false }` when the document has its text already.',
    },
    'POST /documents/{id}/amendments': {
      tag: 'Filing',
      status: 201,
      summary: 'Apply an approved amendment (bpm only)',
      description:
        'Creates a new sealed version; the previous one is kept. Users request changes through bpm: POST /processes/document-amendment/instances. The approver must differ from the requester. Returns `{ document, version }`.',
    },
  },
};
