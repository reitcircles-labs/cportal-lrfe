# Inviting users and assigning roles

*For administrators. Last checked against the app on 3 October 2026.*

Nobody can create their own account. An administrator **invites** each person by email and gives
them one or more **roles**; the role decides what they can see and do. This guide explains how
that works, then walks through a complete check you can do with your own email address.

## The basics

**Invitation.** When you invite someone, the app emails them a personal link. They open it, choose
a password and set up their phone for sign-in codes. Until then they are listed as **Invited**.
The link works once and expires after 3 days.

**Two-step sign-in (MFA).** Every sign-in asks for the password *and* a 6-digit code from an
authenticator app on the user's phone (Google Authenticator, Microsoft Authenticator, Authy,
1Password). The first time, the app shows a QR code to scan with that app.

**Roles.** A user can have one or more roles. Each opens the screens that job needs:

| Role | For | Starts on | Can do |
|---|---|---|---|
| Registrar (supervisor) | Oversees the registry | Dashboard | See everything, finalize land records, review audit evidence, manage users |
| Scan operator | The scan station | Capture | Upload scanned deeds |
| Metadata reviewer | The review desk | Verify metadata | Check what the AI read from each scan, correct it, file documents |
| Records officer | The records desk | Land record | Create land records and link documents to them |
| Auditor · read-only | Office of the Auditor-General | Audit | Inspect documents and evidence, sign off audits; cannot change anything |
| System administrator | ICT | Users | Users, roles and security policies; no access to land-record work |

These are the standard permissions; an administrator can adjust what each role may do under
**Roles & permissions**.

**Duty conflicts.** Some combinations are risky, for example someone who can both file documents
and sign off their audit. The app warns when a change would create such a conflict and asks you
to confirm; if you go ahead, the exception is recorded. The rules are under **Security policies**.

**Status.** A user is **Invited** (has not activated yet), **Active**, or **Suspended** (cannot sign
in; everything they did is kept). Users are never deleted, so the record of who did what stays
complete.

## Inviting a user

1. Sign in as an administrator and open **Users**.
2. Click **Invite user**, enter the person's full name and work email, pick their office and role,
   and click **Create invitation**.
3. A message confirms **"Invitation sent to …"**. The user appears in the list as **Invited**.

If the message instead says the email was **not sent**, it gives the reason. The user is still
created: once email is working again, open the user and click **Resend invite**. (Resending makes
earlier links stop working.)

## What the new user does

1. Opens the email **"You have been invited to Deeds Registry Namibia"** and clicks **Activate my
   account**.
2. Chooses a password of at least 12 characters.
3. Signs in with their email and that password.
4. Scans the QR code with an authenticator app on their phone (or, if they cannot scan, types
   the setup key shown under **"Can't scan? Type the setup key instead"**), then enters the
   6-digit code the app shows.
5. The app opens on their role's start page. From now on, each sign-in asks for the current code
   from the app.

## Changing a user's roles

1. **Users** → the user → **Manage**.
2. Tick or untick roles and click **Save roles**. A duty conflict shows a warning first.
3. The user gets the new access **within 15 minutes**, or straight away if they sign out and in.

You cannot change your own roles, and the app will not let the last active administrator lose
administration rights.

## Suspending and reactivating

- **Users** → the user → **Manage** → **Suspend**. They cannot sign in again, and an open session
  ends at once: their next click takes them to the sign-in page. Use this when someone leaves, or
  their access must stop.
- **Reactivate** gives them back the same roles.
- A user who lost their phone: **Reset MFA**; they scan a new QR code at their next sign-in.

Every invitation, role change, suspension and sign-in is listed under **Access log**.

---

## Checking that it all works (about 20 minutes)

A complete run through inviting, activating, changing roles and suspending, using an email
address you can read.

### Before you start

- **Use a "plus" address.** With Google Workspace, mail for `name+anything@your-domain` is
  delivered to `name@your-domain`. So `info+lrtest1@reitcircles.com` lands in the `info@` inbox,
  but the app treats it as a new user. Use `+lrtest2`, `+lrtest3`… for more test users.
- **Use two browser windows:** a normal one for the administrator and a **private / incognito**
  one for the new user. In the same window, signing in as the new user would sign the
  administrator out.
- **Have an authenticator app** on your phone for the new user.
- **Testing from a laptop through the SSH tunnel:** run `./remoteConnect.sh 4200` on the laptop
  (see `backend/scripts/README.md`). Until the app has a public address, the link in the email
  points to `localhost:4200` and only opens on a machine with the tunnel running.
- **Do not use the demo users** (Elina Shivute, Simon Uirab, …) for this, and never click
  **Resend invite** on them: their addresses are at real government domains.

### The steps

| # | Who | Do | You should see |
|---|---|---|---|
| 1 | Administrator (normal window) | Sign in. **Users → Invite user**: name "LR Test One", email `info+lrtest1@reitcircles.com`, role **Scan operator**, **Create invitation** | "Invitation sent to LR Test One · Emailed to …"; the user listed as **Invited** |
| 2 | You | Open the `info@` inbox | "You have been invited to Deeds Registry Namibia" from `noreply@reitcircles.com`, with an **Activate my account** button |
| 3 | New user (incognito window) | Click the button, choose a password (12+ characters) | The sign-in page, with "Your account is active" |
| 4 | New user | Sign in, scan the QR code, enter the 6-digit code | The app opens on **Capture**. The menu shows only scan-operator screens: Dashboard, Capture, Documents (EDRMS), Process & schema |
| 5 | Administrator | Refresh **Users** | The test user is **Active** and MFA enrolled |
| 6 | Administrator | **Manage** → change the role to **Metadata reviewer** → **Save roles** | Roles saved |
| 7 | New user | Sign out and in again (or wait up to 15 minutes) | The app opens on **Verify metadata**; the menu now also has Verify metadata and Land record. Capture is still listed (reviewers may look) but uploading is disabled |
| 8 | Administrator | **Manage** → tick **Metadata reviewer** and **Auditor · read-only** → **Save roles** | A duty-conflict warning: "Reviewers cannot audit documents they can file". Try **Cancel**, then save anyway |
| 9 | Administrator | **Access log** | Entries for the invitation (invitation emailed), its acceptance, MFA enrolment, sign-ins, and each role change; the conflicting one ends with "duty conflict accepted: Reviewers cannot audit documents they can file" |
| 10 | Administrator | **Manage → Suspend** | The test user cannot sign in, and their open session ends at once (their next click shows "Your session ended"); **Reactivate** restores them with the same roles |
| 11 | Optional | Invite `info+lrtest2@…`, do not accept it, click **Resend invite** | A second email arrives; the link in the first one no longer works |

### If something does not work

| What happens | Why, and what to do |
|---|---|
| Step 1 says the email was **not sent** | The message gives the reason; the technical fix is in `backend/services/identity/README.md` (Email → troubleshooting). Then **Resend invite** |
| No email arrives | Check the spam folder; check the address for typos |
| The link in the email does not open (step 3) | The tunnel is not running on the laptop, or the app is not running on the server |
| "This invitation is invalid or has expired" | The link was already used, is older than 3 days, or a newer one was sent; use **Resend invite** |
| Step 7 still shows the old menu | The session has not refreshed yet; sign out and in |

### Afterwards

Suspend the test users (**Users → Manage → Suspend**): the app does not delete users, and
suspended ones cannot sign in.
