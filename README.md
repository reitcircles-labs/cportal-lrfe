# cportal-lrfe: land records and more, on one platform

Scanned deeds go into an EDRMS as documents of record: AI reads each scan, reviewers check and
correct the extracted metadata, and verified documents are filed as sealed records. Administrators
manage offices, users, roles and security policies.

The land registry is the first product on a shared platform; shipping (electronic bills of
lading) is the next. Where each app and service lives, the domain packs (`LRFE_DOMAIN`) and how to
add a product: [docs/architecture/products.md](docs/architecture/products.md).

| Folder | What | Details |
|---|---|---|
| `angular-app/` | The web apps (Angular 22): `projects/land-registry`, `projects/shipping` and their shared library `projects/platform` | [angular-app/README.md](angular-app/README.md), user guides in [angular-app/docs/](angular-app/docs/README.md) |
| `backend/` | Node.js services behind one gateway: `services/`, shared `packages/`, a domain pack per product in `domains/` | [backend/README.md](backend/README.md) |
| `backend/services/identity/` | Sign-in, MFA, users, offices, roles, email | [identity README](backend/services/identity/README.md) |
| `backend/scripts/` | `npm run dev`, API docs, remote access | [scripts README](backend/scripts/README.md) |
| `e2e/` | End-to-end tests in a browser: sign-in, every role × screen and role × endpoint | [e2e/README.md](e2e/README.md) |
| `docs/` | How code is written: the style guide, lint and format checks; the products on the platform | [docs/coding-guide.md](docs/coding-guide.md), [docs/architecture/products.md](docs/architecture/products.md) |

## Running it locally

### Prerequisites

- **Node.js 24.22.1+ or 22.23.4+** (Angular 22 needs 24 or 22; these patch versions have the
  security fixes of 21 October 2026; check with `node -v`).
