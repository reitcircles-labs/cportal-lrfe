# Installing the portal with Docker

The whole application runs in containers, from two images built from this repository and four
standard ones:

| Container | Image | What it is |
|---|---|---|
| web | `lrfe-web:<version>` | The web app, and `/api/...` passed to the gateway. The only one reachable from outside |
| gateway, identity, edrms, bpm, intake, land-records, audit | `lrfe-backend:<version>` | The backend services (one image, each container runs one service) |
| db-setup | `lrfe-backend:<version>` | Runs on every start before the services: sets up the database's schemas and tables, then exits |
| postgres (the default) | `postgres:16.15` | The database. Or an existing PostgreSQL server instead: part B, "An existing PostgreSQL server" |
| nats | `nats:2.15.1-alpine` | The event bus between the services |
| openbao (optional) | `openbao/openbao:2.7.1` | Keys for encrypted files and the audit wallet |
| cardano (optional) | `cardanosolutions/cardano-node-ogmios:v7.0.0_11.0.1-<network>` | Blockchain node for anchoring |

The settings of a site and every secret are in one file, `.env`; no secret is in an image, so the
same images install at every site, also the organisation's name and its offices (`LRFE_ORG_*`,
`LRFE_OFFICES`, below). Data lives in named volumes, so containers can be replaced (for an
upgrade) without losing it.

Part A is done once per version by whoever releases it; parts B to G at each site.

## A. Build and export a version (release machine)

Needs Docker with the compose plugin, Node.js, git and internet access, in a checkout of the source
repository, with the version to release committed.

```bash
deploy/scripts/build.sh                  # → lrfe-backend:0.1.0-5dc1dae and lrfe-web:0.1.0-5dc1dae
deploy/scripts/export.sh 0.1.0-5dc1dae   # → deploy/dist/lrfe-0.1.0-5dc1dae.tar
```

A release is built from the last commit only (`git archive`), so nothing uncommitted or untracked on
the release machine gets into an image. The version defaults to the backend's package version and
the commit; `build.sh 1.2.0` sets one. (`build.sh --worktree` builds the checkout with its
uncommitted changes, for testing; `export.sh` refuses such images.)
`export.sh` adds OpenBao with `--bao` and the blockchain node with `--blockchain` (about 1 GB more;
`CARDANO_NETWORK=preprod` for that network).

The bundle holds `images.tar.gz` (every image, from `docker save`), `docker-compose.yml`,
`.env.example`, `openbao/`, this guide, `docs/` (the guide for the first administrator), `VERSION`
and `SHA256SUMS`. Hand it over with its SHA-256, printed at the end, so the site can check it
arrived unchanged.

To check the application in containers before releasing it, run the end-to-end tests against them:
`npm run test:docker` in `e2e/` of the source repository (see its `e2e/README.md`).

## B. Install at a site (no internet needed)

Needs a Linux server with Docker Engine 23 or later and the compose plugin v2.17 or later (checked
with Engine 23.0.6 and Compose v2.17.3), 4 CPU cores, 8 GB of memory and disk for the documents
(plus 16 GB or more for the blockchain node). Everything below is run as a user allowed to use
Docker, in the folder the bundle is unpacked in.

1. **Unpack and check the bundle:**

   ```bash
   sha256sum lrfe-0.1.0-5dc1dae.tar          # must equal the SHA-256 handed over with it
   tar -xf lrfe-0.1.0-5dc1dae.tar && cd lrfe-0.1.0-5dc1dae
   sha256sum -c SHA256SUMS                    # every file: OK
   docker load -i images.tar.gz               # "Loaded image: lrfe-backend:0.1.0-5dc1dae", …
   ```

