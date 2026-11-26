# eB/L Agent Layer Architecture (CB-93)

Architecture notes for building an AI agent layer on top of the existing electronic Bill of Lading (eB/L) stack (`shipping-records`, `@lrfe/domain-shipping`, four-eyes approvals, NATS outbox events, and blockchain-anchored audit trails).

- **Epic:** [CB-93](https://reitcircles.atlassian.net/browse/CB-93)
- **Child tickets:** `CB-94` (Tool & policy gateway), `CB-95` (LC discrepancy checker & proof explainer), `CB-96` (Multi-document carrier intake), `CB-97` (Amend/split proposal drafter), `CB-98` (NATS exception watchdog)

---

## 1. Core Design Rule

**Agents prepare and watch; deterministic rules and humans commit.**

In trade finance and maritime bills of lading, exclusive control and legal finality cannot be probabilistic:

- **Deterministic core (unchanged):** DCSA 3.0.3 schema validation, UN/LOCODE port checks, SMDG carrier code checks, cargo split conservation (`splitCargoProblems`), four-eyes approval (`own-draft`), optimistic concurrency (`revision`), ES256 chain-of-title signatures, and blockchain anchoring.
- **Agent layer (assistive & bounded):** Reads unstructured inputs (PDFs, shipping instructions, Letters of Credit, `changeReason`), drafts structured proposals, checks commercial consistency, watches operational events, and presents **exact, inspectable proposals** for an authorised human to confirm.

An agent never holds a signing key, never bypasses four-eyes, and never invents a title transition. Every call runs through the existing `/api/records/*` API under the caller's scoped session token.

---

## 2. Four-Layer Architecture

```text
+--------------------------------------------------------------------+
| 4. Channel & UX Layer                                              |
|    Portal copilot panel (BlDetailComponent) · Email / EDI intake   |
+--------------------------------------------------------------------+
| 3. Role-Scoped Domain Agents (Orchestrated workflows)              |
|    Carrier Intake · Amend/Split Drafter · LC Checker · Watchdog    |
+--------------------------------------------------------------------+
| 2. Tool & Policy Gateway (Typed MCP / Tool Runtime)                |
|    - Read & Verify: list B/Ls, read title/chain, verify proof      |
|    - Draft & Propose: create/edit draft, amend/split proposals     |
|    - Guardrails: org scoping, role perms, dry-run checks, HITL     |
+--------------------------------------------------------------------+
| 1. Event & Knowledge Memory                                        |
|    NATS stream (records.title.*, records.record.*) + per-org docs  |
+--------------------------------------------------------------------+
              | calls existing authenticated APIs |
              v                                   v
   [ Gateway / shipping-records ]       [ Audit / Identity ]
```

### Layer 1: Event Listener & Tenant-Isolated Context

- **NATS consumer:** Subscribes to `records.record.*` and `records.title.*` (alongside `audit` and `search`) so agents can react proactively when `surrender-for-amendment` arrives with a `changeReason` or a cross-platform `transfer-pending` stalls.
- **Per-organisation isolation:** Because `shipping-records` enforces strict party visibility (`404` for non-parties, `changeReason` hidden from earlier past holders, `GET /records/:id` restricted to the carrier), agent memory and indexes must be strictly partitioned per organisation.

### Layer 2: Typed Tool & Policy Gateway (`CB-94`)

Wrap existing HTTP endpoints (`GET /records/title`, `GET /records/:id/title`, `GET /records/:id`, `POST /records`, `POST /records/:id/title/:command`, `GET /records/:id/title/proof`, `GET /records/ports`, `GET /records/carriers`, `POST /records/read-paper`) as typed tools in three permission tiers:

1. **Read & Verify (autonomous):** Inspect B/L state, `allowedCommands`, UN/LOCODE ports, SMDG carriers, and `lrfe-title-proof/1` verification/anchoring status.
2. **Draft & Propose (autonomous, non-binding):** Create or update a `draft` (`POST /records`, `PUT /records/:id/draft`), run validation dry-runs so structured refusals (`unknown-port`, `cargo-mismatch`, `duplicate-cargo`) are corrected before a clerk reviews them, or stage an `amend`/`split` proposal.
3. **Title & Approval Mutations (human-gated):** `approve`, `issue`, `endorse`, `transfer`, `surrender`, `release`, `switch-to-paper`, `void`. The agent stages a confirmation preview card (including bearer risk for blank endorsements) and executes only on explicit human confirmation.

### Layer 3: Role-Scoped Domain Agents

1. **Carrier Intake & Draft Assistant (`CB-96`, extends `CB-57`)**
   - Reconciles multi-document bundles (booking confirmations, shipping instructions, commercial invoices, scanned paper B/Ls), checks ports, SMDG carrier codes, HS codes, and `cargoKeyOf` duplicate cargo, and saves a `draft` for human submission and four-eyes approval.
2. **Amendment & Split Proposal Drafter (`CB-97`, builds on `CB-50` & `CB-85`)**
   - Reacts to `surrender-for-amendment` + `changeReason`, drafts either a DCSA document diff (`amend`) or a valid `children` split allocation satisfying `splitCargoProblems`, and pre-fills the `Amend` / `Split` screen for carrier confirmation.
3. **Trade / Bank LC Discrepancy Checker & Proof Explainer (`CB-95`)**
   - Read-only copilot for banks and buyers: compares an uploaded LC or PO against B/L fields (`shippedOnBoardDate`, ports, goods, `isToOrder`, endorsement chain), cites discrepancies, optionally drafts a `changeReason` for `Ask for a change`, and explains `lrfe-title-proof/1` and blockchain anchor state in plain English.
4. **Exception & Interop Watchdog (`CB-98`)**
   - Monitors NATS events for stalled `transfer-pending` PINT handoffs (`retry-transfer`), overdue `in_review` drafts, idle `amendment-requested` B/Ls, and anchoring lag, surfacing org-scoped remediation cards.

### Layer 4: Channel & UX Layer

- Context-aware actions inside `BlDetailComponent` ("Check against LC", "Draft amendment from holder's request", "Explain title proof"), plus optional external intake connectors (email / EDI) feeding waiting drafts.

---

## 3. Why This Fits the Existing Stack

1. **Existing propose-vs-commit boundary:** Four-eyes (`draft -> in_review -> approve -> issue`) naturally enforces human approval over agent-authored drafts (`own-draft`).
2. **Machine-readable refusals:** `TitleRefusal` codes (`bl-change.ts` `REFUSAL_REASONS`), DCSA `details.problems`, and `cargo-mismatch` allow agents to self-correct proposals before presenting them to users.
3. **Independently verifiable proofs:** Downstream parties do not need to trust an agent's claims because `lrfe-title-proof/1` (ES256 JWS chain + blockchain anchor) can be verified directly.
4. **Structural tenant isolation:** Running tools under the user's org-scoped token preserves every existing visibility boundary at the API layer.

---

## 4. Guardrails Against Pitfalls

- **Prompt injection in B/L content:** Treat `termsAndConditions`, `descriptionOfGoods`, `changeReason`, and OCR output as untrusted data; never let extracted text invoke mutating tools without deterministic validation and human confirmation.
- **Audit attribution:** Record both the delegating user/organisation and `agentId` / `via: 'agent'` in `version.changes` and audit events.
- **Idempotency & cost control:** Rely on existing `revision` optimistic locking (`changed-meanwhile`) on writes and invoke LLMs only on unstructured steps or relevant events.

---

## 5. Phased Rollout

1. **Phase 1 (Zero title risk):** `CB-95` (read-only LC discrepancy checker + proof explainer) and `CB-96` (multi-document intake into `draft`), backed by `CB-94` tool gateway.
2. **Phase 2 (Four-eyes safe writes):** `CB-97` (amend & split proposal drafter from `changeReason`, confirmed by human carrier clerk).
3. **Phase 3 (Event-driven ops):** `CB-98` (NATS exception watchdog for PINT retries, review reminders, and anchoring alerts).
