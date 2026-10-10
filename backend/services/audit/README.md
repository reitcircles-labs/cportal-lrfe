# audit service (design)

*Design for the audit epic (API-652), written in API-653 (10 October 2026). The service itself is
built in API-654 to API-661; this document is what they build.*

Auditors must be able to prove, **without trusting the portal**, that every land record version,
every filed document version and the audit trail itself are exactly as they were when recorded,
and to sign off records or raise findings on live data. The audit service:

1. keeps an **audit trail**: one entry per domain event, hash-chained, append-only;
2. keeps a **growing Merkle tree** (Merkle mountain range) over the seals of every land record
   version, every EDRMS document version and periodic checkpoints of the trail;
3. **anchors** the tree's root on **Cardano** once an hour (when something changed);
4. hands out **proofs** that anyone can check against the chain, also with an offline verifier;
5. records **sign-offs and findings**, and exports **evidence packs**.

Port 3506 (in the e2e stack: the next free offset after land-records), own schema `audit`,
`/api/audit` through the gateway.

## 1. The audit trail

**Source.** Every durable domain event (API-613), read with one durable consumer for all types:
`events.consume('>', handler, { durable: 'audit-trail' })` (the filter becomes `lrfe.>`). With the
memory and log drivers, used in tests, `consume` is a plain subscribe; API-654 makes `'>'` mean
every type there (`subscribe('*')`). Broadcast-only events
(`lrfe-live.>`: the session revocation, and the audit service's own anchoring events, §3) are not
in the stream and not in the trail. The consumer is the only writer; an event is acknowledged
after its entry is committed, so a crash re-delivers it, and the entry's unique `eventId` makes the
second delivery a no-op.

**Gaps.** The stream keeps events for `EVENT_STREAM_MAX_AGE_DAYS` (30). If the audit service were
down longer than that, the oldest missed events would be gone from the stream before it read them.
On start, and hourly, the service compares the stream's first sequence number with the last one its
consumer acknowledged; a gap is reported loudly (`audit.trail.gap`, log error) and recorded once as a
trail entry stating the missing range, so the loss is visible and cannot be passed off as complete.
That entry is written by the audit service itself (type `audit.trail.gap`, `eventId` derived from
the range, so it is never written twice), not consumed from the stream; the broadcast of the same
name only tells listeners.

**Before deployment.** The consumer starts with events published after it is created. A one-time
backfill (API-655) reads the seals of every land record version and EDRMS document version that
already exists (from land-records and edrms, with a service token) and adds them as leaves, oldest
first, before the first anchoring; the trail records the backfill as one entry with the counts.

**Entry** (table `audit.trail_entry`): `seq` (gap-free, 1, 2, 3 …), `eventId` (unique), `type`,
`source` (service), `time` (the event's, as text exactly as published), `actor` (id, name),
`subjects` (what it is about, read from the event: `record:<id>`, `document:<id>`, `edrmsNo:<no>`,
`intake:<id>`, `process:<id>`, `user:<id>`; `src/subjects.js`), the event's `data`, `prevHash`,
`contentHash`, `hash`, and `recordedAt` (when the audit service wrote it; not hashed).

```
contentHash(entry n) = SHA-256( canonicalJson({ seq, eventId, type, source, time, actor, subjects, data }) )
hash(entry n)        = SHA-256( prevHash || contentHash )        (both 32 bytes)
prevHash(entry n)    = hash(entry n-1);  prevHash(entry 1) = 32 zero bytes
```

Splitting the content's hash from the chain lets a proof carry later entries as hashes only (§4):
it never has to include other records' data.

Changing, removing or reordering any entry breaks every hash after it; `GET /audit/trail/verify`
recomputes the chain and names the first entry that is changed, missing or out of place. Two things
the chain alone cannot show, and the anchoring (§3) does: removing the *newest* entries, and
rewriting every entry and hash from some point on. Once a checkpoint covering them is on chain,
neither goes unnoticed.

**Reading a trail.** `GET /audit/trail?subject=record:<id>` returns the record's own entries plus
the steps of what it is made of: its documents' capture, extraction and filing in intake, their
filing and amendments in edrms, and its review processes in bpm. The service follows the links
between subjects (record → document number → document → intake document, process), but never into
another record or a user, so a document shared by two records does not bring in the other record's
steps. `subject=document:<id>` works the same way and shows every record that used the document.
`subject=user:<id>` returns what the user did, and the events that name them by id (an invitation,
a version they submitted). Administrators' changes to a user (suspended, roles changed) name the
user only by name in identity's events today, so they appear under the administrator.

The order is the order the consumer receives events in (JetStream stream
order), which is the order they were published, not exactly the order of the database commits in
different services; each entry keeps the event's own `time`.

**Checkpoint.** Once per batch (§3) the trail's head (`seq`, `hash`) becomes a leaf of the tree, so
the anchored root also proves the trail up to that entry. Entries after the checkpoint are covered
by the next one.

## 2. The growing Merkle tree (Merkle mountain range)

One append-only tree over everything ever recorded. Its root changes with every leaf added, and
**the latest root alone proves every earlier leaf**: an old root is inside a new one (a consistency
proof shows it), so a missing or changed old item cannot be hidden by anchoring a new root.

**Leaves.** Each leaf is the hash of one recorded item, with a one-byte type so an item of one kind
can never be passed off as another:

| Type | Byte | Item | From the event |
|---|---|---|---|
| Land record version | `0x01` | its seal (land-records README §7) | `records.record.committed` (`seal`) |
| EDRMS document version | `0x02` | its seal (edrms) | `edrms.document.filed`, `edrms.document.amended` (`seal`) |
| Trail checkpoint | `0x03` | the trail head `hash` | the audit service itself, per batch |

Seals are 64 hex characters (`sha256Hex`); the leaf takes the hex-decoded 32 bytes.

```
leaf  = SHA-256( 0x00 || type || item )          (item: the 32-byte seal or hash)
node  = SHA-256( 0x01 || left || right )
```

The `0x00`/`0x01` prefixes keep a leaf from ever being mistaken for an inner node (the classic
second-preimage defence, as in RFC 9162).

**Structure.** Leaves are appended in arrival order (position 0, 1, 2 …). A Merkle mountain range
keeps a list of perfect binary trees ("peaks"), one per set bit of the leaf count: 11 leaves =
8 + 2 + 1 = three peaks. Appending merges equal-sized peaks. The **root** of a tree of `size` leaves:

```
root = SHA-256( 0x02 || size (8 bytes, big-endian) || peak_1 || peak_2 || … )   (peaks from the largest)
```

Including `size` in the root fixes how many leaves it covers.

**Proofs.**
- *Inclusion* (an item is in the tree of size n): the leaf's position, the sibling hashes from the
  leaf up to its peak, and the other peaks of size n. About log2(n) hashes: ~24 for 13 million
  leaves, about 800 bytes in binary or 1.6 KB as hex in a JSON proof.
- *Consistency* (the tree of size m is the start of the tree of size n): the peaks of size m and
  the hashes that turn them into the peaks of size n. Shows that nothing anchored before was
  changed or dropped.

**Storage** (schema `audit`): every node by position (leaves and inner nodes; about 2 per leaf).
13 million leaves ≈ 26 million rows of about 70 bytes each in PostgreSQL (position, 32-byte hash,
row overhead): about 2 GB of table and 0.5 GB of index. A proof is a handful of point lookups;
nothing is held in memory.

## 3. Anchoring on Cardano

**Batches.** Every `ANCHOR_PERIOD` (default 1 hour), if anything was recorded since the last
anchoring (new leaves, or trail entries after the last checkpoint): add a trail checkpoint (the
current head), compute the root and submit one transaction. So a sign-off, a finding or an export,
which add trail entries but no seal, are in the next hour's root. Nothing recorded: no transaction.

The audit service's own bookkeeping (`audit.root.anchored`, `audit.root.confirmed`,
`audit.wallet.low`, `audit.trail.gap`) is published **broadcast-only** (`durable: false`) and kept in
its own `anchor` table, not in the trail: otherwise each anchoring would add a trail entry and cause
the next one, every hour, for ever. Sign-offs, findings and exports are ordinary durable events and
do go into the trail.

One anchoring is in flight at a time, from submission until it is confirmed (the next anchoring
spends its change output, after which "not on chain" could no longer be told apart from a
rollback). Once confirmed, it is no longer tracked.

**The transaction.** One input and one change output (the anchoring wallet's own address), no
smart contract, with the root in the transaction metadata under label **8890** (free in the CIP-10
registry on 10 October 2026; registering it there is optional and done before mainnet):

```json
{ "8890": { "v": 1, "sys": "lrfe-audit", "root": "<64 hex>", "size": 12345678, "batch": 87600, "prev": "<64 hex: previous root>" } }
```

Metadata strings are at most 64 bytes, so the root goes as 64 hex characters. `prev` links each
anchoring to the one before, so the anchorings themselves form a chain on the chain.

**Measured** (built with the real library, priced with the current parameters, which are the same on
preview and mainnet: 44 lovelace per byte + 155,381): **427 bytes, fee 174,169 lovelace
(0.174 ADA)**; with only `root` and `size`, 330 bytes and 0.170 ADA. The fee does not depend on how
many items the tree holds.

| Period | Transactions a year (at most) | ADA a year | USD at $0.235/ADA |
|---|---|---|---|
| hourly (default) | 8,760 | 1,526 | ~$359 |
| 15 minutes | 35,040 | 6,103 | ~$1,434 |
| daily | 365 | 64 | ~$15 |

Quiet hours cost nothing, so real costs are lower. Fees are fixed in ADA: the dollar cost follows
the ADA price. The wallet also keeps a small balance (the change output must hold at least about
1 ADA); that is not spent.

**Confirmation.** A submitted anchoring is *submitted*; once its output is on chain it is *on chain*,
with the block height it was **first seen** at (with Ogmios the exact inclusion block is not
available from a state query, so depth is counted from first seen, which can only under-count; with
Blockfrost it is the transaction's own block); at `ANCHOR_CONFIRMATIONS` blocks deep (default 10 on
preview, about 3–4 minutes; 30 on mainnet, about 10 minutes) it is *confirmed*, and its leaves'
proofs say so. If the
transaction disappears (a rollback) or is rejected, the same root is anchored again, or the next
batch's root covers it (it contains every earlier leaf). Events `audit.root.anchored`,
`audit.root.confirmed` (broadcast-only).

**The anchoring wallet.** One Ed25519 payment key, created and kept in **OpenBao's transit engine**
(key `audit-anchor`, type `ed25519`, not exportable). The audit service never sees the private key:
it builds the transaction body, asks OpenBao to sign the body's 32-byte hash (`transit/sign`), and
adds the returned signature as the key witness. Checked on 10 October 2026 with OpenBao 2.7.1: a
transit ed25519 signature over a 32-byte hash is a plain 64-byte Ed25519 signature. The wallet's
address is an enterprise address of the key's public key (`transit/keys/audit-anchor`). The audit
service's AppRole may only `sign` with that key and read its public key. A low-balance warning
(`ANCHOR_MIN_BALANCE_ADA`) goes to the log and as an event; preview is funded from the faucet.

**Chain access: one adapter, two drivers** (`CARDANO_PROVIDER`):

| Operation | `ogmios` (own node, API-662) | `blockfrost` |
|---|---|---|
| protocol parameters | `queryLedgerState/protocolParameters` | `GET /epochs/latest/parameters` |
| the wallet's unspent outputs | `queryLedgerState/utxo` (by address) | `GET /addresses/{address}/utxos` |
| submit | `submitTransaction` | `POST /tx/submit` |
| is the output on chain, how deep | `queryLedgerState/utxo` (by output reference) + `queryNetwork/blockHeight` | `GET /txs/{hash}` (block height) + `GET /blocks/latest` |

Ogmios listens on `127.0.0.1` only (API-662). The Blockfrost project key is a secret (OpenBao or a
file only the service's user can read), never shown on screen. `CARDANO_NETWORK` is `preview` in
this epic; `mainnet` later.

**Library.** `@emurgo/cardano-serialization-lib-nodejs` (maintained, Cardano's reference
serialization library) to build and serialize the transaction; signing through OpenBao as above.
No higher-level framework: both drivers need only the four operations above.

## 4. Proofs and verification

**A proof** (JSON, `GET /audit/proofs/{kind}/{id}`) for a land record version, a document version or
a trail entry:

```json
{ "item": { "kind": "record-version", "recordNo": "LR-NA-2026-000001", "version": 2, "seal": "…" },
  "leaf": { "type": 1, "position": 41237, "hash": "…" },
  "tree": { "size": 41300, "path": ["…"], "peaks": ["…"], "root": "…" },
  "anchor": { "network": "preview", "label": 8890, "tx": "…", "block": 1234567, "blockIs": "included | firstSeen", "confirmations": 42, "status": "confirmed" } }
```

A trail entry's proof adds the chain from it to the next checkpoint: the entry itself, and for each
later entry up to the checkpoint only its `contentHash` (§1), so the checker can recompute the
chain to the checkpoint leaf without seeing other records' data. "The entry itself" includes its
`prevHash`, which starts the recomputation.

**Verify** (`POST /audit/verify`): recompute the item's seal from the current data (land-records,
edrms), check the leaf, the path to the root, and that the root is in that transaction's metadata.

**The offline verifier** (`npx @lrfe/verify proof.json`, or one standalone file): checks a proof
without the portal, reading the transaction's metadata from any public source (Blockfrost, Koios'
free API, or an explorer). An evidence pack (§6) contains everything it needs.

Until its batch is anchored, an item's proof status is *waiting for the next anchoring*; the land
record's History tab and the Audit screen show it.

## 5. Sign-off and findings

- **Sign-off** (`audit.signoff`): mark a land record version (or a document version in it) audited,
  with a comment. A sign-off is itself a domain event, so it is in the trail and in the next root.
- **Finding** (`audit.signoff`): a description on a record or document version; the records officer
  and the registrar get a task (bpm). Open until resolved by a newer reviewed version, or closed by
  the auditor with a reason.
- **Segregation of duties (sod2):** whoever approved a land record version cannot sign it off; the
  service refuses ("You approved this version: another auditor must sign it off") and the screen
  shows why. The approver is in `records.record.committed` (`approvedBy`). This per-version rule is
  always applied. The catalogue's duty rule sod2 (`record.finalize` and `audit.signoff` held by one
  person, Administration → Security policies) is the separate, role-level warning when roles are
  assigned; switching that rule off does not lift the per-version refusal.