2. **Write the settings:**

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   In `.env`, set at least:

   | Setting | Value |
   |---|---|
   | `LRFE_VERSION` | the bundle's version (the `VERSION` file) |
   | `LRFE_PUBLIC_URL` | the address users open, e.g. `https://deeds.example.gov` |
   | `JWT_SECRET`, `POSTGRES_PASSWORD` | each a new random value: `openssl rand -base64 48 \| tr -dc 'A-Za-z0-9'` |
   | `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | the first administrator (password of 12 or more characters) |
   | `MAIL_FROM`, `SMTP_*` | the mail server that sends the invitations. No mail server yet: `MAIL_TRANSPORT=none` and `IDENTITY_EXPOSE_INVITE_LINKS=true`, and the administrator passes each invitation link on (identity does not start with `smtp` and no `SMTP_HOST`) |
   | `EXTRACTION_PROVIDER`, `GEMINI_API_KEY` | the AI that reads the scans |
   | `LRFE_REGISTRY_CODE` | the deeds office's code (in batch and document numbers) |
   | `LRFE_ORG_NAME`, `LRFE_ORG_SUBTITLE`, `LRFE_ORG_PARENT`, `LRFE_ORG_PLACE` | the organisation running the portal (see below) |
   | `LRFE_OFFICES` | the offices created on the empty database, e.g. `KGL=Land Titles Office · Kigali;HYE=Land Titles Office · Huye` |

   **The organisation** is shown in the screens (name and subtitle in the side bar, the parent
   body on the sign-in page, name and place on the dashboard), the invitation emails, the
   authenticator app's entry and evidence packs. `.env.example` holds the first site's texts:
   replace them. An empty setting is not shown; without a name, "Deeds Registry" is used; a
   setting missing from `.env` altogether shows the first site's text. The web
   container reads them on every start (`docker compose up -d` after a change; users reload the
   page). These are display texts, readable by anyone who opens the portal: never a secret. A
   change does not rename the entry already in users' authenticator apps.

   **The offices** (`CODE=Name` pairs, separated by `;`, codes of 2 to 5 capital letters) are
   created only once, on an empty database; empty means none, and the administrator adds them under
   Administration → Offices. After that they are managed there, not in `.env`.

   Keep `.env` private: it holds every secret of the site. Never change `JWT_SECRET` or
   `POSTGRES_PASSWORD` casually: see "Change a secret" below.

3. **Start:**

   ```bash
   docker compose up -d
   docker compose ps          # every container "healthy" after about a minute
   ```

   First `db-setup` sets up the database and exits (`docker compose ps -a`: "Exited (0)"); the
   services start only after it. If it fails, nothing else starts and `docker compose logs db-setup`
   says why (for example a wrong database password).

   The web app answers on `127.0.0.1:8080` (`LRFE_BIND`, `LRFE_HTTP_PORT`). Put HTTPS in front of it
   (part C) before anyone signs in: with `COOKIE_SECURE=true` sign-in needs HTTPS.

4. **Sign in as the first administrator** at `LRFE_PUBLIC_URL`, set up the authenticator app, and
   invite the users: `docs/inviting-users-and-assigning-roles.md` in the bundle (in the source
   repository: `angular-app/docs/user-guide/`). The bootstrap administrator is created only once, on
   an empty database; afterwards `BOOTSTRAP_ADMIN_PASSWORD` can be removed from `.env`.

### An existing PostgreSQL server

By default the portal brings its own PostgreSQL (profile `postgres`, data in the `pgdata` volume).
A site that already runs a PostgreSQL server (16, the version of the bundled one) can use it
instead; no database container runs then.

1. **On the server** (its administrator): a database and a user for the portal, e.g.
   `CREATE USER lrfe PASSWORD '…'; CREATE DATABASE lrfe OWNER lrfe;`. As the owner of the database
   the user creates its schemas itself. A user who may not create schemas needs them created first,
   in that database: `CREATE SCHEMA identity AUTHORIZATION lrfe;`, the same for `edrms`, `bpm`,
   `intake`, `records` and `audit`, and `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (search for
   spelling variants; without it search works, only without them). The server must accept the
   containers' connections (`listen_addresses` and `pg_hba.conf`): a server on another machine by
   its name or address; a server on this machine on an address the containers reach, not
   `127.0.0.1`.
2. **In `.env`**: remove `postgres` from `COMPOSE_PROFILES`, and set `POSTGRES_HOST` (and
   `POSTGRES_PORT`), `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` to the server's.
   `POSTGRES_URL_OPTIONS=?sslmode=require` when the server requires TLS. The password goes into a
   connection address: letters and digits only, or each other character percent-encoded (`@` as
   `%40`).
3. `docker compose up -d`: `db-setup` waits for the server for up to 2 minutes and sets up the
   schemas and tables; run again, it only adds what is missing.

Back up such a database with the server's own backup (part F covers the volumes). Without containers
at all, the same setup runs from the source repository: `npm run db:setup` in `backend/`, with
`DB_CONNECTION_STRING` set (`backend/README.md`).

## C. HTTPS

The web container speaks plain HTTP. HTTPS is ended in front of it, by the site's load balancer or a
web server on the same machine, which passes every request to `http://127.0.0.1:8080` with the
headers `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. For example with nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name deeds.example.gov;
    ssl_certificate     /etc/ssl/deeds/fullchain.pem;
    ssl_certificate_key /etc/ssl/deeds/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 55m;                        # scans up to 50 MB

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
```

