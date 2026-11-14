# The chain of title (CB-32, CB-33)

Every command applied to a B/L's title (issue, endorse, transfer, surrender, release, ...: see
[title states](title-states.md)) adds one **entry** to that B/L's chain of title. The entries are
never changed: each holds the hash of the one before and the platform's signature, so a changed,
removed or reordered entry shows. The shipping record service keeps them (table
`bl_title_entry`, `services/shipping-records/README.md`, "The chain of title"), written in the same
transaction as the title they describe.

## An entry

| Field | What |
|---|---|
| `recordId` | the B/L (its record id) |
| `seq` | 1, 2, ... per B/L: the entry's place in the chain |
| `command` | the command applied: `issue`, `endorse`, `transfer`, `surrender`, `release`, ... |
| `actor` | the person who ran it: `{id, name, org}` (org: their organisation) |
| `from` | the holder before the command (organisation id), null before issue or for a B/L without holder |
| `to` | the holder after it, null when the B/L has none (straight, waybill, after release) |
| `endorsement` | the title's endorsement after the command: `none`, `named` or `blank` |
| `documentHash` | the `billOfLadingHash` of the issued version: the B/L the title is for |
| `at` | when, ISO 8601 in UTC; the same as the title's `updatedAt` |
| `previousHash` | the `entryHash` of the entry before; null for a B/L's first entry; for a split child's first entry, the parent's last `entryHash` (CB-35) |
| `kid` | the platform key that signed it |
| `entryHash` | the entry's hash (below) |
| `signature` | the platform's signature (below) |

## The hash

`entryHash` = SHA-256, lowercase hex, of the canonical JSON (`canonicalJson` of `@lrfe/common`:
keys sorted, no spaces) of the entry **without** `entryHash` and `signature`. So `previousHash`,
`seq` and `kid` are part of what is hashed: an entry cannot be moved, renumbered or relabelled
with another key without its hash changing.

## The signature

`signature` is a compact JWS (RFC 7515) over the same content as the hash:

- header `{"alg": "ES256", "kid": "<kid>", "typ": "lrfe-title-entry"}`;
- payload: the canonical JSON of the entry without `entryHash` and `signature`;
- signature: ECDSA P-256 with SHA-256, as r and s (64 bytes), base64url.

The key is the platform's: in production a key that never leaves the key store (an
`ecdsa-p256` transit key, `bl-title` in `deploy/`, `kid` = `<key name>:v<version>`); in development and tests an in-process
key. After a key rotation, new entries are signed with the new version and older entries keep
their `kid`; the public keys of every version are published at `GET /api/records/title/keys`
(a JWK set, no sign-in).

## Checking a chain

`verifyTitleChain(entries, jwks)` (`services/shipping-records/src/chain.js`) checks each entry,
with nothing but the entries and the key set (offline):

- **linked**: `seq` is its place (1..n) and `previousHash` is the `entryHash` of the entry before
  (for the first entry: null, or the parent's last `entryHash` for a split child);
- **intact**: `entryHash` is the hash of its content;
- **signed**: `signature` is a valid ES256 JWS of type `lrfe-title-entry`, made with the key of the
  entry's `kid`, over exactly its content.

A chain is valid when it has entries and every one is linked, intact and signed. Removing the
**last** entry leaves a valid shorter chain: it shows against the title (its `revision` is the
number of entries) and against the last entry anchored on the blockchain (CB-33).

## A B/L made by a split (CB-35)

A split adds the `split` entry to the parent's chain (from the carrier, to nobody) and gives each
child a chain of its own whose first entry is `issue-from-split`: seq 1, from nobody, to the
organisation the parent was to go back to, the child's document hash, and as `previousHash` the
`entryHash` of the parent's `split` entry. The child's chain is checked with
`verifyTitleChain(entries, jwks, {startPreviousHash})`, the parent's split entry's hash; the link
is also how the service finds a child's parent (by that entry's hash). Each first entry is
published as `records.title.issue-from-split`.

## The title proof (CB-33)

### On the audit trail and the blockchain

