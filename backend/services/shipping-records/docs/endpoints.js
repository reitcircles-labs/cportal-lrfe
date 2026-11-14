// What the generated openapi.yaml says about each route; paths, parameters, request bodies and
// access rules come from the routes themselves. Regenerate with `npm run docs` in backend/.

/** The API description of shipping-records, by route. */
export const ENDPOINTS = {
  title: 'shipping-records',
  description:
    'Shipping records: draft bills of lading (B/Ls) of an organisation, versioned, reviewed by a second person before each version is committed, and sealed. Answers the record contract for the shared services. A user sees only the B/Ls of their own organisation. Design: services/shipping-records/README.md.',
  tags: {
    Records: 'Bills of lading, their versions and seal chain.',
    Service: 'Health and metadata.',
  },
  routes: {
    'GET /health': {tag: 'Service', summary: 'Health check', auth: 'public'},
    'POST /records': {
      tag: 'Records',
      summary: 'Create a draft B/L (version 1) for your organisation',
      description:
        '`{ format, document, partyOrganisations? }`. `format` names a B/L format that is on in this install (`LRFE_BL_FORMATS`, `dcsa-3.0` by default); `document` is the B/L in that format, converted to the internal model (its status is left out). `partyOrganisations` links parties of the document to organisations (`shipper`, `notifyParties.0`). 400 with `details.problems` (every problem, `{ path, message }`) when the B/L is not valid, or for a format that is unknown or not on. 409 when your organisation already has a B/L with the same carrier code and transport document reference (another organisation may draft the same reference; neither sees the other one). 403 for a user of no organisation. Answers the record as `GET /records/{id}` does.',
    },
    'PUT /records/{id}/draft': {
      tag: 'Records',
      summary: "Replace the open draft's B/L, or open a new draft version",
      description:
        '`{ format, document, partyOrganisations? }`, as for creating. Replaces the data of the open draft; when the B/L has none (its last version was committed), opens the next version as a draft. The carrier code and the transport document reference never change (400). 409 while the draft is in review, or when it was changed or submitted meanwhile (reload and try again).',
    },
    'POST /records/{id}/versions/{n}/submit': {
      tag: 'Records',
      summary: 'Submit the open draft for review',
      description:
        'The draft is frozen in review, with you as its submitter, until a second person commits it or sends it back. 409 when version `n` is not the open draft, or when it was changed meanwhile.',
    },
    'POST /records/{id}/versions/{n}/commit': {
      tag: 'Records',
      summary: 'Commit an approved version (bpm only)',
      description:
        '`{ by, comment }`. Seals the version, chains it to the previous committed version and makes it current. `by` must not be the submitter (403). 409 when the version is not in review. Repeating it by the same person is harmless.',
    },
    'POST /records/{id}/versions/{n}/reject': {
      tag: 'Records',
      summary: 'Send a version in review back as a draft (bpm only)',
      description:
        '`{ by, comment }`; the comment is required (400). The version becomes a draft again with the comment.',
    },
    'GET /records': {
      tag: 'Records',
      summary: "List your organisation's B/Ls",
      description:
        "`{ items, total }`, newest first. Each item: `id`, `recordNo` (the transport document reference), `carrierCode`, `label`, `organisationId`, `status` (`draft`: never committed; `committed`), `currentVersion`, `draftVersion`, `draftState` (`draft` or `in_review`). `status` filters by `draft`, `committed` or `in_review` (a draft waits for review); `q` searches the reference and the label. The audit service sees every organisation's B/Ls.",
    },
    'POST /records/lookup': {
      tag: 'Records',
      summary: 'B/L labels and committed versions (audit service only)',
      description:
        'Body `{ recordIds?, versions?: [{ recordId, versionNumber }], pinning? }`. `{ records: [{ id, recordNo, label }], versions: [{ recordId, versionNumber, documents: [] }], pinnedBy: [] }`: the committed versions asked for; a B/L version pins no documents, so `documents` and `pinnedBy` are empty.',
    },
    'GET /records/title/keys': {
      tag: 'Records',
      summary: 'The public keys of the chain of title (no sign-in)',
      description:
        "`{ keys: [{ kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' }] }`: a JWK set of every version of the platform's signing key, to check the signature of each chain-of-title entry (its `kid` picks the key), also offline. 503 while the platform signature is not set up.",
      auth: 'public',
    },
    'GET /records/seals': {
      tag: 'Records',
      summary:
        "Every committed version's seal, oldest first (audit service only)",
      description:
        '`{ items: [{ recordId, version, seal, at }], next }`: pass `next` as `after` for the next page; null at the end.',
    },
    'GET /records/{id}': {
      tag: 'Records',
      summary: 'One B/L with its current version and open draft',
      description:
        'The B/L as the list has it, with `current` and `draft` (each a version with its data, or null) and `draftDiff` (always null). 404 for a B/L of another organisation.',
    },
    'GET /records/{id}/versions': {
      tag: 'Records',
      summary:
        'All versions of a B/L: state, hash, who submitted and approved, seal, changes',
    },
    'GET /records/{id}/versions/{n}': {
      tag: 'Records',
      summary: 'One version, with its data (the B/L)',
      description:
        '`data` is the B/L `{ schemaVersion, document, partyOrganisations? }`; `documentHash` its canonical SHA-256; `seal` and `previousSeal` once committed.',
    },
    'GET /records/{id}/verify': {
      tag: 'Records',
      summary:
        'Recompute the seal chain of the committed versions (audit service only)',
      description:
        "`{ recordId, recordNo, intact, versions: [{ versionNumber, seal, intact, linked }], checkedAt }`. `intact`: the seal matches the version; `linked`: it includes the previous version's seal.",
    },
  },
};