## 6. Evidence pack

`GET /audit/records/{id}/evidence` (`audit.export`): one zip with every committed version (JSON)
and seal, the documents it pins (files and verified metadata) and their seals, the record's trail
entries, sign-offs and findings, a proof for each version and document, a readable summary and
instructions for the offline verifier. Exporting is itself an event in the trail.

## 7. Privacy

Only hashes go on chain: the root, the tree size, a batch number and the previous root. No names,
ID numbers, parcel or document content, not even an individual seal. Nothing on chain can be
traced back to a person without the portal's data, and the portal's data cannot be changed without
the chain showing it.

## 8. API, events, permissions

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /audit/trail?subject=&type=&from=&to=` | `audit.view` | trail entries |
| `GET /audit/trail/verify` | `audit.view` | recompute the trail's chain |
| `GET /audit/proofs/{kind}/{id}` | `audit.view` | the proof of an item |
| `POST /audit/verify` | `audit.view` | verify an item against the chain |
| `GET /audit/anchors` | `audit.view` | anchorings, their transactions and status |
| `POST /audit/signoffs` · `POST /audit/findings` · `…/findings/{id}/close` | `audit.signoff` | sign off, raise or close a finding |
| `GET /audit/records/{id}/evidence` | `audit.export` | evidence pack |

Events, durable (in the trail): `audit.signoff.recorded`, `audit.finding.raised`,
`audit.finding.closed`, `audit.evidence.exported`. Broadcast-only (§3; not in the trail):
`audit.root.anchored`, `audit.root.confirmed`, `audit.wallet.low`, `audit.trail.gap`. The permissions are
already in the identity catalogue.

## 9. Mainnet (not in this epic)

- `CARDANO_NETWORK=mainnet`, a mainnet address (the same transit key gives a mainnet address with
  the mainnet network id), funded with real ADA; `ANCHOR_CONFIRMATIONS` 30 or more.
- **Own node:** a mainnet `cardano-node` needs about 24 GB of RAM (in-memory ledger; about 8 GB with
  the on-disk ledger) and 300 GB or more of disk, growing (Cardano developer docs, 2026). Ogmios
  on top is light.
- **Blockfrost:** the free plan (50,000 requests a day) covers hourly anchoring and checks; paid
  plans exist for heavy verification traffic. Check the current plans before going live.
- Register label 8890 in CIP-10.

## 10. Settings

`ANCHOR_PERIOD` (1h), `ANCHOR_CONFIRMATIONS` (10), `ANCHOR_MIN_BALANCE_ADA` (5), `CARDANO_NETWORK`
(preview), `CARDANO_PROVIDER` (ogmios | blockfrost), `OGMIOS_URL` (http://127.0.0.1:1337),
`BLOCKFROST_PROJECT_ID_FILE`, `ANCHOR_BAO_KEY` (audit-anchor), plus the usual `AUDIT_STORE`,
`DB_CONNECTION_STRING`, `DB_SYNC`, `JWT_SECRET`, OpenBao AppRole settings.