Each entry is published as the event `records.title.<command>` (e.g. `records.title.endorse`),
source `shipping-records`, in the same transaction as the title and the entry: nothing is
published for a refused command, a lost race or a failed transaction. Its data is
`{recordId, recordNo, seq, entry}`, the full signed entry and never the document. The audit
service records it on the B/L's trail (subject `record:<recordId>`); it adds no leaf of its own
to the audit tree but is anchored with the trail's checkpoints, like every trail entry. The
event's id is a uuid made from the B/L and the seq (SHA-256 of
`records.title.<recordId>:<seq>`, RFC 9562 version 8).

### The bundle

`GET /api/records/:id/title/proof` (the carrier, the current and past holders, the consignee) gives:

| Field | What |
|---|---|
| `format` | `lrfe-title-proof/1` |
| `recordId`, `recordNo` | the B/L |
| `entries` | the chain of title from entry 1 up to the entry proven: the last, or `?seq=` |
| `jwks` | the platform's public keys, as `GET /api/records/title/keys` |
| `anchor` | the audit service's trail-entry proof (`lrfe-audit-proof/1`) of the proven entry's event, once anchored; `{pending: true}` while it waits for the next anchoring |
| `parent` | only for a B/L made by a split (CB-35): `{recordId, recordNo, entries}`, the whole chain of the B/L it was split from, ending with its `split` entry (with its own `parent` when that B/L was itself made by a split) |
| `latest`, `latestSeq` | whether the proven entry is the B/L's last, and the last seq (online only: not checked offline) |

### Checking it offline

`node lrfe-verify.mjs title-proof.json --address <anchoring wallet> --title-key <fingerprint>`
(the audit service's verifier, `services/audit/verifier/`, `verifyTitleProof` in code) checks:

- **split from** (only with `parent`): the parent's chain is linked, intact, of the parent B/L and
  signed with the bundle's keys, and ends with the `split` entry whose `entryHash` is the first
  entry's `previousHash`, that first entry being an `issue-from-split`;
- **chain of title**: the entries are linked and intact, as `verifyTitleChain` checks them, all of
  the bundle's B/L (the first entry following null, or the parent's `split` entry);
- **signatures**: every entry is signed with a key of the bundle's `jwks`;
- **title key** (with `--title-key`): the `jwks` is the platform's: its fingerprint, SHA-256 hex of
  its canonical JSON, is the one the platform publishes (colons and case ignored). The key set
  grows with each key rotation, so its fingerprint changes too: check a bundle against the
  fingerprint published for its period. How an install publishes it: `deploy/README.md`, part D,
  step 7 (CB-36);
- **anchored entry**: the bundle's last entry is exactly the entry inside the anchor's trail entry
  (type `records.title.<command>`, the same B/L and seq);
- the anchor's **trail-entry proof** checks as any proof does: the trail to its checkpoint, the
  path to the root, the root in the transaction on the blockchain, paid by the anchoring wallet.

It names the title after the proven entry: the holder (the entry's `to`) and the state (from its
command, [title states](title-states.md)). A bundle made before the anchoring fails only
**anchored**: the chain and its signatures are checked, not yet vouched for by the blockchain.
Removing the last entries of a bundle does not pass: the last entry left is not the anchored one.

## The endorsee written out (CB-37)

An endorsement never changes the stored document: no new version, the same `documentHash` in every
entry (Jira CB-37 comment 11579). The endorsee is read from the chain instead and laid over the
document only when a B/L is written out:

- `endorseeOf(entries)` (`@lrfe/domain-shipping/title`): the `to` of the latest `endorse` entry
  when its `endorsement` is `named`; null after a blank endorsement or before any endorsement.
  Transfers, surrender and release after it do not change it.
- `fromModel(billOfLading, {status, endorsee})` of the DCSA 3.0 converter: `endorsee` absent, the
  document as stored; null, no `documentParties.endorsee` (one stored at drafting is left out:
  DCSA reads no endorsee on a B/L to order as blank endorsed); a DCSA Endorsee party (`partyName`
  and `identifyingCodes`), written as `documentParties.endorsee`. An endorsee on a B/L not to
  order, or on one that names a consignee, is an error. The stored B/L is never changed.

### Left for later

- **The organisation as a DCSA party:** no route writes a B/L out in DCSA yet, so the caller gives
  `fromModel` the endorsee party. The B/L output route, when it comes, will map the organisation
  `endorseeOf` names to a party from its registered name (and identifying codes).

