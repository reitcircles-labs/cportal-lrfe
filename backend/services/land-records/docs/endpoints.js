// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

export default {
    title: 'land-records',
    description: 'Land records: filed EDRMS documents aggregated per parcel, versioned, reviewed by a second person before each version is committed, and sealed. Design: services/land-records/README.md.',
    tags: {
        Records: 'Land records, their versions and seal chain.',
        Documents: 'Filed EDRMS documents, found for land records.',
        Service: 'Health and metadata.'
    },
    routes: {
        'GET /health': { tag: 'Service', summary: 'Health check', auth: 'public' },
        'GET /records/catalogue': { tag: 'Service', summary: 'Parcel kinds and their JSON Schemas', description: '`{ parcelKinds: [{ id, label, schemaVersion, schema, draftSchema }] }`. A draft is validated against `draftSchema` (types only), a version submitted for review against `schema`.' },
        'GET /records': {
            tag: 'Records', summary: 'List and search land records',
            description: '`{ items, total }`. `q` searches the record number, the parcel, owners\' names and ID numbers, and document references. `status`: `draft` (never committed), `committed`, `in_review` (a version waits for approval), `needs_review` (a linked document was corrected).'
        },
        'GET /records/document-search': {
            tag: 'Documents', summary: 'Search filed documents to add to a land record',
            description: '`{ items, total }`. The edrms search (words, word starts, spelling variants of names, `docType`, `field.<key>=<value>` filters), each document with `linkedTo` (other records that hold it) and, with `recordId`, `inThisRecord`.'
        },
        'GET /records/{id}/suggestions': {
            tag: 'Documents', summary: 'Documents that match this parcel, with the reasons',
            description: '`{ parcel, items }`. Each item: the document, `reasons` (property is this parcel; SG diagram cited by, prior title of, or citing a document already in the record), `inThisRecord`, `linkedTo`.'
        },
        'POST /records': {
            tag: 'Records', summary: 'Create a land record (draft v1)',
            description: '`{ parcel }`, or `{ edrmsDocumentId }` to read the parcel from a filed document\'s property field and link that document. One record per parcel: 409 with `recordId` when the parcel already has one.'
        },
        'PATCH /records/{id}/draft': {
            tag: 'Records', summary: 'Edit the draft: core fields, attributes, suggestions',
            description: '`{ revision, changes, accept, reason }`. `changes`: parcel (same kind), extent, tenure, owners, encumbrances, attributes (null removes). `accept`: take over the documents\' suggested owners, extent or encumbrances. Owners or an extent that differ from the suggestions are marked as entered by hand and need a `reason`. Suggestions (`derived`) and checks are recomputed. 409 when `revision` is not the draft\'s current revision.'
        },
        'POST /records/{id}/draft/documents': { tag: 'Records', summary: 'Link a filed document to the draft', description: '`{ revision, edrmsDocumentId }`. The document is pinned at its current EDRMS version, with its seal and a snapshot of its verified fields.' },
        'DELETE /records/{id}/draft/documents/{edrmsDocumentId}': { tag: 'Records', summary: 'Remove a document from the draft', description: '`?revision=` the draft\'s current revision.' },
        'GET /records/{id}/comments': { tag: 'Records', summary: 'Comments on a record' },
        'POST /records/{id}/comments': { tag: 'Records', summary: 'Comment on a record', description: '`{ body }`. Kept with the version open at the time.' },
        'GET /records/{id}': { tag: 'Records', summary: 'One land record with its current version and open draft' },
        'GET /records/{id}/versions': { tag: 'Records', summary: 'All versions of a record: state, who submitted and approved, seal, changes' },
        'GET /records/{id}/versions/{n}': { tag: 'Records', summary: 'One version, with its data (core, attributes, pinned documents)' },
        'GET /records/{id}/verify': { tag: 'Records', summary: 'Recompute the seal chain of the committed versions', description: '`{ intact, versions: [{ versionNumber, seal, intact, linked }] }`. `intact`: the seal matches the version; `linked`: it includes the previous version\'s seal.' }
    }
};
