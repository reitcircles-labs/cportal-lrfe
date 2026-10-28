# Installing the portal with Docker

The whole application runs in containers, from two images built from this repository and four
standard ones:

| Container | Image | What it is |
|---|---|---|
| web | `lrfe-web:<version>` | The web app, and `/api/...` passed to the gateway. The only one reachable from outside |
| gateway, identity, edrms, bpm, intake, land-records, audit, extracts | `lrfe-backend:<version>` | The backend services (one image, each container runs one service) |
| db-setup | `lrfe-backend:<version>` | Runs on every start before the services: sets up the database's schemas and tables, then exits |
| postgres (the default) | `postgres:16.15` | The database. Or an existing PostgreSQL server instead: part B, "An existing PostgreSQL server" |
| nats | `nats:2.15.1-alpine` | The event bus between the services |
| openbao (the default) | `openbao/openbao:2.7.1` | Keys for the stored files, encrypted at rest, and the audit wallet |
| cardano (optional) | `cardanosolutions/cardano-node-ogmios:v7.0.0_11.0.1-<network>` | Blockchain node for anchoring |
| opensearch (optional) | `opensearchproject/opensearch:3.9.0` | The search engine for the documents' text (part I) |

The settings of a site and every secret are in one file, `.env`; no secret is in an image, so the
same images install at every site, also the organisation's name and its offices (`LRFE_ORG_*`,
`LRFE_OFFICES`, below). Data lives in named volumes, so containers can be replaced (for an
upgrade) without losing it.

Part A is done once per version by whoever releases it; parts B to G at each site, H and I when
the site uses the search engine.

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
The bundle always holds OpenBao (stored files are encrypted with its keys by default); `export.sh`
adds the blockchain node with `--blockchain` (about 1 GB more; `CARDANO_NETWORK=preprod` for that
network).

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

   Stored files are encrypted at rest with keys from OpenBao by default: on a new install, edrms,
   intake and extracts become healthy only once OpenBao is initialised, unsealed and prepared
   (part D, steps 2 to 4, right after this first start).

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

## D. Encryption at rest with OpenBao (on by default)

edrms, intake and extracts encrypt every file they store (the scans, the filed documents, the
extract PDFs) with keys held by OpenBao; the audit service keeps its blockchain wallet key there.
This is the default: `COMPOSE_PROFILES=postgres,bao` and `EDRMS_ENCRYPTION`, `INTAKE_ENCRYPTION`
and `EXTRACTS_ENCRYPTION` set to `bao` in `.env.example` (and `bao` when unset). OpenBao starts
**sealed**: it cannot be used until enough key holders have unsealed it, after every restart of
its container.

1. In `.env`: `COMPOSE_PROFILES=postgres,bao` (the default; without `postgres` with an existing
   database server). Then `docker compose up -d`.
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
5. In `.env`: `EDRMS_ENCRYPTION=bao`, `INTAKE_ENCRYPTION=bao` and `EXTRACTS_ENCRYPTION=bao` (the
   defaults). Then `docker compose up -d`. An install whose OpenBao was prepared before the extract
   PDFs were encrypted has no key `extracts-files` yet: run `docker compose run --rm openbao-setup`
   again first (it keeps what works).
6. **The organisation seal on ownership extracts.** The setup also creates the key `extracts-seal`
   (ECDSA P-256, never exportable) and the extracts service's login: every extract's PDF is sealed
   with it, inside OpenBao. An install whose OpenBao was prepared before this version has neither:
   run `docker compose run --rm openbao-setup` again first (it keeps what works). The
   registry needs a seal certificate for that key from its certificate authority; the key's public
   key is shown by `bao read transit/keys/extracts-seal` (with a token). Put the certificate in
   `.env` as `LRFE_SEAL_CERT` (PEM on one line, `\n` for each line break), set `LRFE_SEAL=bao`, then
   `docker compose up -d`. Until then no extract can be issued (staff are told the seal is not set
   up); a certificate for another key is refused before anything is signed.