With HTTPS, keep `COOKIE_SECURE=true`. Only a test install opened over plain `http://` needs
`COOKIE_SECURE=false` (and `LRFE_BIND=0.0.0.0` to be reached from other machines).

## D. Optional: encrypted files with OpenBao

edrms and intake can encrypt the files they store with keys held by OpenBao; the audit service keeps
its blockchain wallet key there. OpenBao starts **sealed**: it cannot be used until enough key
holders have unsealed it, after every restart of its container.

1. In `.env`: `COMPOSE_PROFILES=postgres,bao` (without `postgres` with an existing database
   server). Then `docker compose up -d`.
2. **Initialise it once**, with the key holders present:

   ```bash
   docker compose exec openbao bao operator init -address=http://127.0.0.1:8200
   ```

   It prints 5 unseal keys and a root token. Give each key to a different named person; any 3 of
   them unseal it. Never store them on this server or in `.env`.
3. **Unseal it** (now and after every restart): three key holders each run `docker compose exec
   openbao bao operator unseal -address=http://127.0.0.1:8200` and type their key.
4. **Prepare it for the portal**: `docker compose run --rm openbao-setup` asks for the root token
   and creates the keys, their policies and one login per service, written into each service's own
   volume. It can be run again at any time; it keeps what works. Afterwards revoke the root token
   (it is asked for, not shown):

   ```bash
   docker compose exec openbao sh -c 'printf "Root token: "; stty -echo; read -r BAO_TOKEN; stty echo; echo; export BAO_TOKEN; bao token revoke -self -address=http://127.0.0.1:8200'
   ```

   Create a new one only when needed, with the key holders (`bao operator generate-root`).
5. In `.env`: `EDRMS_ENCRYPTION=bao` and `INTAKE_ENCRYPTION=bao`. Then `docker compose up -d`.

**How it is protected, and what to know.** OpenBao has no port on the host: it is on a network of
its own that only edrms, intake, audit and the setup reach, and it speaks plain HTTP there. Each
service logs in with its own AppRole, whose secret ID lies in that service's own volume, readable
only by the service; a secret ID does not expire. To replace one (for example after a suspected
leak), delete it and run the setup again: `docker compose run --rm --entrypoint rm openbao-setup
/approle/edrms/secret-id`, then `docker compose run --rm openbao-setup` and `docker compose up -d
--force-recreate edrms` (likewise `intake`, `audit`). The old one keeps working until it is
destroyed in OpenBao, with a token: `bao list auth/approle/role/edrms/secret-id` shows the
accessors, `bao write auth/approle/role/edrms/secret-id-accessor/destroy secret_id_accessor=…`
destroys one.

Files stored before encryption was switched on stay readable as they are; new files are encrypted.
While OpenBao is sealed, edrms and intake wait for it and then restart until it is unsealed. Back up
the `bao-data` volume with the rest (part F): without it encrypted files cannot be read.

## E. Optional: anchoring on the blockchain

The audit service writes the fingerprints of the records to a public blockchain once an hour, signed
with its wallet key in OpenBao (part D first), through its own blockchain node:

1. In `.env`: `COMPOSE_PROFILES=postgres,bao,blockchain` and `CARDANO_NETWORK=preview` (the public test
   network; the production network is not enabled yet). `docker compose up -d`.
2. The node syncs first: about 11 hours and 16 GB for preview. Follow it with `docker compose logs
   -f cardano`.
3. Once synced: `CARDANO_PROVIDER=ogmios` in `.env`, `docker compose up -d`. The wallet's address is
   shown to administrators under **Administration → Anchoring health**; send it funds there.

## F. Upgrade, backup and restore

**Upgrade** to a newer bundle: unpack it next to the current one and load its images (part B, step
1), copy `.env` over from the current folder, set `LRFE_VERSION` to the new version, and run `docker
compose up -d` in the new folder. The containers are replaced; the volumes stay. `db-setup` brings
the tables up to date before the new services start. Going back works the same way, with the old
folder, unless the release notes say a version changed stored data.

From a version without the `LRFE_ORG_*` settings: the portal shows the first site's texts
until they are set; copy them and `LRFE_OFFICES` from the new `.env.example` into `.env` to change
them (existing offices are not changed).

