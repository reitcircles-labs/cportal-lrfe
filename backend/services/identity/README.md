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
| `IDENTITY_EXPOSE_INVITE_LINKS`, `IDENTITY_INVITE_URL_BASE` | dev only: return invitation links to the admin, since no email is sent yet |

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
| `src/crypto.js`, `src/totp.js` | scrypt passwords, TOTP (RFC 6238) |
| `src/repo/` | Postgres (Sequelize) and in-memory stores |