**How it is protected, and what to know.** OpenBao has no port on the host: it is on a network of
its own that only edrms, intake, audit, extracts and the setup reach, and it speaks plain HTTP there. Each
service logs in with its own AppRole, whose secret ID lies in that service's own volume, readable
only by the service; a secret ID does not expire. To replace one (for example after a suspected
leak), delete it and run the setup again: `docker compose run --rm --entrypoint rm openbao-setup
/approle/edrms/secret-id`, then `docker compose run --rm openbao-setup` and `docker compose up -d
--force-recreate edrms` (likewise `intake`, `audit`, `extracts`). The old one keeps working until it is
destroyed in OpenBao, with a token: `bao list auth/approle/role/edrms/secret-id` shows the
accessors, `bao write auth/approle/role/edrms/secret-id-accessor/destroy secret_id_accessor=…`
destroys one.

Files stored before encryption was switched on stay readable as they are; new files are encrypted.
That includes the sealed extract PDFs in the `extracts-files` volume (key `extracts-files`), which
hold the owners' names and shares. Only a fresh install has encrypted files only.

**Switching it off** is possible, on purpose only: `EDRMS_ENCRYPTION=off` (likewise `INTAKE_` and
`EXTRACTS_`) stores that service's new files as plain files in its volume, readable by anyone who
can read the volume or its backups. Files already encrypted cannot be opened while it is off:
switch it back to `bao` to read them.
While OpenBao is sealed, edrms, intake and extracts wait for it and then restart until it is
unsealed. Back up the `bao-data` volume with the rest (part F): without it encrypted files cannot
be read.

## E. Optional: anchoring on the blockchain

The audit service writes the fingerprints of the records to a public blockchain once an hour, signed
with its wallet key in OpenBao (part D first), through its own blockchain node:

1. In `.env`: `COMPOSE_PROFILES=postgres,bao,blockchain` and `CARDANO_NETWORK=preview` (the public test
   network; the production network is not enabled yet). `docker compose up -d`.
2. The node syncs first: about 11 hours and 16 GB for preview. Follow it with `docker compose logs
   -f cardano`. With another synced node of the same version at hand (cardano-node 11.0.1, the same
   network), copy its data instead: `docker compose --profile blockchain create cardano`, then
   `rsync -a --exclude=/lock <other node>/db/ "$(docker volume inspect lrfe_cardano-db --format
   '{{.Mountpoint}}')/"` before starting it (the volume's name begins with the compose project's
   name; with Docker run as root, prefix `sudo`). The other node may keep running: its data is only read,
   but then this node checks the whole copy on its first start (about 1.5 hours for preview), before it
   catches up. Copied from a node that was shut down cleanly, it starts at once.
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

From a version that kept the AI's page text in the database (before API-798): intake moves it
into encrypted files beside the scans by itself when it starts (while OpenBao is sealed it tries
again every minute; its log says "page text moved into encrypted files"). Documents filed before
then have no page text in the EDRMS yet; once intake has moved it, copy it there once with
`docker compose exec intake node services/intake/scripts/backfill-text.js`. It prints how many
documents got their text and which ones failed, and can be run again: it adds only what is
missing. Going back to an older version afterwards shows no AI transcription in Verify.

**What intake keeps of a filed document (API-807).** Once a document is filed and the EDRMS holds
it completely (its version 1.0 with the same scan, and its page text when the AI read any), intake
clears its own copy right after the filing: the fields, the notes, the page text and the AI's
answers go from intake's database, and the scan and its page-text file from intake's file store
(the `intake-files` volume or bucket). The EDRMS keeps all of it: the scan, the page text and, with
version 1.0 (sealed), the AI's reading (evidence, page, legibility and checks of each field, and
every earlier reading). The history, the AI's cost and documents in review or rejected stay in
intake as they are. Intake keeps a small record of each filed document (its reference, property and
review counts, API-815), so Verify's Filed list still shows and finds it, and still opens it: its
scan comes from the EDRMS. This saves about 35 KB a document (measured on the 199,470-document test
register: 6.4 GB of files in 398,940 files, and 700 MB of intake's database after `VACUUM FULL`;
about 105 GB at 3 million documents).
When the EDRMS's copy is incomplete, or the clearing fails, nothing is cleared and intake logs the
document's id. From an earlier version, clear the documents filed before once with
`docker compose exec intake node services/intake/scripts/clear-filed.js` (after `backfill-text.js`
above, when coming from before API-798). It prints how many documents it cleared, skipped because
their EDRMS copy is incomplete, or found already cleared, and can be run again (about 100
documents a second). PostgreSQL reuses the freed space by itself; to give it back to the disk at
once, run `VACUUM FULL intake.document, intake.extraction` in a quiet hour (it locks the tables).

