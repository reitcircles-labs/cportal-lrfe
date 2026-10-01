// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.
//
//   'METHOD /path': { summary, description?, tag, status? (success code), auth? (routes without a guard), upload? }
//   auth: 'public' | 'refresh-cookie' | 'signed-link'

export default {
    title: 'intake',
    description: 'Capture of scans into batches, AI extraction of their metadata as proposals, field-by-field review against ' +
        'evidence and checks, and filing of the verified values into the EDRMS. ' +
        'Document status: queued → extracting → ready (in review) → filed, or failed (retry) / rejected.',
    tags: {
        Capture: 'Batches and uploads (permission capture.scan).',
        Documents: 'Captured documents and their extraction results.',
        Review: 'Field review (verify.edit) and filing or rejecting (verify.file). Changes claim the document for 30 minutes so two reviewers do not collide.',
        Service: 'Health, catalogue and AI cost.'
    },
    routes: {
        'GET /health': { tag: 'Service', summary: 'Health check', auth: 'public' },
        'GET /catalogue': { tag: 'Service', summary: 'Document types and their fields', description: '`{ docTypes: [{ id, label, refField, fields: [{ k, label, type, required }] }] }`.' },
        'GET /usage': { tag: 'Service', summary: 'AI extraction calls, tokens and cost for a month', description: '`?month=YYYY-MM`, default this month: `{ month, documents, costUsd, byModel }`.' },

        'GET /batches': { tag: 'Capture', summary: 'All batches with document counts per status' },
        'POST /batches': { tag: 'Capture', status: 201, summary: 'Create a batch', description: 'Optional `{ source }`, e.g. "Vault 3 · T-series vol. 2008". Ids are given out in order: WDH-B001, WDH-B002, …' },
        'POST /batches/{batchId}/documents': {
            tag: 'Capture', status: 201, summary: 'Upload one scan into a batch',
            upload: { file: 'PDF, PNG or JPEG; one file = one instrument' },
            description: 'multipart/form-data with one `file`. Stores it and queues it for extraction; returns the document summary (status `queued`). ' +
                '409 when the same file was captured before; 413 when it is larger than INTAKE_MAX_FILE_MB.'
        },

        'GET /documents': {
            tag: 'Documents', summary: 'List captured documents',
            description: '`{ items, total }` of summaries. Filter by `batchId`, `status` (comma-separated, e.g. `ready,failed`) and `q` (file name, document type, EDRMS number, field values).'
        },
        'GET /documents/{id}': {
            tag: 'Documents', summary: 'One document with its fields for review',
            description: 'Summary plus `fields` (value, evidence quote and page, checks, flag ok/check/conflict/missing, status pending/accepted/edited, second-model reading `alt`), `notes`, `transcription` and the model calls.'
        },
        'GET /documents/{id}/events': { tag: 'Documents', summary: 'History of a document', description: 'Captured, extracted, every field accepted or edited, filed or rejected; who and when.' },
        'GET /documents/{id}/file-link': {
            tag: 'Documents', summary: 'Short-lived link to the scan',
            description: '`{ url, expiresIn }` (300 s). For `<iframe>`/`<img>`, which cannot send the Authorization header.'
        },
        'GET /files/{id}': { tag: 'Documents', auth: 'signed-link', summary: 'The scan behind a signed link', description: 'Use the `url` from GET /documents/{id}/file-link; 404 when expired or tampered with.' },
        'POST /documents/{id}/extract': {
            tag: 'Documents', summary: 'Read the document again',
            description: 'Retry after a failure, or `{ escalate: true }` for the stronger model. The new reading replaces the current fields, including reviewed ones. 409 when already queued, filed or rejected.'
        },

        'POST /documents/{id}/claim': { tag: 'Review', summary: 'Claim the document for review', description: '409 when someone else is reviewing it (the message names them).' },
        'POST /documents/{id}/release': { tag: 'Review', summary: 'Release your claim' },
        'PUT /documents/{id}/fields/{k}': {
            tag: 'Review', summary: 'Accept, reset or correct one field',
            description: '`{ status: "accepted" | "pending" }`, or `{ value }` to correct it (normalised and checked again). A field the AI did not find can be added this way. Returns the whole document.'
        },
        'POST /documents/{id}/accept-clean': { tag: 'Review', summary: 'Accept every pending field that passed all checks', description: 'Returns the whole document.' },
        'POST /documents/{id}/file': {
            tag: 'Review', summary: 'File the verified values into the EDRMS',
            description: 'Needs every field reviewed, no failed checks and the required fields present; otherwise 409 with `details.blockers`. Returns the summary with `edrmsNo`.'
        },
        'POST /documents/{id}/reject': { tag: 'Review', summary: 'Reject: kept, but never filed', description: 'Body `{ reason }` (required), e.g. "Not a land-registry instrument".' }
    }
};
