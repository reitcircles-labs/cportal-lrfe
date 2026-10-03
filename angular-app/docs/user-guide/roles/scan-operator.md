# Scan operator

*For testers and scan-station staff. Last checked against the app on 3 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The scan operator puts scanned deeds into the system. Each upload belongs to a **batch** (for
example one box or one volume from the vault). As soon as a file arrives, the AI reads it and
proposes its details; a metadata reviewer then checks them.

**You start on:** Capture. **Your menu:** Dashboard, Capture, Documents (EDRMS), Process & schema.

| You can | You cannot |
|---|---|
| Create batches and upload PDF, PNG or JPEG scans | Review or correct what the AI read |
| Follow each document until it is filed or rejected | File documents to the EDRMS, or reject them |
| Look at filed documents in Documents (EDRMS) | Open Verify metadata ("Review →" is disabled for you) |

## Upload the sample documents

You need the sample files from [`docs/samples/`](../../samples/README.md) on your computer.

| # | Do | You should see |
|---|---|---|
| 1 | Sign in as the scan operator | **Capture**. On the left: the **Batch** list and **New batch** |
| 2 | Click **New batch**, type a source, e.g. "Tester run 3 Oct · Erf 1873", click **Create batch** | "Batch WDH-B… created". The batch card shows its number (e.g. **WDH-B012**), your source, you as creator, "Documents 0" |
| 3 | Click **Drop scans here or choose files** and pick `03-SG-A-412-2007-diagram.pdf`, `04-T-2210-2008-deed-of-transfer.pdf`, `05-T-4521-2019-deed-of-transfer-estate.pdf` and `06-practice-reject-cover-letter.pdf` (you can also drag them onto that box) | Under **Uploads**, each file with "Uploading…", then **"Queued for reading"** |
| 4 | Watch the table **Documents in WDH-B…** (it refreshes by itself) | Each file goes **Queued → Reading → In review**, usually within a minute. **Read as** shows what the AI recognised, e.g. "Deed of transfer T 2210/2008 · Erf 1873, Klein Windhoek"; **Fields** shows "0/17 reviewed" and how many need checking |
| 5 | Click the eye button on a row | The scan opens in a new tab |
| 6 | Point at **Review →** on a row | It is faded: "Requires 'View review queue'". Reviewing is the reviewer's job |

Optional: upload `01-G-88-1978-deed-of-grant.pdf` and `02-T-1502-1996-deed-of-transfer.pdf` as
well. They give the reviewer two more document types; if they are filed before 04, the reviewer sees
fewer fields flagged.

> **Tip:** one file is one instrument. A deed with several pages is one PDF, not one file per page.

## Follow your documents

Come back to **Capture** after the reviewer has worked (or pick your batch in the **Batch** list).

| Status | Means |
|---|---|
| Queued / Reading | Waiting for, or being read by, the AI |
| In review | Ready for a metadata reviewer; "N to check" counts fields the AI was unsure of |
| Filed | Filed to the EDRMS; the row shows its EDRMS number (e.g. EDR-NA-2026-000014) |
| Rejected | Not filed; the row shows the reviewer's reason (sample 06 should end here) |
| Failed | The AI could not read it; a reviewer can **Retry** |

The batch card counts "N · x in review · y filed". Filed documents can be looked up in
**Documents (EDRMS)**: search by EDRMS number or deed number.

## Things the scan station refuses (try them)

| Do | You should see |
|---|---|
| Upload a file that is not PDF, PNG or JPEG (e.g. a TIFF or Word file) | "Not a PDF, PNG or JPEG (convert TIFF first)"; nothing is added |
| Upload the same file again (even renamed, even into another batch) | "This file was already captured (*file name*, batch *WDH-B…*)"; nothing is added |

## Common problems

| What happens | Why, and what to do |
|---|---|
| A document stays **Queued** for minutes | The AI reader is busy or not running; tell whoever runs the test system |
| **Failed** with a message | The AI could not read the file (for example a blank or damaged scan); a reviewer can retry it, or rescan it |
| "This file was already captured" for a sample you never uploaded | Another tester uploaded it on this system. See "Each deed can be filed once" in [the samples README](../../samples/README.md#things-to-know) |
| Upload box is faded | Your account does not have the scan operator role (reviewers see Capture but cannot upload) |
