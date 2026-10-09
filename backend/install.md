# Installing the backend on a server

How to set up the six backend services on one server whose PostgreSQL accepts **local
connections only**, with every service reachable only from the server itself, and stored files
encrypted with keys from OpenBao. This is how the
development/test server is set up (checked on 9 October 2026). The browser reaches the app through
nginx and the gateway; testers on a laptop use the SSH tunnel.

| Service | Port | PostgreSQL schema |
|---|---|---|
| gateway | 3500 | none |
| identity | 3501 | `identity` |
| edrms | 3502 | `edrms` |
| bpm | 3503 | `bpm` |
| intake | 3504 | `intake` |
| land-records | 3505 | `records` |

Needs: Node ≥ 20 and PostgreSQL 15 on the same machine.

## 1. PostgreSQL: local only, one user for the app

1. **Listen on localhost only.** In `postgresql.conf`: `listen_addresses = 'localhost'`. In
   `pg_hba.conf`, allow only local and `127.0.0.1/32` / `::1/128` connections. Restart PostgreSQL.
   Check with `ss -ltn | grep 5432`: it must show `127.0.0.1:5432` only.
2. **The app's user and database.** As the database owner (or `postgres`):

   ```sql
   CREATE ROLE ladmin LOGIN PASSWORD '…';
   CREATE DATABASE testdb OWNER nsaha;          -- or an existing database
   ```

3. **One schema per service, owned by the app's user.** The app's user may not create schemas
   itself (it has no CREATE right on the database), so the owner creates them once:

   ```sql
   \c testdb
   CREATE SCHEMA identity AUTHORIZATION ladmin;
   CREATE SCHEMA edrms    AUTHORIZATION ladmin;
   CREATE SCHEMA bpm      AUTHORIZATION ladmin;
   CREATE SCHEMA intake   AUTHORIZATION ladmin;
   CREATE SCHEMA records  AUTHORIZATION ladmin;
   ```

   For example: `sudo -u postgres psql -d testdb -c "CREATE SCHEMA records AUTHORIZATION ladmin;"`.
   Each service creates its own tables in its schema on first start (step 5).

Without its schema a service stops at start with *Schema "…" does not exist and this database user
may not create it*.

## 2. One `.env` per service

Each service reads the `.env` in its own folder (`services/<name>/.env`), also under `npm run dev`.
A service without one does not start. Create all six from the template:

```bash
cd backend
for s in gateway identity edrms bpm intake land-records; do cp -n .env_example services/$s/.env; done
chmod 600 services/*/.env
```

The template holds the settings of every service; each service reads only its own. `.env` files
are in `.gitignore` and must never be committed. In each file set:

| Setting | Value | Why |
|---|---|---|
| `HOST` | `127.0.0.1` | The template's `0.0.0.0` (all interfaces) is for containers. On a server with a public address it would expose the service to the internet |
| `PORT` | the service's port (table above) | |
| `JWT_SECRET` | the same new random value in every file (see step 3) | |
| `DB_CONNECTION_STRING` | `postgres://ladmin:…@localhost:5432/testdb` | All services except the gateway; they share the database, each in its own schema |
| `<SERVICE>_STORE` | `postgres` | `IDENTITY_STORE`, `EDRMS_STORE`, `BPM_STORE`, `INTAKE_STORE`, `RECORDS_STORE` |
| `DB_SYNC` | `true` | Creates the service's tables on start (development and test; real migrations before production) |

Service-specific settings (storage folders, mail, the AI provider, …) are described in the
template's comments and in each service's README. For land-records, besides the shared ones:
`RECORDS_COUNTRY_CODE=NA`, `EDRMS_URL=http://localhost:3502`, `BPM_URL=http://localhost:3503`.

## 3. The JWT secret: one random value in every service

identity signs every access token with `JWT_SECRET`, and every service checks tokens with it. Anyone
who knows it can make their own token with any permission, so it must be **random and secret**,
never the template's or a well-known example value, and **the same in every service** (otherwise
the services refuse each other's tokens).

Set a new one in all files at once, without printing it:

```bash
cd backend
NEW=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')
for f in .env services/*/.env; do [ -f "$f" ] && sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$NEW|" "$f"; done
unset NEW

# check: one line, counting every file (the same secret everywhere), without showing it
for f in .env services/*/.env; do grep '^JWT_SECRET=' "$f" | sha256sum | cut -c1-8; done | sort | uniq -c
```

`backend/.env` is used by `docker compose` and scripts run from `backend/`; keep it in step too.
Changing the secret later works the same way. Restart the services afterwards; everyone then has
to sign in again.

## 4. Stored files encrypted with OpenBao (on by default)

edrms (filed documents) and intake (scans) encrypt the files they store with keys protected by
OpenBao (design: [`packages/storage/README.md`](packages/storage/README.md)). The other services
store no files.