From a version without `db-setup` (0.1.0-260dab4 and earlier): the bundled database is now the
profile `postgres`. Add it to `COMPOSE_PROFILES` in the copied `.env` (e.g.
`COMPOSE_PROFILES=postgres` or `postgres,bao`) before `docker compose up -d`; otherwise `db-setup`
stops with "The bundled database is not running". Those versions always use the bundled database, so
going back to one works only with it, not with an existing server.

**Backup**: stop the services (the database keeps running), save the database and every volume,
start again. In the bundle's folder:

```bash
mkdir -p -m 700 backup && docker compose stop web gateway identity edrms bpm intake land-records audit extracts nats
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup/database.dump
for v in edrms-files intake-files extracts-files natsdata bao-data bao-edrms bao-intake bao-audit bao-extracts; do
  docker run --rm --user 0 --entrypoint tar -v "lrfe_$v:/v:ro" -v "$PWD/backup:/b" \
    "lrfe-backend:$(grep ^LRFE_VERSION= .env | cut -d= -f2)" -czf "/b/$v.tgz" -C /v .
done
docker compose up -d
```

With an existing database server, leave out the `pg_dump` line and back up the database with the
server's own backup while the services are stopped. With OpenBao, stop it too before saving
(`docker compose stop openbao`), so its data is saved consistently; after `docker compose up -d` the key holders unseal it again. `bao-data` is OpenBao's
(sealed) data; `bao-edrms`, `bao-intake`, `bao-audit` and `bao-extracts` hold each service's OpenBao login;
`extracts-files` the sealed extract PDFs as issued. Without
OpenBao they are empty and cost nothing. Keep the backup and a copy of `.env` safely, readable only
by those who run the site: together they hold every secret.

**Restore** on a new server: install the same version (part B, steps 1 and 2, with the saved
`.env`), then, before the first full start:

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backup/database.dump
for v in edrms-files intake-files extracts-files natsdata bao-data bao-edrms bao-intake bao-audit bao-extracts; do
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

## H. Optional: the search engine's encrypted directory

The search engine (part I) keeps its index of the documents' text in a directory on
this server, never in a Docker volume: an **encrypted directory**, encrypted by the ext4 file system
itself (file names and contents; sizes, counts and dates stay visible). It needs no space reserved
in advance: it grows with the index and shares its disk's free space. Its key is made by OpenBao
(key `search-dir`); only the key in wrapped form is kept, in `<directory>.wrapped-key` beside it,
useless without OpenBao. The script `scripts/search_dir.py` (Python 3.8 or later, on the
server; no root) does all of it; the one-shot service `search-dir-key` asks OpenBao for the key, and
the guard `search-dir-check` lets the search engine start only on the encrypted, unlocked directory.

**What it protects against:** a stolen or discarded disk, copies of the server's image and cloud
snapshots, while the key is not added. Not against someone with root on the running server.

