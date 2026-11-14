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
title of an issued B/L and its holder (L3, the holder ledger) are kept here too, with its signed
chain of title (CB-32), each entry on the audit trail and the blockchain (CB-33), and the title
commands are calls of this service (CB-34).

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
  holder of a negotiable B/L, required) and the consignee from `partyOrganisations`. The record's
  row is read again, locked, in the transaction that writes the title: a commit or a submission
  waits for the issue, and one that landed since the version was read makes the issue fail (409)
  rather than bind an older version.
- **Registered organisations (CB-34).** Possession moves only between organisations registered
  and active on the platform: the shipper on issue and `to` on endorse and transfer are checked
  with identity (`GET /organisations/:id/standing`, `IDENTITY_URL`) before anything is written;
  422 (`details.code` `unregistered-organisation`) when one is not, 503 while identity cannot
  answer. Known limit: the consignee of a straight B/L or sea waybill is not checked.
  `TitleService` cannot be built without its identity client.
- **Every command** writes the new title only if its revision is still the one read, in one
  transaction: of two commands at the same moment, exactly one wins, and the other gets 409 "This
  B/L changed meanwhile: read it again" (`details.code` `changed-meanwhile`).
- **A refusal** changes nothing and gives the engine's reason, its code in `details.code`: 403 when
  the organisation may not run the command (`not-carrier`, `not-holder`, `no-organisation`), 400 for
  a wrong command or argument, 409 for the rest (the module is off, the kind, the state).
- **Who sees a title:** before issue the record's owner; after it the carrier, the current holder,
  past holders (any organisation the chain of title moved the B/L from or to) and the consignee.
  Anyone else gets 404 "B/L not found", as for the record, for reads and commands alike and before
  any refusal that would tell the B/L's state.

`TitleService.read(recordId, actor)` answers the title (null before issue) with the commands the
caller may run now.

