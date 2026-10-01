// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.
//
//   'METHOD /path': { summary, description?, tag, status? (success code), auth? (routes without a guard), upload? }
//   auth: 'public' | 'refresh-cookie' | 'signed-link'

export default {
    title: 'edrms',
    description: 'Sealed, versioned documents of record. Read by anyone who works with documents; written only by services (intake files, bpm applies approved amendments).',
    tags: {
        Documents: 'Filed documents of record, their versions and content.',
        Filing: 'Service-to-service writes. Browsers cannot call these: they need a service token.',
        Service: 'Health and metadata.'
    },
    routes: {
        'GET /health': { tag: 'Service', summary: 'Health check', auth: 'public' },
        'GET /catalogue': { tag: 'Service', summary: 'Document types and record-metadata fields', description: '`{ docTypes, recordMetadataFields }`.' },

        'GET /documents': {
            tag: 'Documents', summary: 'Search filed documents',
            description: '`{ items, total }`. `q` searches numbers, references and field values. Filter on any extracted field with `field.<key>=<value>`, e.g. `field.property=Erf 1873, Klein Windhoek`.'
        },
        'GET /documents/lookup': {
            tag: 'Documents', summary: 'Find one document by a reference',
            description: 'By `edrmsNo`, `instrumentRef` (e.g. T 2210/2008) or `sourceId` (the intake document id). 404 when there is none.'
        },
        'GET /documents/{id}': { tag: 'Documents', summary: 'One document with its fields, record metadata and version history' },
        'GET /documents/{id}/versions/{n}': { tag: 'Documents', summary: 'One version of a document' },
        'GET /documents/{id}/content': {
            tag: 'Documents', summary: 'Short-lived link to the file',
            description: '`{ url, version, mimeType, sha256, expiresIn }`. `?version=` defaults to the current version. Open `url` directly (it needs no token): a presigned S3 URL, or GET /content/{id}/{n} for local storage.'
        },
        'GET /content/{id}/{n}': {
            tag: 'Documents', auth: 'signed-link', summary: 'File content behind a signed link (local/memory storage)',
            description: 'Use the `url` from GET /documents/{id}/content; `exp` and `sig` authorise it. 404 when expired or tampered with.'
        },
        'GET /documents/{id}/versions/{n}/verify': {
            tag: 'Documents', summary: 'Integrity check of a version',
            description: 'Recomputes the SHA-256 of the stored file and checks the seal: `{ intact, contentIntact, sealIntact, version, checkedAt, … }`.'
        },

        'POST /documents': {
            tag: 'Filing', summary: 'File a document (intake only)',
            upload: { meta: 'JSON: document type, fields, provenance… (must come before the file)', file: 'the scanned file' },
            description: 'multipart/form-data with a `meta` JSON field FIRST, then `file`. 201 `{ document, created: true }`, or 200 `{ document, created: false }` when the same source was already filed.'
        },
        'POST /documents/{id}/amendments': {
            tag: 'Filing', status: 201, summary: 'Apply an approved amendment (bpm only)',
            description: 'Creates a new sealed version; the previous one is kept. Users request changes through bpm: POST /processes/document-amendment/instances. The approver must differ from the requester. Returns `{ document, version }`.'
        }
    }
};