1. **Once per server, with root** (the server's administrator): switch on encryption for the file
   system that will hold the directory. Find its device with `df <a folder there>` (e.g. `/dev/md4`
   for `/home`), then:

   ```bash
   sudo tune2fs -O encrypt /dev/md4
   ```

   It works while the file system is mounted and in use and changes no data. It cannot easily be
   switched off again, and kernels older than 4.1 (2015) could no longer mount that file system.
   Needs Linux 5.4 or later, and an ext4 block size equal to the memory page size (4096 on usual
   servers: `stat -f -c %S <folder>`).
2. **OpenBao ready** (part D) and prepared by `docker compose run --rm openbao-setup` from this
   version on (it adds the key `search-dir` and its login; it keeps what works).
3. In `.env`: `OPENSEARCH_DATA_DIR`, a path that does not exist yet or an empty directory, outside
   the bundle's folder (e.g. `/home/lrfe/lrfe-data/opensearch`), and `OPENSEARCH_MIN_FREE_GB`
   (default 100).
4. As the user who runs Docker, in the bundle's folder (`deploy/` on a development server):

   ```bash
   python3 scripts/search_dir.py create
   ```

   It makes the directory, encrypts it with a new key and leaves it unlocked.
5. **After every reboot**, once OpenBao is unsealed and before the search engine starts:

   ```bash
   python3 scripts/search_dir.py unlock
   ```

   Until then the guard keeps the search engine stopped: it never writes an index into a locked or
   plain directory.
6. **Lock it** (e.g. before taking the server's disk away): stop the search engine, then
   `python3 scripts/search_dir.py lock`.
7. **Where it stands:** `python3 scripts/search_dir.py status` (encrypted, unlocked, space in
   use, free space; exit 0 only when the search engine may start); the readiness check reports the
   same and warns below `OPENSEARCH_MIN_FREE_GB`.

The options `--env <file> --project <name>` (before the command) work on another install of the same
compose file. **Backup:** keep a copy of `<directory>.wrapped-key` with the other backups (part F):
without it the directory cannot be opened; the index itself can be rebuilt from the documents or
restored from its own backup (API-806). To move the index to another method later (an encrypted
disk, a container file), change `OPENSEARCH_DATA_DIR` and restore or rebuild it there.

## I. Optional: the search engine

The search engine (OpenSearch, one node) holds the index of the documents' text, in the encrypted
directory of part H. It has no port on the host: it is reachable only on its own internal network,
by edrms (which reads) and the search service (which writes), over TLS, each service with its own
user that may only do its part, and only on the documents' indexes (`lrfe-documents*`). There is no
administrator password: users and roles are applied with a certificate kept inside the engine's
configuration.

1. Part H done: the directory created and unlocked.
2. In `.env`: add `search` to `COMPOSE_PROFILES` (e.g. `COMPOSE_PROFILES=postgres,bao,search`), and
   if needed the memory settings:
   - `OPENSEARCH_HEAP` (default `1g`): the engine's own memory; at most half of `OPENSEARCH_MEMORY`,
     never above `31g`. A small office: the defaults. A national register: see "Sizing" below.
   - `OPENSEARCH_MEMORY` (default `2g`): the most the container may use, the rest of it for the
     operating system's cache of the index. Docker applies it only where it can limit memory
     (not under rootless Docker without cgroup v2: there only the heap limits it).
3. `docker compose up -d`. On every start, in this order:
   - `search-dir-check` (part H) lets it go on only on the encrypted, unlocked directory;
   - `search-prepare` makes the engine's subfolders there (`data`, `logs`, `dumps`: its index,
     its logs and heap dumps, never in the container), its configuration (volume `search-config`),
     once its certificates (an authority of this install only) and once each service's login (user,
     password and the authority's certificate, in the volumes `search-login-edrms` and
     `search-login-search`, readable only by that service);
   - `opensearch` starts, healthy once it answers. Its log is in the directory too
     (`<directory>/logs/lrfe-search.log`, readable by the install user while it is unlocked);
     Docker's log (`docker compose logs opensearch`) has only its start and stop, since an error can
     quote a document's text;
   - `search-users` applies the users and roles (about a minute), then exits;
   - the search service (`search`) follows intake's and edrms' document events: each document read
     by the AI, rejected, filed or corrected. It catches up by itself after it was stopped (the
     event stream keeps events `EVENT_STREAM_MAX_AGE_DAYS`, 30 by default) and writes each document
     into the index (`lrfe-documents`): searchable within seconds of the AI's reading, with the
     corrected values once filed, gone when rejected. It logs only document numbers and sizes,
     never their text. The index's analysers follow the country's pack (`LRFE_COUNTRY_CODE`).
