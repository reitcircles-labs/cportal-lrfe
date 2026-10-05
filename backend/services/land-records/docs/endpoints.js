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
        'GET /records/{id}': { tag: 'Records', summary: 'One land record with its current version and open draft' },
        'GET /records/{id}/versions': { tag: 'Records', summary: 'All versions of a record: state, who submitted and approved, seal, changes' },
        'GET /records/{id}/versions/{n}': { tag: 'Records', summary: 'One version, with its data (core, attributes, pinned documents)' },
        'GET /records/{id}/verify': { tag: 'Records', summary: 'Recompute the seal chain of the committed versions', description: '`{ intact, versions: [{ versionNumber, seal, intact, linked }] }`. `intact`: the seal matches the version; `linked`: it includes the previous version\'s seal.' }
    }
};