- **Amendment and split (CB-35).** The holder surrenders the B/L for amendment
  (`surrender-for-amendment`); the carrier then amends it or splits it. **amend** takes the new
  document `{format, document, partyOrganisations?}` (without `partyOrganisations` the current
  version's links are kept), converted and checked like any document: the same carrier code and
  reference (400 `different-reference`), still to order (400 `kind-changed`), valid (400 with its
  problems). It is committed by the engine as the next version (sealed after the version before,
  its `records.record.committed` event published, no approver: the surrender for amendment is the
  authority), in the same transaction as the title and the `amend` entry, which names the new
  version's hash; the title's `issuedVersion` and `documentHash` become the new version's. While a
  version is being drafted or in review the amendment is refused (409 `draft-open`): finish or
  discard the draft first. **split** takes `{children: [{format, document, partyOrganisations?},
  ...]}` (at least two): each child a B/L to order of the same carrier code (400
  `different-reference`, `kind-changed`), with its own reference (the parent's or another
  child's: 400 `child-reference`; one the carrier already has: 409), their cargo adding up to the
  parent's (400 `cargo-mismatch`, `details.problems`; ports may differ), and, as for an
  amendment, no version of the parent being drafted or in review (409 `draft-open`). Every child
  and its reference is checked before anything is written. In one transaction, all or nothing: the parent's title closes (`split`) with its entry; each child becomes a record of
  the carrier with version 1 committed by the engine and its event, a first title held by the
  organisation the parent was to go back to, and its first entry `issue-from-split` following the
  parent's `split` entry. The answer adds `children: [{recordId, recordNo}]`, in the order given.
- **Release** is of the whole B/L: a release body naming part of its cargo is refused (400
  `partial-release`).
- **Known limit of the memory store** (`RECORDS_STORE=memory`, development and tests only): it
  has no transactions. A split checks every child and its reference before writing, and the
  parent's title is written first and only at the revision read, so a refusal or a lost race
  changes nothing; but a child reference taken by another request in the moment between that
  check and the write would leave the parent split with some children missing. PostgreSQL runs
  the split in one transaction, all or nothing.

### The title API (CB-34)

`POST /records/:id/title/:command` runs `issue`, `void`, `endorse`, `transfer`, `surrender`,
`release`, `deliver`, `surrender-for-amendment`, `amend`, `split` or `switch-to-paper` as the
session's organisation, never one named in the request; the body `{to?, inBlank?,
confirmBearer?}`, an amendment's `{format, document, partyOrganisations?}` or a split's
`{children}` gives the arguments, anything else in it is ignored (a release naming part of the
cargo is refused). `GET /records/:id/title` reads it. Both answer `{recordId, title, allowedCommands,
chain}`, `chain` being the chain-of-title entries (`[]` before issue). The command's name is
looked up in a Map (`OFFERED_COMMANDS` in `src/title.service.js`): an unknown one is 400
`unknown-command`. Permissions (shipping pack): `bl.issue` for `issue`, `void`, `release`,
`deliver`, `amend` and `split` (the carrier's staff), `bl.endorse` for `endorse`, `transfer`,
`surrender`, `surrender-for-amendment` and `switch-to-paper` (the holder's); the demo role `bld`
has both. The title proof of a B/L made by a split carries `parent`, the chain of the B/L it was
split from ([chain of title](../../domains/shipping/docs/chain-of-title.md)).

### The chain of title (CB-32)

Every applied command adds one entry to the B/L's **chain of title** (table `bl_title_entry`, one
row per `recordId` and `seq`, the pair its primary key): who ran it, the holder before and after,
the endorsement, the document hash and the time, the hash of the entry before (`previousHash`), its
own hash (`entryHash`) and the platform's signature (a compact JWS, ES256, with the key's `kid`).
The entry is signed before anything is written, and stored in the same transaction as the title:
a command whose signature cannot be made, or whose entry cannot be stored, changes nothing. The
entry fields, the hash, the signature and how they map to DCSA PINT's transfer chain:
[chain of title](../../domains/shipping/docs/chain-of-title.md).

An endorsement adds no version: the stored document and its hash stay as issued. The endorsee
is read from the chain (`endorseeOf`) and added only when a B/L is written out in DCSA (CB-37,
[chain of title](../../domains/shipping/docs/chain-of-title.md), "The endorsee written out"); no
route writes a B/L out yet.

`verifyTitleChain(entries, jwks)` (`src/chain.js`) checks a chain offline, entry by entry
(linked, intact, signed), with the platform's public keys from `GET /records/title/keys`. Without
a signer (production without `TITLE_SIGNER`), title commands are refused with 503.

### The title proof (CB-33)

Each entry is published as the event `records.title.<command>` (below), in the same transaction
as the title and the entry, so the audit service puts it on the B/L's trail (`record:<id>`) and
anchors it on the blockchain with the trail's checkpoints. The event's id is made from the B/L and
the entry's `seq` (`titleEventIdOf` in `src/title.service.js`), so the service finds the entry on
the trail again without storing anything more.

`GET /records/:id/title/proof` gives a B/L's **title proof** (`lrfe-title-proof/1`): its chain of
title, the platform's public keys, and the audit service's trail-entry proof of the last entry
(or of entry `?seq=`) once anchored, `{pending: true}` before; `latest` says whether that entry is
the B/L's last. Anyone holding it checks it offline with the audit service's verifier
(`lrfe-verify.mjs title-proof.json --address … --title-key …`). The bundle and the checks:
[chain of title](../../domains/shipping/docs/chain-of-title.md#the-title-proof-cb-33). The proof
is asked of the audit service (`POST /audit/anchoring/entry-proof`, `AUDIT_URL`); while it cannot
be reached the route answers 503, never "pending".

### The platform's keys in production (CB-36)

- **The fingerprint.** Whoever checks a title proof offline pins the platform's key set with
  `--title-key <fingerprint>`: SHA-256 hex of the canonical JSON of `GET /records/title/keys`
  (`titleKeyFingerprint` of the verifier). Publish it with the install, beside the anchoring
  wallet's address; the command that prints it is in `deploy/README.md`, part D, step 7. The key
  set holds every key version, so the fingerprint **changes at each key rotation**: publish the new
  one, dated, and keep the earlier ones, since a bundle is checked against the fingerprint of its
  period.
- **Several replicas.** Each replica keeps the key set it read from OpenBao for 5 minutes
  (`KEY_SET_TTL_MS` in `@lrfe/common`'s `jws.js`). After a key rotation, a replica shows the new version on
  `/records/title/keys` within 5 minutes, at once when it signs an entry (signing reads the key
  again and signs with its latest version). Every version keeps verifying.
- **Deploy order.** The title proof asks audit for the entry's proof (`POST
  /audit/anchoring/entry-proof`). An audit service older than CB-33 answers 404, read as "pending":
  deploy audit before shipping-records, so proofs are not shown pending only because of the order.

## Settings

| Setting | Default | What |
|---|---|---|
| `PORT` | `3509` | the HTTP port |
| `RECORDS_STORE` | `postgres` | `memory` (development only: lost on restart) or `postgres` |
| `DB_CONNECTION_STRING` | | the PostgreSQL database (with `RECORDS_STORE=postgres`); `DB_POOL_SIZE` (5) its connections |
| `DB_SYNC` | `false` | `true`: create the schema and tables at start (development); otherwise `npm run db:setup` in `backend/` creates them |
| `JWT_SECRET` | | the secret shared by every service, to check users' and services' tokens |
| `AUDIT_URL` | `http://localhost:3506` | the audit service, which gives the proof of a chain-of-title entry on the blockchain (the title proof) |
| `IDENTITY_URL` | `http://localhost:3501`; required in production (the start stops without it) | identity, which says whether an organisation a B/L goes to is registered and active (CB-34) |
| `EVENT_BUS_DRIVER` | `log` | `log`, `memory` or `nats` (`NATS_URL`); with PostgreSQL, events go through the outbox in the same transaction as the change |
| `LRFE_BL_FORMATS` | `dcsa-3.0` | the B/L formats that are on, comma-separated; an unknown name stops the start ([formats](../../domains/shipping/docs/formats.md)) |
| `LRFE_BL_MODULES` | all | the title modules that are on, comma-separated (`waybill`, always on, `negotiable`, `blank-endorsement`, `amendment`, `split`); an unknown name or a module without the one it needs stops the start ([title modules](../../domains/shipping/docs/title-states.md#modules-cb-38)) |
| `TITLE_SIGNER` | not set | the platform key that signs the chain of title: `bao`, the key in OpenBao's transit engine (below); not set, an in-process key made at start outside production (development, tests, e2e: its entries do not verify after a restart) and **none in production**, where title commands are then refused (503); any other value stops the start |
| `TITLE_SIGNING_KEY` | | with `TITLE_SIGNER=bao`: the transit key's name, type `ecdsa-p256`; the `kid` of a signature is `<key>:v<version>`, and after a rotation the older versions keep verifying |
| `BAO_ADDR`, `BAO_ROLE_ID`, `BAO_SECRET_ID_FILE` | | with `TITLE_SIGNER=bao`: OpenBao's address and the service's AppRole (its role ID, and the file holding its secret ID); the AppRole needs `transit/sign/<key>` and read on `transit/keys/<key>`. In `deploy/` (CB-36): key `bl-title`, the AppRole prepared by `docker compose run --rm openbao-setup-shipping`, profile `shipping` only, then `TITLE_SIGNER=bao` in `.env` (not set by default: title commands refused, the rest works; `deploy/README.md`, part D, step 7) |
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
| `GET /records/:id/title` | `bl.read`, of the carrier, a current or past holder or the consignee (before issue: the owner) | the title, the commands the caller may run now and the chain of title; 404 "B/L not found" for anyone else |
| `POST /records/:id/title/:command` | `bl.issue` (issue, void, release, deliver, amend, split) or `bl.endorse` (endorse, transfer, surrender, surrender-for-amendment, switch-to-paper), of an organisation that sees the B/L | runs a title command (above); 404 for an organisation that does not see the B/L, before any other refusal; a refusal records nothing |
| `GET /records/:id/title/proof` | `bl.read`, of the carrier, a current or past holder or the consignee | the B/L's title proof (`lrfe-title-proof/1`), `?seq=` for an older entry; 404 "B/L not found" for anyone else and before issue, 503 while the proof on the blockchain cannot be read |
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
| `records.title.<command>` (`issue`, `endorse`, ...) | `{recordId, recordNo, seq, entry}`: the chain-of-title entry, signed (CB-33); nothing for a refused command or a lost race | the person who ran the command, with their organisation |

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
