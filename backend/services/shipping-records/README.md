# shipping-records service

The record service of the shipping product (CB-27): **draft bills of lading (B/Ls)** of an
organisation, versioned, submitted for review, committed by a second person and **sealed**. It
answers the record contract (CB-4, [`@lrfe/record-contract`](../../packages/record-contract/README.md))
for the shared services (audit, extracts, bpm), like `land-records` does for land.

The service runs on port 3509, with its own PostgreSQL schema `shipping_records`. The shipping
pack names it as its record service (`recordKind`, CB-28), so with `LRFE_DOMAIN=shipping` the
gateway routes `/api/records` to it (`SHIPPING_RECORDS_URL`), and audit, bpm and extracts call it
there. In the compose file it runs with the profile `shipping`; the shipping e2e run
(`npm run test:shipping` in `e2e/`) takes a B/L through it, the gateway and the audit service. The
title of an issued B/L and its holder (L3, the holder ledger) are kept here too; their routes, the
chain of title and its events are still to come (CB-32 to CB-34).

## A B/L record

| Term | Meaning |
|---|---|
| **Record** | One per organisation, carrier code and transport document reference (a second one in the same organisation is a 409). `recordNo` is the document's `transportDocumentReference`; `label` is `B/L <reference> (<carrierCode>)` |
| **Owner** | `organisationId`: the organisation of the user who created it. A user sees and changes only their organisation's B/Ls; another organisation's B/L answers 404, as an unknown one does |
| **Version** | One complete state of the B/L. `data` is the B/L of the internal model (`@lrfe/domain-shipping/bill-of-lading`): `{schemaVersion, document, partyOrganisations?}`, the document being DCSA's transport document without its status. `documentHash` is `billOfLadingHash(data)` |
| **States** | A version is `draft`, `in_review` or `committed`. The record is `draft` until its first commit, then `committed`; `draftVersion` and `draftState` (`draft` or `in_review`) describe its open draft |

A B/L arrives in any format that is on (`LRFE_BL_FORMATS`) and is converted to the internal model;
an invalid B/L is refused with every problem (`details.problems`). The carrier code and the
reference name the record, so a draft never changes them.

A reference is unique per organisation, not on the platform: drafts are private, so another
organisation may draft a B/L with the same carrier code and reference, and neither sees the other's
(refusing it would reveal the first). One issued B/L per carrier reference on the platform is a rule
of issuing (L3/L4), not of drafts.

Each change of a version adds one to its `revision`. A change or a submission made on a draft that
someone else changed or submitted since it was read is refused (409, reload and try again): the last
writer never silently wins, and a submitted version is always the one its event names.

## The title (the holder ledger)

An issued B/L has one **title** (table `bl_title`, CB-31): its kind (`negotiable`, `straight` or
`waybill`), state, carrier, holder, endorsement, consignee, the organisation it goes back to after
an amendment (`returnTo`), the committed version issued with its `documentHash`, and a `revision`.
The record's id is the table's primary key, so the database itself refuses a second title of the
same B/L.

The title changes only through the state machine of `@lrfe/domain-shipping/title`
([title states](../../domains/shipping/docs/title-states.md)), run by `TitleService.apply(recordId,
command, actor)` with the modules on in the install:

- **issue** needs a committed version and no new version in review; it is run by the B/L's owner
  organisation, which becomes the carrier. The kind comes from the document, the shipper (first
  holder of a negotiable B/L, required) and the consignee from `partyOrganisations`.
- **Every command** writes the new title only if its revision is still the one read, in one
  transaction: of two commands at the same moment, exactly one wins, and the other gets 409 "This
  B/L changed meanwhile: read it again" (`details.code` `changed-meanwhile`).
- **A refusal** changes nothing and gives the engine's reason, its code in `details.code`: 403 when
  the organisation may not run the command (`not-carrier`, `not-holder`, `no-organisation`), 400 for
  a wrong command or argument, 409 for the rest (the module is off, the kind, the state).
- **Who sees a title:** before issue the record's owner; after it the carrier, the current holder
  and the consignee (past holders come with CB-34). Anyone else gets 404 "B/L not
  found", as for the record.

`TitleService.read(recordId, actor)` answers the title (null before issue) with the commands the
caller may run now. Split waits for CB-35, which creates the new B/Ls.

### The chain of title (CB-32)

Every applied command adds one entry to the B/L's **chain of title** (table `bl_title_entry`, one
row per `recordId` and `seq`, the pair its primary key): who ran it, the holder before and after,
the endorsement, the document hash and the time, the hash of the entry before (`previousHash`), its
own hash (`entryHash`) and the platform's signature (a compact JWS, ES256, with the key's `kid`).
The entry is signed before anything is written, and stored in the same transaction as the title:
a command whose signature cannot be made, or whose entry cannot be stored, changes nothing. The
entry fields, the hash, the signature and how they map to DCSA PINT's transfer chain:
[chain of title](../../domains/shipping/docs/chain-of-title.md).

`verifyTitleChain(entries, jwks)` (`src/chain.js`) checks a chain offline, entry by entry
(linked, intact, signed), with the platform's public keys from `GET /records/title/keys`. Without
a signer (production without `TITLE_SIGNER`), title commands are refused with 503.

## Settings

