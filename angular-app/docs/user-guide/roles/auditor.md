# Auditor · read-only

*For testers and the Office of the Auditor-General. Last checked against the app on 3 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The auditor checks that the land records can be trusted: that each filed document is exactly what
was sealed, that every value can be traced to the scan, and that the record's history is complete.
The auditor changes nothing; their sign-offs and findings are added to the audit trail.

**You start on:** Audit. **Your menu:** Dashboard, Capture, Verify metadata, Documents (EDRMS),
Land record, Audit, Process & schema; everything except Audit is view-only for you.

| You can | You cannot |
|---|---|
| Check the integrity of any filed document and version | Upload, review, file or correct documents |
| Sign off documents as audited, or raise a finding | Create, change or finalize land records |
| Look at every screen of the land-record work | Approve corrections |

The app keeps duties apart: someone who can **file** documents, or **finalize** land records, should
not also **sign off** audits. An administrator who gives such a combination is warned, and the
exception is written to the access log.

## Check a document's integrity

Live: this checks the real filed documents, e.g. the samples the reviewer filed.

| # | Do | You should see |
|---|---|---|
| 1 | Sign in as the auditor, open **Documents (EDRMS)** | The filed documents, newest first |
| 2 | Search "T 2210/2008" and click it | The record: EDRMS number, type, registry, batch, "v1.0" (or v2.0 after a correction), **Verified metadata**, **Version history**, **Record metadata (ISO 23081)** |
| 3 | Click **Check integrity** | **Integrity verified · version 1.0**: the content matches its SHA-256 fingerprint and the seal is intact, with the time of the check |
| 4 | In **Verified metadata**, look for values marked **corrected** | Values the reviewer changed from what the AI read (e.g. Tomas Nghishidi's ID on T 4521/2019) |
| 5 | In **Version history**, look at each version | Who filed it; for a correction: who requested it, who approved it, the reason, and old → new values. Every version keeps its own fingerprint and seal |
| 6 | Click **Open file** | The sealed scan opens in a new tab |

**Request correction** is faded for you ("Requires …"): auditors do not change records. If a value
is wrong, report it so that a reviewer requests a correction.

A failed check would show **Integrity check FAILED**, and say whether the content no longer matches
its fingerprint or the seal is broken. That must never happen; report it at once.

## Audit a land record (demo)

> **Demo screen.** The Audit screen still runs on demo data for **Erf 1873, Klein Windhoek**. Its
> documents become available once they are filed (the samples filed through Verify count). Your
> sign-offs and findings are kept only until you reload the page or sign out.

| # | Do | You should see |
|---|---|---|
| 1 | Open **Audit** | "Audit · Erf 1873, Klein Windhoek", the number of trail entries, "Hash chain intact", "N of 5 documents audited". Along the top, the record's documents by year (G 88/1978, T 1502/1996, SG A 412/2007, T 2210/2008, T 4521/2019), each with its state (Linked, Filed, Audited…); those not filed yet show "Not captured" and are greyed out |
| 2 | Click **T 4521/2019** | Page 1 of the document (corrected values outlined), **Metadata provenance** (each field: what the AI extracted, the verified value, confidence, and whether the reviewer accepted or corrected it), **Integrity** (the real EDRMS number once filed; the other values there are demo values: use **Check integrity** in Documents for the real check) and **Document trail** |
| 3 | Check the provenance: is every corrected value justified by the scan? Click **Open viewer** to see all pages | |
| 4 | If all reconciles: **Mark document audited** → **Mark audited** | "Audited · Office of the Auditor-General"; the counter goes up |
| 5 | On another document, try **Raise finding** → **Raise finding** | "Finding raised · Office of the Auditor-General"; the records officer and registrar would be notified, and the document stays flagged until resolved |

**Export evidence pack** is shown but does not do anything yet; it comes with the audit service.

## Common problems

| What happens | Why, and what to do |
|---|---|
| A document is greyed out on the Audit screen | It is not filed yet. The samples count once a reviewer has filed them; reload the Audit screen afterwards |
| My sign-offs are gone | The Audit screen is a demo: reloading starts it again |
| **Check integrity** is not there | Your account does not have the auditor's permission "View audit trail & evidence" |
| Integrity shows version 2.0 | A correction was approved; check the earlier version under **Version history** |
