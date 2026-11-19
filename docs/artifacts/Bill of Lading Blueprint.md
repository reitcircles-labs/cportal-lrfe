Epic CB-8 · design of personas and flows · 9 Nov 2026 · updated 15 Nov 2026

# How an electronic bill of lading works, and how we build it in layers

A bill of lading (B/L) is the paper that says who may collect the goods from the ship. Whoever holds it controls the cargo. This page shows one B/L's journey, its life as a state machine, the software layers that carry it, and the order in which we can release modules.

Title: who holds the B/L Proof anchored on the blockchain Letter of indemnity (never moves title) Exists today (land registry platform) New for shipping

**Update 15 Nov 2026: letters of indemnity (epic CB-64).** When the B/L cannot be presented where the goods are, a party may ask the carrier to deliver anyway against a signed promise to cover the carrier's loss. Diagram 5 shows how this sits beside the B/L. The layers, rollout and personas below now include it. Source: analysis CB-59 / CB-60.

The one idea that changes everything

## A land registry is a register. A B/L is a document of title.

### Land registry (what we have)

- The **registry** decides and records who owns.
- Users are one office's officers.
- A copy of a title deed is just information.

### Bill of lading (what we add)

- The **holder** owns the right to the goods. The platform only guarantees there is exactly one holder.
- Users are many outside organisations: carriers, shippers, banks, buyers.
- Title moves by **endorsement**. No copy counts.

This is why the heart of the new product is an **exclusive-control engine** (layer 3 below). Everything else is mostly reuse.

Diagram 1 · The journey

## One negotiable B/L, from loading the goods to collecting them

Letter-of-credit trade with a bank on each side. The goods go by ship; the B/L travels through the banks at the same time. They meet again at the destination port when the buyer surrenders the B/L and collects the goods.

Step 1 moves goods, not title: there is no B/L until the carrier has the goods on board. Every orange step after that changes who holds title and leaves one proof on the blockchain. Banks, customs and port staff can verify at any step (dashed teal); verifying changes nothing. In the product: step 2 is the Issue flow (CB-11), steps 3–5 the Transfer flow (CB-12), steps 6–7 Surrender & delivery (CB-13).

**When step 6 cannot happen in time:** the ship arrives but the B/L is still on paper in the post, held on another platform, or names a different port. The buyer can then ask for the goods against a **letter of indemnity** (diagram 5). The goods are released at step 7, and the B/L is surrendered later.

Diagram 2 · The state machine

## The B/L's life as states and transitions

This is the contract the exclusive-control engine enforces. Each arrow is one command, allowed only for the current holder (or the carrier, where marked), and each arrow is anchored.

A letter of indemnity adds no state and no arrow here. The B/L stays *With holder* while goods are delivered against an LOI. Its surrender later (the normal arrow) is what closes the LOI.

### One voyage, many B/Ls

A ship calls at several ports. Each consignment has its own B/L naming one port of discharge, so different receivers at different ports simply hold different B/Ls. A cargo sold to several buyers while at sea is split into child B/Ls.

At each port the carrier releases only the consignments whose B/L is surrendered there. Part of a cargo is never released against a B/L that stays open for the rest: that would break "one holder controls the goods". A change of port of discharge is an amendment; a split closes the B/L and issues children. Both are cases of CB-14.

Diagram 5 · Letters of indemnity · epic CB-64

## When the B/L is not there: deliver against a signed indemnity

The requester (usually the buyer or charterer) asks the carrier to deliver without the B/L, or at another port, and promises to cover the carrier's loss if the real holder turns up. A bank may join the promise. On our platform the LOI is a separate record, signed by each party and anchored like the B/L's steps. It closes by itself when the B/L is surrendered.

A refusal at step 3 ends the LOI, and the normal B/L rules apply. The carrier can also close an LOI by hand, for example after a B/L on paper or another platform is handed in. Step 5 for a B/L on our platform is the normal surrender of diagram 2, so the title engine is unchanged.

### The standard cases, and when our eBL still needs them

| Form | Case | Needed for a B/L on our platform? |
| --- | --- | --- |
| A · AA | Delivery without the original B/L | **Rarely.** The holder can surrender in seconds. Still needed for paper B/Ls and B/Ls held on other platforms. |
| B · BB | Delivery at a port other than the one on the B/L | **Yes**, until the B/L is amended to the new port (amendment, diagram 2). |
| C · CC | Both: another port, without the B/L | As A and B together. |
| later | Switch B/Ls, lost B/L | Other wordings; after the first LOI release. Switch requests are common in drybulk trade (CB-65). |

The forms are the International Group of P&I Clubs' standard letters of indemnity; a new suite was published on 12 Sep 2023. The double letter (AA, BB, CC) is the bank-joined version. We refer to the clubs' wording, or let the carrier upload its accepted wording; we never copy it as our own text. P&I clubs discourage routine LOIs, so the carrier always accepts each one explicitly.

**Rule:** an LOI never moves title. It is a signed record linked to one B/L. The title engine only tells it when that B/L is surrendered. "Exactly one holder" is still proved in one place.

Diagram 3 · The layered architecture

