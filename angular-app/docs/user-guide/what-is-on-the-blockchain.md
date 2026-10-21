# What is on the blockchain, and how each value is arrived at

*For auditors, the registry and anyone who checks the registry from outside. No programming is
needed to follow it; the hashes are shown in full so that someone who wants to can recompute every
one of them.*

Once in a while (every hour by default, and only when something new was recorded) the portal writes
one small record to a public blockchain. It is called an **anchoring**, or a **batch**. On a
blockchain explorer it looks like this (an example), in the transaction's metadata under the
label **8890**:

```json
{
  "batch": 11,
  "prev": "5f6bce4a1ae74522439aa0fcd18bc6109b2afd0c3a2f1ebd76abcb5aab37e238",
  "root": "f3a7b9d6aa2b43da4d5849d0bc81a49e3c03445dcaa1c7fcb0b88926d12bd16e",
  "size": 14,
  "sys": "lrfe-audit",
  "v": 1
}
```

That is all that goes on the blockchain: no names, no ID numbers, no documents. Yet this one record
lets anyone prove later that every document version, every land record version and the audit trail
recorded up to then are still exactly as they were. This guide explains how.

## 1. The fields at a glance

| Field | What it is |
|---|---|
| `v` | The version of this layout. Always `1` today. |
| `sys` | Who wrote it: `lrfe-audit` is the portal's audit service. Checkers accept only records with this value, so anything else that happens to use label 8890 is ignored. |
| `batch` | The number of this anchoring, counting from 1. A batch that never reached the blockchain keeps its number, so the numbers you see on the blockchain can have gaps. |
| `root` | One fingerprint (64 hexadecimal characters, a SHA-256 hash) that stands for **everything recorded so far**. Sections 2 to 4 show exactly how it is computed. |
| `size` | How many items that fingerprint covers: **all items ever recorded**, not only the new ones. |
| `prev` | The `root` of the previous anchoring that was on the blockchain, or on its way there, when this one was made. It links the anchorings into a chain. Left out when there is none: on the first anchoring, or when every earlier one failed to reach the blockchain. |

The transaction is paid by the registry's **anchoring wallet**. Anyone can write a fingerprint into
a transaction, but only the registry can pay from its wallet, so a checker always compares the
paying wallet with the address the registry publishes (on the portal's public page
**Check a proof yourself**, linked from the sign-in page).

## 2. From a document to a fingerprint: the seal

Every item the portal protects has a **seal**: a SHA-256 fingerprint of everything that item asserts.
Change a single byte of it and the seal is completely different.

SHA-256 turns any input into 32 bytes, written as 64 hexadecimal characters. It cannot be reversed:
from a seal nobody can recover the document, but the same document always gives the same seal.

**A document version** (in the EDRMS). The seal is SHA-256 over the version's details, written as
*canonical JSON* (keys in alphabetical order, no spaces, so the same details always give the same
text):

- `sha256`: the fingerprint of the file itself (the scanned PDF, byte for byte);
- `documentId`, `edrmsNo` (e.g. EDR-NA-2026-000001) and `versionNumber`;
- `fields`: every metadata field as filed (deed number, owners, ID numbers, extent …);
- `recordMetadata`: the records-management details (business activity, who captured and who
  reviewed it, retention, access restriction …);
- `createdAt`, `createdById`, `approvedById`, and `provenance` when the filing carried it.

So the seal covers both the scan and what the registry says about it: a changed page or a changed ID
number both break it.