| Setting | Default | What |
|---|---|---|
| `PORT` | `3509` | the HTTP port |
| `RECORDS_STORE` | `postgres` | `memory` (development only: lost on restart) or `postgres` |
| `DB_CONNECTION_STRING` | | the PostgreSQL database (with `RECORDS_STORE=postgres`); `DB_POOL_SIZE` (5) its connections |
| `DB_SYNC` | `false` | `true`: create the schema and tables at start (development); otherwise `npm run db:setup` in `backend/` creates them |
| `JWT_SECRET` | | the secret shared by every service, to check users' and services' tokens |
| `EVENT_BUS_DRIVER` | `log` | `log`, `memory` or `nats` (`NATS_URL`); with PostgreSQL, events go through the outbox in the same transaction as the change |
| `LRFE_BL_FORMATS` | `dcsa-3.0` | the B/L formats that are on, comma-separated; an unknown name stops the start ([formats](../../domains/shipping/docs/formats.md)) |
| `LRFE_BL_MODULES` | all | the title modules that are on, comma-separated (`waybill`, always on, `negotiable`, `blank-endorsement`, `amendment`, `split`); an unknown name or a module without the one it needs stops the start ([title modules](../../domains/shipping/docs/title-states.md#modules-cb-38)) |
| `TITLE_SIGNER` | not set | the platform key that signs the chain of title: `bao`, the key in OpenBao's transit engine (below); not set, an in-process key made at start outside production (development, tests, e2e: its entries do not verify after a restart) and **none in production**, where title commands are then refused (503); any other value stops the start |
| `TITLE_SIGNING_KEY` | | with `TITLE_SIGNER=bao`: the transit key's name, type `ecdsa-p256`; the `kid` of a signature is `<key>:v<version>`, and after a rotation the older versions keep verifying |
| `BAO_ADDR`, `BAO_ROLE_ID`, `BAO_SECRET_ID_FILE` | | with `TITLE_SIGNER=bao`: OpenBao's address and the service's AppRole (its role ID, and the file holding its secret ID); the AppRole needs `transit/sign/<key>` and read on `transit/keys/<key>`. Wiring OpenBao for shipping-records in `deploy/` is CB-36 |
| `LOG_LEVEL` | `info` | the log level |

Run it alone with `npm run dev:shipping-records` in `backend/`, or with the others:
`npm run dev -- shipping-records nats` (it is never started by default).

## Routes

Users need a token with an organisation; a user of no organisation gets 403.

| Route | Who | What |
|---|---|---|
| `POST /records` | `bl.draft` | create a B/L: `{format, document, partyOrganisations?}`; 201 with the record |
| `PUT /records/:id/draft` | `bl.draft` | replace the open draft's B/L, or open the next version as a draft after a commit; 409 while in review |
| `POST /records/:id/versions/:n/submit` | `bl.draft` | the draft goes in review, with the caller as submitter |
| `GET /records`, `GET /records/:id`, `GET /records/:id/versions`, `GET /records/:id/versions/:n` | `bl.read` (own organisation); the audit service (all), extracts (a record, a version) | the record contract's reading calls |
| `POST /records/lookup`, `GET /records/seals`, `GET /records/:id/verify` | the audit service | labels and committed versions (a B/L pins no documents: `documents` and `pinnedBy` are empty), the seals in pages, the seal chain recomputed |
| `GET /records/title/keys` | anyone, no token | the platform's public keys of the chain of title, every key version (a JWK set), for checking a chain offline; through the gateway `/api/records/title/keys` |
| `POST /records/:id/versions/:n/commit`, `.../reject` | bpm | the review decision, `{by: {id, name}, comment}`: commit refuses the submitter (403, four-eyes, always on) and answers a retry by the same person the same; reject needs a comment |

The generated API description is [`docs/openapi.yaml`](docs/openapi.yaml) (`npm run docs` in
`backend/`, from the routes and [`docs/endpoints.js`](docs/endpoints.js)).

## Events

Published with the source `shipping-records`, in the same transaction as the change:

| Type | Data | Actor |
|---|---|---|
| `records.record.created` | `{recordId, recordNo, versionNumber, documentHash}` | the user, with their organisation |
| `records.draft.changed` | the same | the user |
| `records.draft.submitted` | the same | the user |
| `records.draft.rejected` | the same | the person who decided (`by`) |
| `records.record.committed` | `{recordId, recordNo, versionNumber, seal, previousSeal, submittedBy, approvedBy, documentHash}` (land-records' keys and the hash) | the person who decided |

An event never carries the document itself, only its hash.

## The seal

A committed version is sealed with the formula every record service shares,
`sealOf(record, version)` of `@lrfe/record-contract/seal`: SHA-256 over the canonical JSON of the
record id and number, the version number, its data (the whole B/L), who submitted and approved it,
when it was committed, and the previous committed version's seal. Each seal therefore depends on
every version before it. `GET /records/:id/verify` recomputes the chain; the offline verifier
(`services/audit/verifier/lrfe-verify.mjs`) repeats the same formula.

## Tests

```
npm test                                                      # in memory
SHIPPING_RECORDS_TEST_DB=postgres://user@host:port/db npm test  # in memory and on PostgreSQL
```

With `SHIPPING_RECORDS_TEST_DB`, every test also runs on that database: its schema
`shipping_records` is created if missing and emptied before each test, so use a throwaway database.
