# Product decisions that shape new work

Agreed with the user; follow them in design and code. The service READMEs hold the technical detail.

## Audit (API-678, API-680)

- The approver (never the submitter) owns the land record; approving commits and seals the version,
  and the seal goes on the blockchain.
- Auditors are external: they verify, never shape the record; a finding only sends tasks to the
  records office.
- Every document and version is checked against the blockchain automatically; there is no document
  sign-off. Only on-chain data can be trusted: nothing is audited before it is on the blockchain and
  matches. A mismatch is not a finding: the record must be reviewed and submitted again.
- The audit sign-off is a checkpoint covering every version since the last one; it is blocked while
  anything is off the blockchain, a document doesn't match, or a finding is open.
- Findings are threads (comment, answers with name, role, time), closed only by an auditor, by a
  corrected version or as "resolved by agreement" (reason required) or "raised by mistake"; never
  deleted; kept in the audit trail under "Findings".

## Screens

- Every audit term on screen has an (i) explanation that works on touch; "How audit works" panel.
- Say what was checked ("Fingerprint calculated"), not where or how it runs.
- "Blockchain", never the network's name; only an explorer link's address shows it.

## Ownership extracts (API-689)

- Issued at the counter to a registered owner whose ID document was seen, only for a version
  confirmed on the blockchain; numbered EX-<country>-<year>-<nnnnnn> without gaps; sealed by the
  registry (its key in OpenBao); a 12-character check code and a QR code open the public check page,
  which shows nothing personal and is rate-limited.
- The offline checker verifies the registry's seal (pinned by its fingerprint) and the attached proof
  against the blockchain; it does not recompute the fingerprint (full ID numbers are left out).

## Scale (API-768)

- Proposed targets in `backend/scripts/scale/targets.json` (awaiting the client's agreement); the
  generator and load tests in `backend/scripts/scale/README.md`. Fixes go through indexes and query
  shape (API-770, API-771, API-787), batching (API-773); a search engine only if those miss.