## DCSA PINT

DCSA's Platform Interoperability API (PINT, `DCSA_EBL_PINT` 3.0.0-Beta-20261005) moves an eBL
between platforms in an **envelope** whose `envelopeTransferChain[]` holds signed
`EnvelopeTransferChainEntry` objects; each holds `transactions[]`, one per action on the eBL. Our
chain has one entry per command, each one PINT transaction. The mapping:

| Our entry | PINT | Notes |
|---|---|---|
| `command` | `Transaction.actionCode` | `issue` → `ISSUE`; `transfer` → `TRANSFER`; `endorse` → `ENDORSE` (named, the endorsee cannot endorse further) or `ENDORSE_TO_ORDER`; a blank endorsement → `BLANK_ENDORSE`; `surrender` → `SURRENDER_FOR_DELIVERY` or `SURRENDER_FOR_AMENDMENT`; the carrier's acceptance of a surrender (`release`, an amendment's return) → `SACC`, a refusal → `SREJ`. Commands PINT has no code for (e.g. `void`, a split) stay platform-internal |
| `actor` | `Transaction.actor` (`ActorParty`: `partyName`, `eblPlatform`, `identifyingCodes[]`) | PINT names the organisation, not the person: `partyName` from the organisation of `actor.org`, `eblPlatform` our platform code, `identifyingCodes` from the organisation's registration (CB-18) |
| `to` | `Transaction.recipient` (`RecipientParty`) | the organisation the action is to; absent for `BLANK_ENDORSE` |
| `from` | (none) | PINT reads the previous holder from the transaction before; we keep it in the entry for reading without the whole chain |
| `endorsement` | (implied by `actionCode`) | `named` / `blank` follow from `ENDORSE*` / `BLANK_ENDORSE` |
| `at` | `Transaction.actionDateTime` | both ISO 8601 UTC |
| `documentHash` | `EnvelopeTransferChainEntry.transportDocumentChecksum` | both SHA-256 hex of the canonical B/L; PINT canonicalises with RFC 8785 (JCS) and hashes the DCSA `TransportDocument`, ours the internal model (`billOfLadingHash`) |
| `previousHash` | `EnvelopeTransferChainEntry.previousEnvelopeTransferChainEntrySignedContentChecksum` | PINT hashes the previous entry's **signed** form (the whole JWS); ours hashes its content (the signature is checked separately) |
| `entryHash` | the checksum of `EnvelopeTransferChainEntrySignedContent` | see the line above |
| `signature` | `EnvelopeTransferChainEntrySignedContent` (compact JWS) | PINT's entry **is** a JWS whose payload is the entry; ours is the same with the entry stored alongside |
| `kid`, `GET /records/title/keys` | the JWS `kid` and the platform's published keys | PINT leaves key distribution to the platforms (onboarding); ours is a public JWK set of every key version |
| `seq`, `recordId` | the position in `envelopeTransferChain[]`, the envelope's `transportDocument` | |
| (none) | `Transaction.reasonCode`, `comments`, `auditReference`, `representedParty` | not recorded yet |

### Left for R3 (sending and receiving B/Ls between platforms)

- **Envelope transfer:** the PINT endpoints (start, add documents, finish), the `EblEnvelope`, the
  `EnvelopeManifest` and the receiver's validation (`BENV`, `BSIG`, `DISE` answers).
- **Grouping:** one `EnvelopeTransferChainEntry` per transfer between platforms, holding the
  transactions since the last transfer; our entries are per command.
- **PINT's hashing:** `transportDocumentChecksum` over the DCSA `TransportDocument` in RFC 8785
  form, and `previousEnvelopeTransferChainEntrySignedContentChecksum` over the signed JWS.
- **Parties:** `ActorParty` / `RecipientParty` from the organisations' registration (`partyName`,
  `eblPlatform`, `identifyingCodes`, `representedParty`).
- **Issuance:** the `issuanceManifestSignedContent` signed by the carrier in the first entry, and
  the `controlTrackingRegistry` (CTR) when a transfer is protected by one.
- **Keys between platforms:** exchanging and trusting the other platform's public keys.
