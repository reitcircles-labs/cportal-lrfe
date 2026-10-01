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

**MFA** is required by default: at the first sign-in you scan a QR code with an authenticator
app (Google Authenticator, Authy, 1Password), and every sign-in after that asks for its 6-digit
code.

## Resetting a password (and MFA) from the command line

For when nobody can sign in to do it from the admin screens, e.g. the admin's password or
authenticator is lost. Run from `backend/`:

```bash
npm run reset-password -- admin@deeds.gov.na                # asks for the new password twice (hidden)
npm run reset-password -- admin@deeds.gov.na --from-env     # uses BOOTSTRAP_ADMIN_PASSWORD from .env
npm run reset-password -- admin@deeds.gov.na --reset-mfa    # also re-enrol the authenticator
```

(From any directory: `npm run reset-password -w @lrfe/identity -- <email> [options]`. Without a
terminal, the password is read from the first line of stdin.)

It works directly on the database in `DB_CONNECTION_STRING`, so the service does not need to be
running. It:

- sets the new password (at least 12 characters, as in the app);
- ends the user's open sessions;
- with `--reset-mfa`, clears the enrolled authenticator, so the user scans a new QR code at the
  next sign-in;
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
