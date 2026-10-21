# Checking an ownership extract

*For banks, conveyancers and anyone handed an ownership extract by the registry.*

An ownership extract is a PDF the registry issues at its counter. It states who owns a parcel, as
the land record says on the day it is issued. You can check it in two ways.

## 1. Scan the QR code (always do this)

Scan the QR code on the extract, or type the address printed under it. The registry's public check
page opens; no account is needed. It tells you whether the extract is **current**, **replaced** by a
newer version of the land record, or **revoked** by the registry. Only this page can tell you that:
a PDF cannot know what happened after it was printed.

## 2. Check the PDF itself, offline

This shows that the PDF you were sent is the one the registry issued, and that the land record
version it shows is on the blockchain. You need Node.js 18 or later; nothing else is installed.

1. **Download the checker** from the registry's public page **Check a proof yourself** (linked from
   the sign-in page): one file, `lrfe-verify.mjs`.
2. **Copy the registry's address** from the same page: the blockchain address the registry sends
   its records from.
3. **Copy the registry's seal fingerprint**: 64 characters, published by the registry at
   `<the portal's address>/api/public/extracts/seal` (`sha256`). It identifies the registry's
   electronic seal; anyone can make a seal with the registry's name, but not one with this
   fingerprint.
4. **Run it** on the extract's PDF:

   ```bash
   node lrfe-verify.mjs extract.pdf --address <the registry's address> --seal <the seal fingerprint>
   ```

   Both are required: the checker compares the extract with what the registry publishes, never
   with what the PDF says about itself.

It reads the proof attached inside the PDF (`record-v<n>.proof.json`), follows it to a batch of the
registry's records, reads that transaction from the blockchain through a public service, and checks:

- the version's fingerprint is in the batch;
- the transaction carries the batch's fingerprint and was sent from the registry's address;
- the PDF carries the registry's electronic seal, made with the certificate whose fingerprint you
  gave, and was not changed after it was sealed. A seal the checker cannot verify counts as no seal.

### The answer

- **VALID**, with the batch and its date: the extract is as the registry issued it, and that version
  of the land record is on the blockchain. Exit code 0.
- **NOT VALID**, with the reason, for example the attached proof was changed, the transaction was
  not sent from the registry's address, there is no proof in the PDF, the seal is not the
  registry's, or the PDF was changed after it was sealed. Exit code 1. Do not rely on the extract;
  ask the registry.
- **Could not be checked**: the address or the seal fingerprint is missing, the file is not a
  readable PDF, or the blockchain could not be reached. Exit code 2.

### What the offline check does not tell you

- **Whether a newer version exists, or whether the extract was revoked.** Use the QR code for that
  (step 1).
- **The owners' details themselves.** Their full ID numbers are left out of the extract on purpose,
  so the version's fingerprint cannot be recomputed from the PDF. The registry's seal is what ties
  the details printed on the extract to its attached proof.

The checker can also check a single proof file or an auditor's evidence pack: see
[What is on the blockchain](what-is-on-the-blockchain.md), section 9.
