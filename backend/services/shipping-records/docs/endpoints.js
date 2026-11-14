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
    'GET /records/{id}/title': {
      tag: 'Records',
      summary:
        "A B/L's title: its state, holder, the commands you may run now and its chain of title",
      description:
        '`{ recordId, title, allowedCommands, chain }`. `title`: `{ kind, state, carrier, holder, endorsement, consignee, returnTo, issuedVersion, documentHash, revision, createdAt, updatedAt }`, null before issue. `allowedCommands`: the commands your organisation may run on it now (before issue: `issue` for the carrier that owns a B/L with a committed version and none in review). `chain`: the chain-of-title entries, signed, oldest first; `[]` before issue. Before issue only the organisation that owns the B/L sees it; after it the carrier, the current holder, past holders and the consignee. 404 "B/L not found" for anyone else, as for a B/L that does not exist. 403 for a user of no organisation.',
    },
    'POST /records/{id}/title/{command}': {
      tag: 'Records',
      summary:
        'Run a title command on a B/L: issue, void, endorse, transfer, surrender, release, deliver, surrender-for-amendment, amend, split, switch-to-paper',
      description:
        "Body `{ to?, inBlank?, confirmBearer?, format?, document?, partyOrganisations?, children? }` (anything else is ignored): `to` the organisation that receives the B/L (endorse, transfer), `inBlank` whether an endorsement is in blank, `confirmBearer` the confirmation to switch a blank-endorsed B/L to paper; for `amend` the new document `{ format, document, partyOrganisations? }` (same carrier code and reference, still to order; committed by the engine as the next version; 400 `different-reference`, `kind-changed` or its problems; 409 `draft-open` while a version is being drafted or in review); for `split` `children: [{ format, document, partyOrganisations? }]` (at least two, each a B/L to order of the same carrier code with its own reference; their cargo adds up to the B/L's: 400 `cargo-mismatch`, `child-reference`; 409 for a reference the carrier already has, 409 `draft-open` while a version of the B/L is being drafted or in review), answered with `children: [{ recordId, recordNo }]` too. A `release` naming part of the cargo is refused (400 `partial-release`). The command runs as your session's organisation. `issue`, `void`, `release`, `deliver`, `amend` and `split` need `bl.issue` (the carrier's staff); `endorse`, `transfer`, `surrender`, `surrender-for-amendment` and `switch-to-paper` need `bl.endorse` (the holder's). Issue binds the B/L's current committed version; the kind, the shipper (first holder) and the consignee come from it. The shipper on issue and `to` on endorse and transfer must be organisations registered and active on the platform (422 `unregistered-organisation`; 503 while that cannot be checked). Answers the title as `GET /records/{id}/title` does. Refusals, with the reason and `details.code` (the rules: backend/domains/shipping/docs/title-states.md): 404 \"B/L not found\" for an organisation that does not see the B/L, before any other refusal; 400 for an unknown command (`unknown-command`) or a wrong argument; 403 when your organisation may not run it (`not-carrier`, `not-holder`) or for a user of no organisation; 409 for the kind, the state, a module that is off, a B/L without a committed version or with one in review, or a B/L changed meanwhile (`changed-meanwhile`, read it again); 503 while the platform signature is not set up. A refused command changes nothing and puts nothing on the trail.",
    },
    'GET /records/{id}/title/proof': {
      tag: 'Records',
      summary:
        "A B/L's title proof: its chain of title, signed, with the last entry's proof on the blockchain",
      description:
        "`seq` (optional, from 1): the proof of that entry instead of the last. `{ format: 'lrfe-title-proof/1', recordId, recordNo, entries, jwks, anchor, latest, latestSeq }`: the chain-of-title entries up to the one proven (never the document), the platform's public keys (as `GET /records/title/keys`), and `anchor`, the audit service's trail-entry proof of that entry's event (`lrfe-audit-proof/1`) once it is anchored, `{ pending: true }` before. `latest`: whether the entry is the B/L's last; `latestSeq`: the last. A B/L made by a split also carries `parent: { recordId, recordNo, entries }`, the chain of the B/L it was split from, which its first entry follows. Checked offline with the audit verifier (`lrfe-verify.mjs title-proof.json --title-key …`). For the carrier, the current and past holders and the consignee; 404 \"B/L not found\" for any other organisation and before issue, 404 for a `seq` beyond the chain, 503 while the proof on the blockchain cannot be read.",
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
