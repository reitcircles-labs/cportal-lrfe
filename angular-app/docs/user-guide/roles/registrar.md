# Registrar (supervisor)

*For testers and registry supervisors. Last checked against the app on 3 October 2026.*
*New to testing the portal? Read [Testing the portal: start here](../testing-the-portal.md) first.*

The registrar oversees the registry's work: follows capture and review, finalizes land records,
reviews audit evidence and manages the registry's users.

**You start on:** Dashboard. **Your menu:** Dashboard, Capture, Verify metadata, Documents (EDRMS),
Land record (create/finalize), Audit, and under Administration **Users** and **Access log**.

| You can | You cannot |
|---|---|
| See every screen of the land-record work | Upload, review, correct or file documents |
| Finalize land records | Create land records or link documents (the records officer's job) |
| Check the integrity of filed documents; look at audit evidence | Sign off audits (the auditor's job) |
| Invite users, change their roles, suspend them | Change the permission matrix, offices or security policies (the system administrator's job) |

## Follow the work

| Do | You should see |
|---|---|
| **Dashboard** | Figures and recent activity (demo data for now) |
| **Capture**: pick a batch | Its documents and their status (Queued, Reading, In review, Filed, Rejected). The upload box is faded: you cannot upload |
| **Verify metadata**: open a document | The review screen, read-only: fields and buttons are disabled for you |
| **Documents (EDRMS)**: open a filed sample, **Check integrity** | "Integrity verified · version 1.0" (see the [auditor guide](auditor.md#check-a-documents-integrity)) |
| The bell (**Tasks**) | Your approvals, if any (corrections are approved by reviewers, not by the registrar) |

## Finalize a land record (demo)

> **Demo screen.** What you do on the Land record screen is kept only in your own browser until you
> reload or sign out. A records officer's links in their browser are not seen in yours, so take a
> record that is already **Ready for review**.

| # | Do | You should see |
|---|---|---|
| 1 | Open **Land record (create/finalize)**. Point at **New record** and **Add documents** | Both faded: "Requires …". Building records is the records officer's job |
| 2 | Click the filter **Ready for review** and pick a record, e.g. **Erf 3329, Olympia** | Status **Verified · ready for review**, its owners (Frieda Hoaeb ½, Hilma Nangolo ½) and **Record checks** with nothing in warning. **Finalize record** is enabled |
| 3 | Read the **Comments** tab | The discussion with the records officer and reviewers; you can add to it |
| 4 | **Finalize record** | "Finalize Erf 3329, Olympia?" listing the registered owners, and that the finalized version can only be superseded, not edited |
| 5 | **Finalize record** in that box | "Erf 3329, Olympia finalized · Record is ready for tokenization."; the record shows **Finalized** |

To finalize **Erf 1873** with the sample documents, do the records officer's steps in the same
browser session with an account that has both roles, or let the records officer finalize it (see
[the records officer guide](records-officer.md#finalize-erf-1873-with-the-sample-documents)).

## Look at audit evidence (demo)

**Audit** shows the evidence for Erf 1873: each document's provenance (what the AI read and what the
reviewer filed), integrity and trail. As registrar you can look and export; signing off is the
auditor's job ("Mark document audited" is faded for you). Details: [auditor guide](auditor.md#audit-a-land-record-demo).

## Manage users

The registrar can invite users into an office, change their roles and suspend them, exactly as an
administrator does: see [Inviting users and assigning roles](../inviting-users-and-assigning-roles.md).
The tabs **Offices**, **Roles & permissions** and **Security policies** are not shown to you.

## Common problems

| What happens | Why, and what to do |
|---|---|
| **Finalize record** is disabled | Read **Record checks**: a check is in warning (a missing document, an invalid ID number, an open item) |
| Erf 1873 does not show the records officer's work | The Land record screen is a demo: each browser has its own copy until the land-records service exists |
| The review screen is read-only | Expected: reviewing is the metadata reviewer's job |