1. **Set up the development vault once:**

   ```bash
   cd backend
   npm run bao -- --dev
   ```

   The first run downloads OpenBao into `backend/.tools/`, starts it on `127.0.0.1:8200`, creates
   the keys (`edrms-files`, `intake-files`), their policies and a login (AppRole) per service, and
   prints the settings for the two services. Its data, unseal key and the services' secret IDs live
   in `~/data/cportal-lrfe/openbao/`, outside git, readable by this user only. Stop it with Ctrl+C:
   `npm run dev` starts it from now on. (Production is set up differently: see
   [OpenBao production rules](scripts/README.md#production-rules).)

2. **Put the printed settings into the two `.env` files**, with encryption on:

   ```bash
   # services/edrms/.env
   EDRMS_ENCRYPTION=bao
   BAO_ADDR=http://127.0.0.1:8200
   BAO_ROLE_ID=…                 # as printed for edrms
   BAO_SECRET_ID_FILE=/home/<user>/data/cportal-lrfe/openbao/approle/edrms-secret-id
   BAO_KEY_NAME=edrms-files

   # services/intake/.env
   INTAKE_ENCRYPTION=bao
   BAO_ADDR=http://127.0.0.1:8200
   BAO_ROLE_ID=…                 # as printed for intake
   BAO_SECRET_ID_FILE=/home/<user>/data/cportal-lrfe/openbao/approle/intake-secret-id
   BAO_KEY_NAME=intake-files
   ```

   Running `npm run bao -- --dev` again prints the same settings; it never replaces working ones.

With either service on `bao`, `npm run dev` starts OpenBao first (prefixed `bao │`), and the
service logs in and requests a data key before it starts. Files stored before encryption was
switched on stay readable as they are; only files stored afterwards are encrypted. To switch it
off, set `EDRMS_ENCRYPTION=off` / `INTAKE_ENCRYPTION=off`. `.env_example` keeps encryption off,
because a service set to `bao` does not start without its login settings.

## 5. First start

```bash
cd backend
npm install
npm run dev          # all services + NATS + OpenBao (edrms and intake encrypt with it); Ctrl+C stops
```

On the first start each service creates its tables, and identity creates the roles and the
bootstrap administrator (`BOOTSTRAP_ADMIN_*`, see [identity](services/identity/README.md#first-sign-in)).

With `EXTRACTION_PROVIDER=gemini` and `INTAKE_RUN_WORKER=true`, intake starts reading any queued
scans with the AI at once, which costs money. Set `INTAKE_RUN_WORKER=false` for a start that should
not do that.

## 6. Check it

```bash
# every service answers
for p in 3500 3501 3502 3503 3504 3505; do curl -s http://127.0.0.1:$p/health; echo; done

# every service listens on 127.0.0.1 only (no 0.0.0.0 or public address)
ss -ltn | grep -E ':350[0-5]\b'

# OpenBao only on localhost (while npm run dev runs)
ss -ltn | grep 8200

# PostgreSQL only on localhost, and each schema has its tables
ss -ltn | grep 5432
psql "postgres://ladmin:…@localhost:5432/testdb" -c '\dt identity.*' -c '\dt records.*'
```

Then sign in to the app as the bootstrap administrator.

## 7. Reaching the app

- **Browser:** nginx serves the app over HTTPS and passes `/api` to the gateway on `127.0.0.1:3500`.
  See [Serving the app over HTTPS](services/identity/README.md#serving-the-app-over-https-nginx).
- **Testers' laptops:** the SSH tunnel forwards the ports to `127.0.0.1` on the server. See
  [remoteConnect.sh](scripts/README.md#remoteconnectsh-test-the-app-from-your-laptop).
- **OpenBao** (installation rules, backups, production): see [OpenBao](scripts/README.md#openbao-installation-rules).

## When something does not work

| What happens | Why, and what to do |
|---|---|
| A service stops at once with `JWT_SECRET` missing | Its folder has no `.env`, or the file lacks the setting: step 2 |
| *Schema "…" does not exist and this database user may not create it* | The owner has not created that schema: step 1.3 |
| *password authentication failed for user …* | Wrong user or password in that `DB_CONNECTION_STRING` |
| *connect ECONNREFUSED 127.0.0.1:5432* | PostgreSQL is not running, or not listening on localhost |
| Signed-in users get 401 everywhere | The services do not share the same `JWT_SECRET` (check in step 3), or it was just changed: sign in again |
| edrms or intake exits with *OpenBao at … is sealed or unreachable* | The vault is not running: start the services with `npm run dev` (which starts it), or run `npm run bao -- --dev` |
| edrms or intake exits with *startup check failed* | Wrong `BAO_ROLE_ID` or secret ID file: copy the settings again from `npm run bao -- --dev` (step 4) |
| A port shows `0.0.0.0` in `ss -ltn` | That service's `.env` still has `HOST=0.0.0.0`: set `127.0.0.1` and restart it |
