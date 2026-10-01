# identity service

Sign-in with MFA, sessions, users, roles, security policies and the admin access log, on port
3501. The browser reaches it through the gateway (`/api/auth`, `/api/users`, …). The API and the
design decisions are described in the [backend README](../../README.md#identity-api-via-gateway);
every endpoint with its parameters and access rule is in [docs/openapi.yaml](docs/openapi.yaml)
(`npm run docs:serve` in backend/ to browse it).

## Running

```bash
cd backend
npm run dev:identity               # or `npm run dev` for all services
npm run seed:identity              # optional: create the schema, roles and admin without starting the service
npm test -w @lrfe/identity         # no database needed
```

Settings come from `services/identity/.env` (copy `backend/.env_example`):

| Setting | Meaning |
|---|---|
| `PORT` | 3501 |
| `IDENTITY_STORE` | `postgres`, or `memory` (no database, data lost on restart) |
| `DB_CONNECTION_STRING`, `DB_SYNC` | Postgres; `DB_SYNC=true` creates the `identity` schema and tables on start |
| `JWT_SECRET` | signs access tokens; must be the same in every service |
| `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | the first administrator (see below) |
| `SEED_DEMO_PASSWORD` | when set, creates the 14 fictitious demo users with this password |
| `COOKIE_SECURE` | `false` only while serving over plain `http://localhost` |
| `IDENTITY_INVITE_URL_BASE` | start of the link in invitation emails: the address users open the app at, e.g. `https://lr.example.com/#/invite` |
| `IDENTITY_EXPOSE_INVITE_LINKS` | dev only: also show the invitation link to the admin (needed while email is not set up) |
| `MAIL_TRANSPORT`, `MAIL_FROM`, `SMTP_*` | invitation email, see [Email](#email-invitations) |

## First sign-in

**The bootstrap administrator** (`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`) is created
**once**, when the service starts and the database has **no users at all**. After that the
`BOOTSTRAP_ADMIN_*` settings are ignored: changing `BOOTSTRAP_ADMIN_PASSWORD` later does **not**
change the admin's password. Use the reset command below instead.

**Demo users** are created when `SEED_DEMO_PASSWORD` is set: any of the 14 that don't exist yet
get that password (existing users are never changed). For example `p.hamutenya@deeds.gov.na`
(administrator), `d.garoeb@deeds.gov.na` (scan operator + reviewer), `a.mwandingi@deeds.gov.na`
(reviewer). The full list is in `src/seed.js`. They are fictitious and share one password, so
never enable them where real staff can sign in.

## Email (invitations)

When an administrator invites a user (or clicks **Resend invite**), identity emails them the
activation link. The user is created even if the email fails; the admin sees whether it was
sent and, if not, why (wrong password, server unreachable, …), and the access log records it.
The link is a one-time credential: it is never written to logs or events.

Set in `services/identity/.env`, then restart identity. At start-up identity logs whether the
mail server accepted the connection and login (`email: … accepted the connection`).

| Setting | Meaning |
|---|---|
| `MAIL_TRANSPORT` | `smtp` to send; `file` (development) to write each email as an `.eml` file into `MAIL_FILE_DIR` (default `./tmp/mail`); `none` (default) to send nothing |
| `MAIL_FROM` | sender, e.g. `"Deeds Registry <noreply@reitcircles.com>"` (quote it); must be allowed to send through the SMTP server |
| `MAIL_REPLY_TO` | optional reply address, e.g. a support mailbox |
| `SMTP_HOST`, `SMTP_PORT` | the mail server; 587 (or 2525) upgrades to TLS, 465 is TLS from the start |
| `SMTP_USER`, `SMTP_PASSWORD` | the SMTP login (keep out of the repository: `.env` is git-ignored) |
| `SMTP_REQUIRE_TLS` | `true` (default): refuse to send over an unencrypted connection. `false` only for a relay on the same machine |
| `SMTP_HELO_NAME` | the name this server introduces itself with; set it to its FQDN, `cserver.reitcircles.com` (the hostname `rc-cardano` is not one, and Google refuses the placeholder used instead) |
| `SMTP_FAMILY` | `4` to always connect over IPv4 (needed for an IP-allowlisted relay: this server also has IPv6 and would otherwise sometimes use it); empty for either |
| `IDENTITY_INVITE_URL_BASE` | the app's address as users reach it, so the link in the email works for them |

### Choosing the mail server

`reitcircles.com` already authorises **Google Workspace** and **Elastic Email** to send its mail
(its SPF record), so either delivers well without DNS changes. Nothing has to be "registered" for
the app itself; it only needs an SMTP server that accepts it. In order of preference:

| Option | Credentials in `.env` | Who sets it up |
|---|---|---|
| A. Google Workspace **SMTP relay**, allowed by this server's IP (recommended) | none | Workspace administrator, once |
| B. A Google Workspace mailbox with an **app password** | mailbox + app password | the mailbox owner |
| C. Elastic Email | SMTP user + password | Elastic Email account owner |
| D. Postfix on this server | none | server administrator (sudo) and DNS |

#### A. Google Workspace SMTP relay (recommended)

The Workspace administrator allows this server's IP address once; the app then sends without any
password, so there is nothing to leak, rotate or break when a mailbox password changes.

1. In the Google **Admin console**: **Apps → Google Workspace → Gmail → Routing → SMTP relay
   service → Configure** (or **Add another rule**):
   - **Allowed senders:** *Only addresses in my domains*
   - **Authentication:** tick *Only accept mail from the specified IP addresses*, **Add IP range**:
     `95.216.13.114` (this server, `cserver.reitcircles.com`)
   - **Encryption:** tick *Require TLS encryption*
   - **Save.** It can take up to about an hour to take effect.
2. In `services/identity/.env`:
   ```ini
   MAIL_TRANSPORT=smtp
   MAIL_FROM="Deeds Registry <noreply@reitcircles.com>"   # must be an address in the domain
   SMTP_HOST=smtp-relay.gmail.com
   SMTP_PORT=587
   SMTP_HELO_NAME=cserver.reitcircles.com   # Google refuses a greeting without a real host name
   SMTP_FAMILY=4                            # the rule lists the IPv4 address; this server also has IPv6
   # no SMTP_USER / SMTP_PASSWORD: Google recognises the server by its IP address
   ```
3. Restart identity and check its log for `email: SMTP smtp-relay.gmail.com:587 over IPv4 accepted
   the connection and login`. Then invite yourself (another address) to test.
4. Before inviting real users, set `IDENTITY_INVITE_URL_BASE` to the address they open the app at.
   The default `http://localhost:4200/#/invite` only works for someone using the app through the
   SSH tunnel (`scripts/remoteConnect.sh`).

If the server ever moves to another IP address, update the relay rule. (Instead of `SMTP_FAMILY=4`
you can also add the server's IPv6 address, `2a01:4f9:2a:d87::2`, to the rule.)

This setup was tested on 1 October 2026: the relay accepted mail from this server over IPv4.

#### B. Google Workspace mailbox with an app password

Google no longer accepts a mailbox's normal password over SMTP ("less secure apps" are switched off
for Workspace); an **app password** is a 16-character password Google generates for one mailbox.

1. Use a dedicated mailbox, e.g. `noreply@reitcircles.com` (it needs a Workspace licence), not a
   person's account.
2. Turn on **2-Step Verification** for that mailbox. The administrator must allow it: Admin console
   → **Security → Authentication → 2-step verification**.
3. Signed in as that mailbox, open **https://myaccount.google.com/apppasswords**, enter a name
   (e.g. `cportal-lrfe identity`) and click **Create**. Copy the 16 characters: Google shows them
   only once.
4. In `services/identity/.env`:
   ```ini
   MAIL_TRANSPORT=smtp
   MAIL_FROM="Deeds Registry <noreply@reitcircles.com>"   # the same mailbox
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=noreply@reitcircles.com
   SMTP_PASSWORD=abcdefghijklmnop                         # the app password, without spaces
   ```
5. Restart identity and check the log line as above.

Notes: if the app-passwords page says the setting is not available, 2-Step Verification is off or
the administrator does not allow app passwords. **Changing the mailbox's password revokes its app
passwords**: email then stops (the admin sees "refused the SMTP username or password") until a new
one is created.

#### C. Elastic Email

`SMTP_HOST=smtp.elasticemail.com`, `SMTP_PORT=2525`, `SMTP_USER` and `SMTP_PASSWORD` from the
account's SMTP settings, `MAIL_FROM` a verified sender address.

#### D. Postfix on this server

Possible, but needs a server administrator: start Postfix (installed, stopped), set the server's
reverse DNS to `cserver.reitcircles.com` (Hetzner console; it is the generic
`static.114.13.216.95.clients.your-server.de` today), add the server's IP to the `reitcircles.com`
SPF record and set up DKIM signing; otherwise mail lands in spam. Then `SMTP_HOST=127.0.0.1`,
`SMTP_PORT=25`, `SMTP_REQUIRE_TLS=false`, no user.

### Checking and troubleshooting

| What the admin or the log shows | Meaning and fix |
|---|---|
| `email: … accepted the connection and login` (identity log at start-up) | Working |
| `email: not configured (MAIL_TRANSPORT=none)` | Set `MAIL_TRANSPORT=smtp` and the settings above |
| "refused the SMTP username or password" | Wrong user or app password, or the app password was revoked (B); with the relay (A) leave `SMTP_USER` empty |
| "could not be reached" | Wrong `SMTP_HOST`/`SMTP_PORT`, or outbound mail ports blocked |
| "refused this server's greeting (421 at EHLO)" | The server introduced itself without a real host name: set `SMTP_HELO_NAME` to the FQDN |
| "refused the address: 550-5.7.1 Invalid credentials for relay [address]" with the relay (A) | The relay does not recognise the address the server connected from: set `SMTP_FAMILY=4` (or add the IPv6 address to the rule), check the IP in the rule, or wait up to an hour after changing it |
| "does not offer an encrypted connection (STARTTLS)" | Wrong port or host; use 587 or 465 |
| "refused the address" / "refused the message" | The sender in `MAIL_FROM` is not allowed (relay: must be in your domain; mailbox: must be that mailbox), or the relay rule does not list this server's IP |
| The email arrives, but the link does not open | `IDENTITY_INVITE_URL_BASE` is not the address users reach the app at |

A user who did not get the email: fix the setting, restart identity, then **Users → the user →
Resend invite** (earlier links stop working).

Development without a mail server: `MAIL_TRANSPORT=file` and open the `.eml` files from `tmp/mail`.

## Setting up MFA (the 6-digit code)

MFA is required by default (**Admin → Security policies**). Nobody generates codes for users:
each user links an authenticator app to their account once, at their first sign-in, and the app
produces the codes from then on.

1. Sign in with email and password (invited users: after accepting the invitation).
2. The screen shows **"Set up your authenticator"** with a **QR code**.
3. In an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy,
   1Password): **Add account → Scan a QR code**, and point the camera at the screen.
   - Signing in on the phone itself? Tap **"On this phone? Open it in the authenticator app instead"**.
   - Camera not possible? Open **"Can't scan? Type the setup key instead"**: choose **Enter a setup
     key** in the app, type (or **Copy**) the key, and choose **time-based** if asked.

   The QR code is drawn in the browser; the secret is not sent anywhere else.
4. Type the 6-digit code the app shows (it changes every 30 seconds). You are signed in.
5. Every later sign-in asks for the app's current code.

**Lost phone:** an administrator opens **Users → the user → Reset MFA**; the user sets up the app
again at their next sign-in. For the only administrator, see below.

**Local development only:** MFA can be switched off under Admin → Security policies.

## The admin cannot sign in

The password in `.env` does not work (it was changed after the admin was created), or the
authenticator from the admin's first sign-in is lost. From `backend/`:

```bash
npm run reset-password -- admin@deeds.gov.na --from-env --reset-mfa
```

This sets the admin's password to `BOOTSTRAP_ADMIN_PASSWORD` and clears the old authenticator.
Then sign in with that password and set up MFA as above. If the authenticator still works and
only the password is wrong, leave out `--reset-mfa`.

## Resetting a password (and MFA) from the command line

For when nobody can sign in to do it from the admin screens, e.g. the admin's password or
authenticator is lost. Run from `backend/`:

```bash
npm run reset-password -- admin@deeds.gov.na                # asks for the new password twice (hidden)
npm run reset-password -- admin@deeds.gov.na --from-env     # uses BOOTSTRAP_ADMIN_PASSWORD from .env
npm run reset-password -- admin@deeds.gov.na --reset-mfa    # also re-enrol the authenticator
npm run reset-password -- admin@deeds.gov.na --from-env --reset-mfa   # both: the usual admin fix
```

(From any directory: `npm run reset-password -w @lrfe/identity -- <email> [options]`. Without a
terminal, the password is read from the first line of stdin.)

It works directly on the database in `DB_CONNECTION_STRING`, so the service does not need to be
running. It:

- sets the new password (at least 12 characters, as in the app);
- ends the user's open sessions;
- with `--reset-mfa`, clears the enrolled authenticator, so the user is shown a new QR code at
  the next sign-in;
- records "Password reset" (and "MFA reset") in the access log, by "System (command line)".

It does not change the user's status or roles. It warns when the user still cannot sign in
(suspended, or invitation not yet accepted), and changes nothing for an unknown email or a short
password.

Anyone who can run this command can take over any account, so on a shared server limit who
has shell access and can read `.env`. Administrators who can sign in should use the admin
screens instead: **Users → user → Reset MFA** (passwords are set by users themselves, when
they accept an invitation).

## Code

| Path | What |
|---|---|
| `src/identity.service.js` | sign-in, MFA, sessions, users, roles, policies |
| `src/routes.js` | HTTP API |
| `src/catalogue.js` | the fixed permissions, six roles and segregation-of-duties rules |
| `src/seed.js` | roles, policies, bootstrap admin, demo users (runs on every start; idempotent) |
| `src/reset-password.js`, `scripts/reset-password.js` | the reset command |
| `src/mailer.js` | outgoing email (SMTP / file / none) and the invitation email |
| `src/crypto.js`, `src/totp.js` | scrypt passwords, TOTP (RFC 6238) |
| `src/repo/` | Postgres (Sequelize) and in-memory stores |
