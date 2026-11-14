# The chain of title (CB-32)

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
`ecdsa-p256` transit key, `kid` = `<key name>:v<version>`); in development and tests an in-process
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