From a version without `db-setup` (0.1.0-260dab4 and earlier): the bundled database is now the
profile `postgres`. Add it to `COMPOSE_PROFILES` in the copied `.env` (e.g.
`COMPOSE_PROFILES=postgres` or `postgres,bao`) before `docker compose up -d`; otherwise `db-setup`
stops with "The bundled database is not running". Those versions always use the bundled database, so
going back to one works only with it, not with an existing server.

**Backup**: stop the services (the database keeps running), save the database and every volume,
start again. In the bundle's folder:

```bash
mkdir -p -m 700 backup && docker compose stop web gateway identity edrms bpm intake land-records audit nats
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup/database.dump
for v in edrms-files intake-files natsdata bao-data bao-edrms bao-intake bao-audit; do
  docker run --rm --user 0 --entrypoint tar -v "lrfe_$v:/v:ro" -v "$PWD/backup:/b" \
    "lrfe-backend:$(grep ^LRFE_VERSION= .env | cut -d= -f2)" -czf "/b/$v.tgz" -C /v .
done
docker compose up -d
```

With an existing database server, leave out the `pg_dump` line and back up the database with the
server's own backup while the services are stopped. With OpenBao, stop it too before saving
(`docker compose stop openbao`), so its data is saved consistently; after `docker compose up -d` the key holders unseal it again. `bao-data` is OpenBao's
(sealed) data; `bao-edrms`, `bao-intake` and `bao-audit` hold each service's OpenBao login. Without
OpenBao they are empty and cost nothing. Keep the backup and a copy of `.env` safely, readable only
by those who run the site: together they hold every secret.

**Restore** on a new server: install the same version (part B, steps 1 and 2, with the saved
`.env`), then, before the first full start:

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backup/database.dump
for v in edrms-files intake-files natsdata bao-data bao-edrms bao-intake bao-audit; do
  docker volume create "lrfe_$v" >/dev/null
  docker run --rm --user 0 --entrypoint tar -v "lrfe_$v:/v" -v "$PWD/backup:/b:ro" \
    "lrfe-backend:$(grep ^LRFE_VERSION= .env | cut -d= -f2)" -xzf "/b/$v.tgz" -C /v
done
docker compose up -d
```

With an existing database server, restore its backup there instead of the first two lines. With
OpenBao (profile `bao`): after the restore loop, start it alone with `docker compose up -d
openbao`, have three key holders unseal it (part D, step 3), and only then run `docker compose up
-d`. Otherwise edrms and intake wait for it and restart until it is unsealed.

## G. Running it

| Task | Command (in the bundle's folder) |
|---|---|
| Status and health | `docker compose ps` |
| Logs of a service | `docker compose logs -f --tail 100 audit` (kept: 5 × 10 MB per container) |
| Restart one service | `docker compose restart intake` |
| Stop / start everything | `docker compose stop` / `docker compose up -d` |
| Which version runs | `docker image inspect lrfe-backend:<version> --format '{{index .Config.Labels "org.opencontainers.image.version"}}'` |

**Before a demo** (on the development server): `node demo/check-readiness.mjs` checks the containers, the apps,
the demo users, the AI, the demo documents and the data, and says what is not ready (`demo/README.md`).

**API docs (Swagger UI).** For a demo or the site's developers: add `docs` to `COMPOSE_PROFILES`
(e.g. `COMPOSE_PROFILES=postgres,docs`) and run `docker compose up -d`. The docs answer on
`127.0.0.1:3510` by default (`LRFE_DOCS_PORT`, on `LRFE_BIND` like the web app). "Try it out" goes through the
gateway (all endpoints, `/api/...`) or straight to one service (`/direct/<name>/...`). For calls that
need a user, sign in with `POST /api/auth/login` and `POST /api/auth/mfa`, copy `accessToken`, and
choose **Authorize**. The page loads Swagger UI from a public CDN, so the browser needs internet
access. It shows every endpoint of the installation; leave the profile off where that is not wanted.

**Change a secret.** `JWT_SECRET`: change it in `.env` and run `docker compose up -d`; everyone
signs in again. `POSTGRES_PASSWORD`: the database keeps the password it was created with, so change
it there first, then in `.env`, then run `docker compose up -d`. In the bundled database: `docker
compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`, then `ALTER USER <user>
PASSWORD '…';`. On an existing server, its administrator changes it.

**Volumes** are named after the compose project, `lrfe`: `lrfe_pgdata`, `lrfe_edrms-files`, … .
`docker compose down` keeps them; **`docker compose down -v` deletes every record and document**.