## Six layers; each one only calls the layer below

Read bottom-up. Layers 0 and 1 are largely done (CB-2 to CB-5 split the land registry into a shared platform and domain packs). The real new engineering is layer 3.

L5 · Channels

### Screens and APIs

Who sees what. No logic.

**Shipping web app**sign-in done (CB-6)

**Public check page**anyone with a B/L number or QR

**Carrier API**structured data from carrier systems

**Platform-to-platform API**DCSA PINT

L4 · Use-case flows

### The modules we roll out

One flow = one design ticket = one release unit.

**Onboarding**organisations and staffCB-10

**Issue**B/L and sea waybillCB-11

**Transfer**endorsementCB-12

**Surrender & delivery**CB-13

**Amend, paper, exceptions**CB-14

**Verify**bank, customs, port, publicCB-15

**Chain of title**auditors, disputesCB-16

**Interop**other eBL platformsCB-17

**Letters of indemnity**request, countersign, accept, closeCB-64

L3 · Title engine

### Exclusive control

The new core. Has no land-registry equivalent.

**Holder ledger + state machine (diagram 2)**exactly one holder at any time · commands: issue, endorse, surrender, release, amend, switch to paper, void · each command checks the caller is the current holder, then anchors the change · announces surrender, which closes linked LOIs

L2 · Shipping pack

### Domain model

Plugs into the platform like the land pack.

**B/L data model**DCSA eBL standard

**Parties & organisations**carrier, shipper, forwarder, bank, consignee

**Roles & wording**shipping vocabulary

**LOI record**case, parties, wording, link to a B/L, its own statesCB-64

**Empty pack in place**CB-3

L1 · Platform contracts

### Generic record contract

Shared services call "the pack's record service", never land by name.

**Record contract client**CB-4

**Lint guard: shared never imports product**CB-5

L0 · Shared platform

### Reused from the land registry

Unchanged behaviour.

**Identity**sign-in, MFA, roles, four-eyes

**Audit & anchoring**blockchain proofs

**Sealed extracts**signed PDF, offline check

**Documents**EDRMS, search, AI reading

**Workflow (bpm)**

**Gateway, keys, messaging**

Dependency rule: arrows point down only. A flow (L4) never writes title directly; it asks the title engine (L3), which uses the pack's model (L2) and the platform's anchoring (L0). That keeps one place where "one holder" can be proved.

The LOI flow reuses L0 as it is: signatures and four-eyes from identity, anchoring from audit, a signed PDF of the LOI from sealed extracts, the uploaded wording in documents. It never calls the title engine to change anything.

Diagram 4 · Rollout

## Releases: each one is sellable on its own

Follows the epic's "start narrow" principle. A release starts once its flows have an agreed design from CB-8.

R0 · FOUNDATION · DONE

### Platform split

- Workspace, packs, record contract, lint guard (CB-2–5)
- Shipping sign-in (CB-6)

Gate: land registry unchanged

R1 · VERIFIABLE DOCUMENTS

### Sea waybill + verifiable B/L

- Personas & map (CB-9)
- Onboarding (CB-10)
- Issue (CB-11)
- Verify & public check (CB-15)

No title transfer yet. Value: anti-forgery check for banks and customs.

R2 · NEGOTIABLE eBL

### Exclusive control

- Title engine (L3)
- Transfer by endorsement (CB-12)
- Surrender & delivery (CB-13)
- Amend, paper, exceptions (CB-14)
- Chain of title (CB-16)

Gate: legal review and P&I approval path (business tasks).

R3 · NETWORK

### Interoperability

- Transfers to and from other platforms (CB-17, DCSA PINT)
- Carrier issuance API
- AI reading of paper B/Ls

Value: carriers join because we talk to the others.

AFTER R2 · INDEMNITIES

### Letters of indemnity

- LOI record and flow (CB-64)
- Forms A, B, C and bank-joined AA, BB, CC
- Closes on surrender
- Later: switch and lost B/L

Needs amendment (R2) for case B. Exact release to decide; wording reviewed with a P&I adviser. Feeds the drybulk epic (CB-65).

Who uses it

## Personas and the one thing each fears

| Persona | Does | Fears | First release |
| --- | --- | --- | --- |
| Carrier | Issues, amends, accepts surrender, releases goods; accepts or refuses LOIs | Delivering to the wrong party | R1 |
| Shipper / forwarder | Requests the B/L, endorses it on | Losing control before payment | R1 |
| Bank | Holds as security, endorses after payment; countersigns bank-joined LOIs | Forged or duplicate B/Ls; an LOI that never closes | R1 verify, R2 hold |
| Consignee (buyer) | Receives title, surrenders, collects goods | Goods released to someone else | R2 |
| LOI requester (buyer, charterer) | Asks for delivery without the B/L or at another port, and signs the indemnity | Cargo held at the port while the B/L is late | after R2 |
| Customs & port staff | Check validity and current holder | Clearing on a fake document | R1 |
| Auditor | Reads the chain of title and linked LOIs, settles disputes | A history the portal could rewrite | R2 |
| Platform admin | Onboards organisations | An impostor organisation | R1 |