- **PostgreSQL**, or none at all for a quick look (see [Without a database](#without-a-database)).
- Optional: **tmux**, to keep everything running after you close the terminal or SSH session.

### First time only

```bash
cd backend && npm install
cd ../angular-app && npm install
```

Each backend service reads its own `.env` file, `backend/services/<name>/.env` (never committed).
Create them from [backend/.env_example](backend/.env_example), which explains every setting.
`JWT_SECRET` must be the same in all of them. Documents are stored on disk unless S3 is configured: set
`INTAKE_LOCAL_DIR` and `EDRMS_LOCAL_DIR` to folders **outside** the repository (e.g.
`~/data/cportal-lrfe/intake-store` and `…/edrms-store`) and back them up together with the database,
which refers to every file in them. The identity README covers
[email](backend/services/identity/README.md#email-invitations) and the
[first sign-in](backend/services/identity/README.md#first-sign-in).

After pulling changes, run `npm install` again in both folders if `package-lock.json` changed.

### Start

Two processes: the backend (the services and the API docs) and the frontend. With tmux:

```bash
tmux new -s lr                          # a session named "lr"
cd backend && npm run dev               # window 1: NATS + backend; wait for the services to start
# Ctrl-b c   opens a second window
cd angular-app && npm start             # window 2: frontend (the land registry)
# Ctrl-b d   leaves tmux; everything keeps running. Back to it: tmux attach -t lr
```

Without tmux, use two terminals for the same two commands.

Then open **http://localhost:4200**. The frontend passes every `/api/...` request to the gateway,
so no other port is needed in the browser. The shipping app runs with `npm run start:shipping` in
`angular-app/`, on http://localhost:4201.

The product of the backend is chosen by `LRFE_DOMAIN` (`land` when not set, so nothing to do for
the land registry; `shipping` is an empty pack for now): for example
`LRFE_DOMAIN=shipping npm run dev`.

| Port | What |
|---|---|
| 4200 | the land registry web app (`npm start` in `angular-app`) |
| 4201 | the shipping web app (`npm run start:shipping` in `angular-app`) |
| 3500 | gateway: the only backend entry point the apps use |
| 3501 · 3502 · 3503 · 3504 | identity · edrms · bpm · intake |
| 3505 · 3506 · 3507 · 3508 | land-records · audit · extracts · search |
| 3510 | API docs (Swagger UI), started by `npm run dev` |
| 4222 · 8222 | NATS, the event bus between the services · its monitoring page; started by `npm run dev` |

**Started correctly when:** the backend log shows each service listening and
`event bus: connected to NATS`, with no errors from identity (it connects to the database first).
The first run downloads the NATS server into `backend/.tools/`. With email configured, identity also logs
`email: … accepted the connection and login`.

### Stop

`Ctrl-C` in each window, or `tmux kill-session -t lr`. To see what is still running:

```bash
ss -ltnp | grep -E ':(350[0-8]|3510|420[01]) '
```

A service started on its own (`npm run dev:identity`, an old copy) keeps its port busy, and
`npm run dev` then reports `… is taken`; stop that copy first. Old copies also share the database
and may process work with old code.

### Using the app on a server from your laptop

Start everything on the server as above, then on the laptop:

```bash
./remoteConnect.sh 4200 3510
```

and open http://localhost:4200. Port 4200 alone is enough for the app; 3510 adds the API docs.
Setup and troubleshooting: [backend/scripts/README.md](backend/scripts/README.md).

### Without a database

For a quick look, everything in memory (data is lost when stopped), the AI replaced by a canned
answer, emails written to files, and 14 fictitious demo users:

```bash
cd backend
IDENTITY_STORE=memory EDRMS_STORE=memory EDRMS_STORAGE=memory BPM_STORE=memory \
INTAKE_STORE=memory INTAKE_STORAGE=memory EXTRACTION_PROVIDER=mock MAIL_TRANSPORT=file \
SEED_DEMO_PASSWORD='demo-password-2026' npm run dev
```

These settings override the `.env` files for this run only. Sign in as `p.hamutenya@deeds.gov.na`
(administrator) or `d.garoeb@deeds.gov.na` (scan operator and reviewer) with that password. Never
set `SEED_DEMO_PASSWORD` against a shared database.

## First steps in a new system

A new system starts with one administrator (`BOOTSTRAP_ADMIN_*` in identity's `.env`) and Namibia's
two deeds offices, `WDH` Deeds Registry · Windhoek and `REH` Deeds Registry · Rehoboth (created
when the database has no offices).

1. **Sign in** as that administrator. The first sign-in sets up two-step sign-in: scan the QR code
   with an authenticator app. Password or authenticator lost? See
   [The admin cannot sign in](backend/services/identity/README.md#the-admin-cannot-sign-in).
2. **Administration → Offices**: check the two deeds offices (fill in Rehoboth's address and
   contacts) and add any other location, e.g. the Office of the Auditor-General as an external body
   for auditors. Users are invited into an office.
3. **Users → Invite user**: they get an email with an activation link. Step by step, including a
   test you can run with your own address:
   [Inviting users and assigning roles](angular-app/docs/user-guide/inviting-users-and-assigning-roles.md).

## Developing

| Task | Command (in `backend/`) |
|---|---|
| All tests (no database or network needed) | `npm test` |
| Tests of one service | `npm test -w @lrfe/identity` |
| Regenerate the API docs after changing routes | `npm run docs` (`npm run docs:check` fails if they are out of date) |
| Browse the API docs | `npm run docs:serve`, http://localhost:3510 (also part of `npm run dev`) |
| One service only | `npm run dev:identity`, `dev:edrms`, `dev:bpm`, `dev:intake`, `dev:land-records`, `dev:audit`, `dev:extracts`, `dev:search`, `dev:gateway` |
| Everything in containers (build, run, export for a site) | see [deploy/README.md](deploy/README.md) |

Frontend, in `angular-app/`: `npm start` and `npm run build` for the land registry,
`npm run start:shipping` and `npm run build:shipping` for the shipping app. Lint and format, at the
root: `npm run -s lint` (it includes the guard that keeps shared code from importing product
code) and `npm run -s format:check`.