**A land record version.** SHA-256 over the canonical JSON of the record's id and number, the version number, the
whole version (parcel, owners, extent, encumbrances, and every document it rests on *with that
document's seal*), who submitted and who approved it, when it was committed, and the **previous
version's seal**. The versions of a land record therefore form a chain of their own.

**A trail checkpoint.** The audit trail is a list of every action in the portal (filed, approved,
signed off …), each entry chained to the one before by a hash. Once per batch, the hash of the
newest entry, the trail's head, is taken as an item. That one hash vouches for every entry up to it.

## 3. From seals to leaves

Each seal becomes one **leaf** of a tree. Before it is hashed, one byte says what kind of item it is,
so that a seal of one kind can never be passed off as another:

```
leaf = SHA-256( 0x00 || type || seal )
type:  0x01 land record version · 0x02 document version · 0x03 trail checkpoint
```

`||` means "followed by": the bytes are joined, then hashed. The seal is used as its 32 bytes, not as
its 64 characters.

Leaves are numbered 0, 1, 2 … in the order the audit service learned of them, and are never changed
or removed. A leaf is only ever added.

## 4. From leaves to the root: a Merkle mountain range

The leaves are combined pairwise, the usual way of a **Merkle tree**:

```
node = SHA-256( 0x01 || left || right )
```

A plain Merkle tree needs a number of leaves that is a power of two (1, 2, 4, 8 …). The portal adds
leaves one at a time, so it uses a **Merkle mountain range**: as many perfect trees ("peaks") as
there are powers of two in the number of leaves. 14 leaves = 8 + 4 + 2, so a tree of 14 leaves has
three peaks:

```
          peak 1 (leaves 0–7)                    peak 2 (8–11)        peak 3 (12–13)
         /                    \                    /       \             /      \
     node                      node             node        node      leaf 12  leaf 13
    /     \                  /      \          /   \       /   \
 node      node          node        node   leaf 8 leaf 9 leaf 10 leaf 11
 /  \      /  \          /  \        /  \
L0  L1    L2  L3        L4  L5      L6  L7
```

Finally the peaks are joined into the **root**, largest peak first, together with the number of
leaves:

```
root = SHA-256( 0x02 || size as 8 bytes || peak 1 || peak 2 || … )
```

That is the `root` in the metadata, and the number of leaves is its `size`. Because the size is
inside the hash, the root cannot be claimed for a different number of items.

The prefixes `0x00` (leaf), `0x01` (node) and `0x02` (root) keep the three from ever being mistaken
for one another. The leaf and node prefixes are the safeguard Certificate Transparency uses
(RFC 9162); `0x02` does the same for the root.

**What each batch adds.** At each batch the audit service first adds that batch's trail checkpoint as
a leaf, then takes the root. So `size` counts every document and land record version ever
recorded, plus one trail checkpoint for each anchoring attempt that found new trail entries (also
attempts that never reached the blockchain: their checkpoints stay in the tree).

## 5. A worked example

Five fictitious items, computed with the portal's own code. Every value can be recomputed with the
script in section 6.

**Leaf 0, a document version, in full.** The file's bytes are, for the example, the text
`This text stands in for the bytes of a scanned PDF.` Its SHA-256 is
`96aa599e680506b41220ac10133135b312d47c53c95413dafb67876636417053`. The version's details, as
canonical JSON (deliberately short; a real version has all its fields):

```json
{"approvedById":null,"createdAt":"2026-10-17T08:00:00.000Z","createdById":"u-reviewer","documentId":"00000000-0000-4000-8000-000000000001","edrmsNo":"EDR-NA-2026-000001","fields":[{"k":"deedNo","label":"Deed number","v":"T 2210/2008"}],"recordMetadata":{"title":"Deed of transfer T 2210/2008"},"sha256":"96aa599e680506b41220ac10133135b312d47c53c95413dafb67876636417053","versionNumber":1}
```

The SHA-256 of that text is the seal:
`d4cb364b7fd60370a92df4722f4609408e284b54a8bfa7efc5c0aa392561355a`.

For brevity, the other four items use stand-in seals (the SHA-256 of a label such as
`example: trail head at entry 9`). The arithmetic is the same.

| Leaf | Kind (type) | Seal | Leaf hash |
|---|---|---|---|
| 0 | document version (2) | `d4cb364b7fd60370a92df4722f4609408e284b54a8bfa7efc5c0aa392561355a` | `28e67acc41ecc02b308d9304255e4a574dad0e0dec1de66be1c413cdfd7db513` |
| 1 | document version (2) | `922f923f7c145294fb50110fa9aba1d4f2b03ca20457944a115cb03b01a5a410` | `8d541a04afcfcb8ab4ca31b678929d6cc6f5043a8c48372f67a5cda972c1c79f` |
| 2 | land record version (1) | `aeef0bc19d0142d859d8c377fbfdf1ec63887c35d7be72e08cb3dc0c01f52165` | `2c65bfb9a6510277d76413a27b9dd60c2b9a59aa580863ab0c13ce1724ff2e90` |
| 3 | document version (2) | `a293bcd1c51b5dbeda39c2cef288dcd00f08e158a5c999f0b7518ba05cf99104` | `2fc680a3d4a65305bfdbdf894cd24b69ad4aa305b30ae28138fca874b7da7d3f` |
| 4 | trail checkpoint (3) | `28a0409e1122cc735eb509f883261a596b11ac3794b9be7317b6befcb7bf6c01` | `a8c069e6bd2ae27cbda3cedc49150b657216d4a7d40cbb8c2688bf6e0671720d` |

Five leaves = 4 + 1, so two peaks:

```
               peak 1 (leaves 0–3)                         peak 2 (leaf 4)
            /                      \
   node 0–1                          node 2–3                 leaf 4
   /      \                         /       \
leaf 0   leaf 1                 leaf 2     leaf 3
```

| Step | Computation | Result |
|---|---|---|
| node 0–1 | SHA-256(0x01 ‖ leaf 0 ‖ leaf 1) | `e5eb699fd62f3e6b717390d1642969ab469197cae2581228c06597a07a41a06d` |
| node 2–3 | SHA-256(0x01 ‖ leaf 2 ‖ leaf 3) | `2f893e3146a47bcd0b10bb6982d8afca354c475d3f6185c8bb0084f4eb367490` |
| peak 1 | SHA-256(0x01 ‖ node 0–1 ‖ node 2–3) | `3211e80e224f6e7df46eadf9dea23f5a53917fcb7c2f942a393ab73a9da09ffe` |
| peak 2 | leaf 4 itself (a peak of one leaf) | `a8c069e6bd2ae27cbda3cedc49150b657216d4a7d40cbb8c2688bf6e0671720d` |
| **root** | SHA-256(0x02 ‖ 0000000000000005 ‖ peak 1 ‖ peak 2) | **`e7b5ade71ea01666b7b4f5f3969a411dd007239e2b8bed65426a49b1470e762c`** |

The anchoring of this tree would carry `"root": "e7b5ade7…762c", "size": 5`.

**`prev`, in the example.** Say the previous anchoring was made when there were three leaves (0, 1
and 2). Three = 2 + 1, so its peaks were node 0–1 and leaf 2, and its root was
SHA-256(0x02 ‖ 0000000000000003 ‖ node 0–1 ‖ leaf 2) =
`889f5ef0d96a257280e504b01c12a6dc24a34aa9d2cd45a5c197d810ae97b1bb`. The new anchoring carries that as
`prev`. The old peaks sit unchanged inside the new tree (node 0–1 inside peak 1, leaf 2 under node
2–3). The tree is built that way so that a *consistency proof* can show the old root inside the new
one; the audit service can compute one, but the portal does not offer it as a download today.

## 6. Recompute a root yourself

This script needs only Node.js 18 or later and nothing else. Give it the leaves' types and seals in
order; it prints each peak and the root. As shown it recomputes the example above.

<!-- root-script: the test in backend/services/audit/tests/metadata-guide.test.js runs this block -->
```js
// node root.mjs: prints the root of a Merkle mountain range over the given leaves
import { createHash } from 'node:crypto';

const sha256 = (...parts) => { const h = createHash('sha256'); parts.forEach(p => h.update(p)); return h.digest(); };
const leafHash = (type, seal) => sha256(Buffer.from([0x00, type]), Buffer.from(seal, 'hex'));
const nodeHash = (left, right) => sha256(Buffer.from([0x01]), left, right);

/** The peaks and root over `leaves` ([type, seal hex] in order): append each leaf, merging equal-sized peaks. */
function treeOf(leaves) {
  const peaks = [];                                   // [{ height, hash }], largest first
  for (const [type, seal] of leaves) {
    let peak = { height: 0, hash: leafHash(type, seal) };
    while (peaks.length && peaks[peaks.length - 1].height === peak.height) {
      const left = peaks.pop();
      peak = { height: peak.height + 1, hash: nodeHash(left.hash, peak.hash) };
    }
    peaks.push(peak);
  }
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(leaves.length));
  return { peaks, root: sha256(Buffer.from([0x02]), size, ...peaks.map(p => p.hash)).toString('hex') };
}

const LEAVES = [
  [2, 'd4cb364b7fd60370a92df4722f4609408e284b54a8bfa7efc5c0aa392561355a'],
  [2, '922f923f7c145294fb50110fa9aba1d4f2b03ca20457944a115cb03b01a5a410'],
  [1, 'aeef0bc19d0142d859d8c377fbfdf1ec63887c35d7be72e08cb3dc0c01f52165'],
  [2, 'a293bcd1c51b5dbeda39c2cef288dcd00f08e158a5c999f0b7518ba05cf99104'],
  [3, '28a0409e1122cc735eb509f883261a596b11ac3794b9be7317b6befcb7bf6c01'],
];
const { peaks, root } = treeOf(LEAVES);
peaks.forEach((p, i) => console.log(`peak ${i + 1} (${2 ** p.height} leaves): ${p.hash.toString('hex')}`));
console.log(`root (size ${LEAVES.length}): ${root}`);
```

Expected output: two peaks, then
`root (size 5): e7b5ade71ea01666b7b4f5f3969a411dd007239e2b8bed65426a49b1470e762c`.
With only the first three leaves (delete the last two lines of `LEAVES`) it prints the `prev` root
above: `root (size 3): 889f5ef0d96a257280e504b01c12a6dc24a34aa9d2cd45a5c197d810ae97b1bb`.

**Why you cannot do this for a real batch.** Recomputing a real root this way needs every seal in the
registry, and the portal does not hand out the whole list: the tree covers every land record, and a
checker of one record has no business with the others. That is what proofs are for (section 7):
they let you check *one* item against the root, using only a few hashes and nothing about any other
record.

## 7. How a proof reaches the root

A **proof** (**Download proof**, next to a version's blockchain status: in a document's version
history, a land record's History, or the auditor's Blockchain check) shows that one item is a leaf
under one anchored root. The portal gives the proof against the **first** batch that covered the
item: from then on the item is proved to have existed.

In the example, leaves 0–2 were already covered by the earlier batch of three, so take leaf 3, which
the batch of five covered first. Its proof holds:

- the leaf: its type (2) and seal, and its position (3);
- the **path**: the sibling hashes from the leaf up to its peak: leaf 2, then node 0–1;
- the **peaks** of the tree: peak 1 and peak 2;
- the anchoring: the batch, the transaction, its root and size, and the wallet that paid for it.

The check:

1. Recompute leaf 3 from its type and seal.
2. Climb: node 2–3 = SHA-256(0x01 ‖ leaf 2 ‖ leaf 3); then SHA-256(0x01 ‖ node 0–1 ‖ node 2–3).
   The result must equal peak 1.
3. Join the peaks with the size: the result must equal the root.
4. Read the transaction on the blockchain: its metadata must carry that `root` and `size` with `sys`
   `lrfe-audit`, and it must be paid by the registry's published wallet.

The path is about log₂(size) hashes: about 24 hashes for 13 million items. Neither the path nor the
peaks reveal anything about the other items: they are hashes only. (A proof of a *trail entry*, from
Audit → Trail, does contain that one entry in readable form, who did what, since that is what it
proves.)

To check the seal itself, its inputs (section 2) are needed. The **evidence pack** of a land record
holds the versions' data and the documents' files, and the offline verifier recomputes every seal
from it (`node lrfe-verify.mjs <the evidence pack's zip file> --address <the registry's wallet>`).
In the portal, **Verify against the blockchain** has the EDRMS read the stored file again, hash it
and recompute the seal.

## 8. What it proves, and what it does not

**It proves:**

- **The item existed, exactly as it is, no later than the block that holds the transaction.**
  Anyone can check it, without trusting the portal, its database or its staff.
- **Nothing anchored earlier can be changed or removed unnoticed.** A transaction on the blockchain
  cannot be changed, every item is proved against the first batch that covered it, and `prev` links
  the batches into a chain anyone can follow. (The tree also allows a consistency proof that an old
  root is inside a new one; the portal does not offer that as a download today.)
- **The audit trail up to the checkpoint is complete and unchanged**, including the newest entries,
  which the trail's own chain alone could not protect.

**It does not:**

- **publish anything readable.** Only fingerprints are on the blockchain; no personal data, no
  document (a proof file, which you are given, not the blockchain, can contain the one item it
  proves);
- **list what a batch contains.** From the blockchain alone nobody can tell which records are in it;
  the portal shows that (Anchorings → a batch → what it covers), and a proof shows it for one item;
- **say that a document is legally right.** It proves that the record has not changed since it was
  anchored. Whether it was right when it was filed is what review and audit are for.

## 9. Check it yourself

| You want to … | Where |
|---|---|
| See a batch: its root, size, transaction, what it covers | Portal: **Anchorings**, then the batch |
| Find the batch that first covered a record or document | Portal: **Anchorings**, **Is it on the blockchain?** |
| See the raw metadata | The batch's **View on a blockchain explorer**, then the transaction's metadata, label 8890 |
| Check one item without the portal | **Download proof**, then the offline verifier from the public page **Check a proof yourself** (`node lrfe-verify.mjs proof.json --address <the registry's wallet>`) |
| Check a whole land record, recomputing every seal | **Audit** → the record → **Export evidence pack**, then the same verifier with the zip file |
| Check an ownership extract's PDF | `node lrfe-verify.mjs extract.pdf --address <the registry's wallet> --seal <the seal fingerprint>`: see [Checking an ownership extract](checking-an-ownership-extract.md) |
| Know the registry's wallet | The public page **Check a proof yourself** |

## 10. Glossary

| Term | Meaning |
|---|---|
| Anchoring, batch | One transaction on the blockchain carrying the root at that moment |
| Canonical JSON | Details written as text with keys sorted and no spaces, so the same details always give the same text and the same seal |
| Hash, fingerprint | The SHA-256 of some bytes: 32 bytes, shown as 64 hexadecimal characters; it cannot be reversed |
| Leaf | One item in the tree: the hash of its type and its seal |
| Merkle mountain range | A Merkle tree that grows one leaf at a time, kept as a few perfect trees (peaks) |
| Path | The sibling hashes from a leaf up to its peak; part of a proof |
| Peak | The top of one of the perfect trees; the root joins all peaks |
| Proof | A file showing that one item is a leaf under one anchored root |
| Root | The single fingerprint over all leaves, written to the blockchain |
| Seal | The fingerprint of everything one document version, land record version or trail head asserts |
| Wallet | The registry's account that pays for each anchoring; its address is published |

*The technical design, with every formula and the code behind it, is in the audit service's README
(`backend/services/audit/README.md`, sections 1 to 4).*
