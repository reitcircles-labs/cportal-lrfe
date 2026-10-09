# Testing the portal: start here

*For testers. Last checked against the app on 6 October 2026.*

This guide gets you ready to test the Deeds Registry portal and explains how the roles hand work to
each other. Each role then has its own guide with step-by-step tasks; follow them in the order of
[the whole flow](#the-whole-flow) below to take a parcel's deeds from the scanner to an approved land
record.

| Role guide | The job |
|---|---|
| [Scan operator](roles/scan-operator.md) | Upload scanned deeds into batches |
| [Metadata reviewer](roles/metadata-reviewer.md) | Check what the AI read, correct it, file documents to the EDRMS, reject what does not belong; approve corrections |
| [Records officer](roles/records-officer.md) | Build the land record of a parcel from its filed documents and submit it for review |
| [Registrar (supervisor)](roles/registrar.md) | Oversee the work, approve or return land records, invite users |
| [Auditor · read-only](roles/auditor.md) | Verify the integrity of filed documents, audit land records, export evidence |
| [System administrator](roles/system-administrator.md) | Offices, users, roles, security policies, access log |

## What you need

- **The portal's address**, from whoever runs the test system (on a developer's server through the
  SSH tunnel it is http://localhost:4200, see `backend/scripts/README.md`).
- **A phone with an authenticator app** (Google Authenticator, Microsoft Authenticator, Authy,
  1Password). Every sign-in asks for a 6-digit code from it. One app can hold all your test accounts.
- **One account per role you test** (see [Test accounts](#test-accounts)).
- **The sample documents** in [`docs/samples/`](../samples/README.md): fictitious deeds for one
  parcel, Erf 1873, Klein Windhoek. Download them to your computer.
- **Two browser windows** when two people must act in turn (for example a records officer who
  submits a land record and the registrar who approves it): a normal window and a **private /
  incognito** window. Signing in as someone else in the same window signs the first person out.

## Test accounts

Ask the system administrator for an account for each role you will test. Two ways:

- **Invited test users (best on a shared test system).** The administrator invites you once per
  role, using "plus" addresses that all reach your inbox, e.g. `you+scan@your-domain`,
  `you+review@…`, `you+review2@…`, `you+records@…`, `you+registrar@…`, `you+audit@…`. You activate
  each from its email and set up your authenticator for each. How invitations work:
  [Inviting users and assigning roles](inviting-users-and-assigning-roles.md).
- **The demo users (a developer's own test system only).** When the backend runs with demo users
  (`SEED_DEMO_PASSWORD`, see the top-level README), these exist, all with the password the developer
  chose:

  | Role | Demo user |
  |---|---|
  | Registrar (supervisor) | e.shivute@deeds.gov.na |
  | Scan operator | k.iipinge@deeds.gov.na |
  | Metadata reviewer | a.mwandingi@deeds.gov.na |
  | Second metadata reviewer (approves corrections) | t.iita@deeds.gov.na |
  | Records officer | j.gawaseb@deeds.gov.na |
  | Auditor · read-only | m.nakale@oag.gov.na |
  | System administrator | p.hamutenya@deeds.gov.na |

  Their addresses are at real government domains: never use **Resend invite** on them, and never
  enable demo users on a shared database.

Some steps need **two different people**: a correction to a filed document must be approved by
another reviewer, a land record must be approved by someone other than the person who submitted it,
and the app keeps some duties apart (for example, whoever can file documents should not sign off
their audit). Use the second reviewer account and the registrar account for those steps.

## Signing in

1. Open the portal, enter your email and password, click **Sign in**.
2. The first time: **Set up your authenticator**. Scan the QR code with your authenticator app (or
   open **Can't scan? Type the setup key instead** and type the key), then enter the 6-digit code.
3. After that, each sign-in asks for the current code: **Enter your code**.
4. The portal opens on your role's start page. The menu on the left shows only the screens your
   role may use; the top bar shows the screen's name, and the bell (**Tasks**) your approvals.
5. Sign out with the arrow next to your name, bottom left. After 30 minutes without activity you are
   signed out and see "Your session ended. Sign in again to continue."

## What is live and what is still demo

Most of the portal works with real data. Some screens still show **demo data** (fictitious names
and deed references) until their services are built; a line at the bottom of every page says which.

| Screen | Status |
|---|---|
| Sign-in, Administration (users, offices, roles, policies, access log), Tasks | **Live** |
| Capture, Verify metadata, Documents (EDRMS) | **Live**: uploads, AI reading, review, filing, corrections, integrity checks |
| Land record | **Live**: records built from filed documents, checks, review and approval through the bell, versions and history, comments |
| Audit | **Demo data**: sign-offs and findings are kept only until you reload; the document trail shows demo entries |
| Dashboard, Process & schema | **Demo data** |

So the audit steps can be practised, but their results are not saved yet. Do them in one sitting,
without reloading.

## The whole flow

The parcel is Erf 1873, Klein Windhoek. Its land record is built from the filed samples: the survey
diagram and the transfers of 2008 and 2019, which give the current owners. Samples 01 and 02 (the
1978 grant and the 1996 transfer) are optional; filed too, they lengthen the chain of title (with the
real AI only: skip them on a system with the canned AI, see the samples README).

| # | Who | Guide section | Samples |
|---|---|---|---|
| 1 | Scan operator | [Upload the samples](roles/scan-operator.md#upload-the-sample-documents) | 03, 04, 05, 06 (optionally 01, 02 too) |
| 2 | Metadata reviewer | [Review and file each document](roles/metadata-reviewer.md#review-and-file-a-document) | 03, 04, then 05 with its correction |
| 3 | Metadata reviewer | [Reject a document](roles/metadata-reviewer.md#reject-a-document) | 06 |
| 4 | Scan operator | [See what happened to your uploads](roles/scan-operator.md#follow-your-documents) | |
| 5 | Records officer | [Build Erf 1873 and submit it for review](roles/records-officer.md#build-erf-1873-from-the-sample-documents) | |
| 6 | Registrar | [Return it with a comment](roles/registrar.md#approve-or-return-a-land-record) | |
| 7 | Records officer | [Fix it and submit again](roles/records-officer.md#after-the-review) | |
| 7a | Registrar | [Approve it](roles/registrar.md#approve-or-return-a-land-record) (version 1); optionally the records officer then [changes it](roles/records-officer.md#change-a-committed-record) for a version 2 | |
| 8 | Auditor | [Check the filed documents' integrity](roles/auditor.md#check-a-documents-integrity), [look at the record's history](roles/auditor.md#look-at-a-land-record) and [audit it](roles/auditor.md#audit-a-land-record-demo) | |
| 9 | Metadata reviewer + second reviewer | [Correct a filed document](roles/metadata-reviewer.md#correct-a-filed-document) | a sample linked into Erf 1873, e.g. T 4521/2019 |
| 10 | Records officer, then registrar | [Take the correction over](roles/records-officer.md#when-a-linked-document-is-corrected-in-the-edrms) and approve it | |
| 11 | System administrator | [Check the access log](roles/system-administrator.md#check-the-access-log) | |

Steps 1 to 6 take about 45 minutes. Only the audit step must be done in one sitting (a demo screen).

## If something goes wrong

- Read the message on screen first: the portal says why it refuses something ("This file was already
  captured …", "… is reviewing this document", "Not permitted").
- A button that looks faded and shows "Requires …" when you point at it is not allowed for your role:
  that is expected, not a fault.
- "You don't have access to this area" means your role may not open that screen.
- Each role guide ends with the problems testers meet most often.

## Reporting a problem

Report problems in Jira, project **API** (board "API board"), as a **Bug** with the label
`cportal-lrfe`. Include:

1. **What you did**, step by step, with the role you were signed in as and the sample you used.
2. **What you expected** (the guide's "you should see") and **what happened** instead, with the exact
   message.
3. **A screenshot**, and the time it happened (the administrator can then find it in the access log).