4. Check: the readiness check (`demo/check-readiness.mjs` in the source repository) shows the
   engine's health, whether edrms reaches it with its login, how many document events the search
   service has not handled yet (its lag), and the documents that kept failing to be indexed.
5. **Documents from before the search engine** (an install that ran without it): index them once
   with `docker compose exec search node src/reindex.js` (every document; it prints the counts).
6. **Search through the index** (optional, once step 5 is done): in `.env`, `EDRMS_SEARCH=opensearch`,
   then `docker compose up -d edrms`. The documents screen and a record's documents tab then search
   the documents' text as well, and list the documents still in intake (marked "In intake") to the
   users who may read intake. A search with more than 1,000 matches shows "more than 1,000". When the
   engine cannot answer, the search says so (it does not fall back to the database). Back to the
   database: `EDRMS_SEARCH=postgres` (the default), then `docker compose up -d edrms`.

**Documents that keep failing.** When intake, edrms or the engine cannot answer, the search service
tries again after 5 s, 10 s, 20 s, … (at most 5 minutes apart). After 8 failures the document is put
on a list (the readiness check shows the list: "documents not indexed", with each document's id and
the error) and is not tried again by itself. Once the cause is fixed, index the documents again
with `docker compose exec search node src/reindex.js --since <the date of the earliest failure>`;
a document indexed again leaves the list.

**Rebuild the index** (after a change of the index's design or the country's analysers, in a new
version): `docker compose exec search node src/reindex.js --rebuild`. It fills a new index while
search goes on with the old one, catches up, then switches over in one step; stopped or failed, it
resumes when run again. About 1½ hours for 200,000 documents on spinning disks (measured, API-804).

**Re-index since a date.** `docker compose exec search node src/reindex.js --since 2026-10-01T00:00:00Z`
indexes again every document uploaded, read, filed or corrected since then (after restoring an
older backup of the index, API-806). It can be run again safely; without `--since` it indexes all.

**Disk space.** From `OPENSEARCH_MIN_FREE_GB` (part H): below that much free space on its disk the
engine places no new index parts, below half of it it warns in its log, and below a quarter it takes
no more writes until there is space again (searching goes on). The readiness check warns from the
first.

**Sizing** (measured on a test register of 199,470 documents with their page text, API-805):

- **Disk:** the index takes about 8 KB per document (1.6 GB for 200,000): about 24 GB for
  3,000,000 documents, and 1.2 GB more for each 150,000 a year. Leave room for twice that: a
  rebuild (`--rebuild`) holds the old and the new index side by side until it switches over, and
  the engine needs free space to merge its files. `OPENSEARCH_MIN_FREE_GB` (default 100) comes on
  top.
- **Memory:** at 200,000 documents the engine used 0.8 GB of a 2 GB heap; searches stayed under
  0.1 s (95% of them, 8 at once) with the whole index in the operating system's cache. Give the
  container its heap plus about the index's size: `OPENSEARCH_HEAP=2g` and `OPENSEARCH_MEMORY=4g`
  up to about 300,000 documents; for 3,000,000, `8g` and `32g`.
- **Upgrading to this version:** the first start builds an index of the documents each land record
  holds (API-805); land records cannot be changed until it is built (6 s for 31,000 records).
- **The encrypted directory** (part H) costs no measurable speed once the index is in the cache:
  the same 600 searches took a median of 15 ms on it and on a plain copy. Right after a start the
  first searches read from disk and are slower (95% under 0.12 s instead of 0.03 s).

**For a national register**, the server's administrator should raise the number of memory areas a
process may map (once, with root): `sudo sysctl -w vm.max_map_count=262144`, and the same in
`/etc/sysctl.d/` to keep it after a reboot. A small install works without it.

**After a reboot:** unlock the directory (part H, step 5), then `docker compose up -d`. Until
then the engine cannot start (it restarts and fails until the directory is unlocked).

**To renew the certificates** (they last 10 years) or a login: remove the `search-config` volume (or
a `search-login-…` volume) after `docker compose stop opensearch edrms`, then `docker compose up -d`:
they are made again and applied. For the same reason these volumes need no backup; the index
itself has its own backup (API-806).
