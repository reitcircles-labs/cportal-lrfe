# cportal-lrfe: Deeds Registry land records

Scanned deeds go into an EDRMS as documents of record: AI reads each scan, reviewers check and
correct the extracted metadata, and verified documents are filed as sealed records. Administrators
manage offices, users, roles and security policies.

| Folder | What | Details |
|---|---|---|
| `angular-app/` | The web app (Angular 22) | [angular-app/README.md](angular-app/README.md), user guides in [angular-app/docs/](angular-app/docs/README.md) |
| `backend/` | Five Node.js services behind one gateway | [backend/README.md](backend/README.md) |
| `backend/services/identity/` | Sign-in, MFA, users, offices, roles, email | [identity README](backend/services/identity/README.md) |
| `backend/scripts/` | `npm run dev`, API docs, remote access | [scripts README](backend/scripts/README.md) |

## Running it locally

### Prerequisites

- **Node.js 24.15+ or 22.22+** (Angular 22 needs one of these; check with `node -v`).
- **PostgreSQL**, or none at all for a quick look (see [Without a database](#without-a-database)).
- Optional: **tmux**, to keep everything running after you close the terminal or SSH session.

### First time only

```bash
cd backend && npm install
cd ../angular-app && npm install
```

Each backend service reads its own `.env` file, `backend/services/<name>/.env` (never committed).
Create them from [backend/.env_example](backend/.env_example), which explains every setting.
`JWT_SECRET` must be the same in all five. The identity README covers
[email](backend/services/identity/README.md#email-invitations) and the
[first sign-in](backend/services/identity/README.md#first-sign-in).

After pulling changes, run `npm install` again in both folders if `package-lock.json` changed.

### Start

Two processes: the backend (five services and the API docs) and the frontend. With tmux:

```bash
tmux new -s lr                          # a session named "lr"
cd backend && npm run dev               # window 1: backend; wait for the services to start
# Ctrl-b c   opens a second window
cd angular-app && npm start             # window 2: frontend
# Ctrl-b d   leaves tmux; everything keeps running. Back to it: tmux attach -t lr
```

Without tmux, use two terminals for the same two commands.

Then open **http://localhost:4200**. The frontend passes every `/api/...` request to the gateway,
so no other port is needed in the browser.

| Port | What |
|---|---|
| 4200 | the web app (`npm start` in `angular-app`) |
| 3500 | gateway: the only backend entry point the app uses |
| 3501 · 3502 · 3503 · 3504 | identity · edrms · bpm · intake |
| 3510 | API docs (Swagger UI), started by `npm run dev` |

**Started correctly when:** the backend log shows each service listening, with no errors from
identity (it connects to the database first). With email configured, identity also logs
`email: … accepted the connection and login`.

### Stop

`Ctrl-C` in each window, or `tmux kill-session -t lr`. To see what is still running:

```bash
ss -ltnp | grep -E ':(350[0-4]|3510|4200) '
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

The system starts with no offices and one administrator (`BOOTSTRAP_ADMIN_*` in identity's `.env`).

1. **Sign in** as that administrator. The first sign-in sets up two-step sign-in: scan the QR code
   with an authenticator app. Password or authenticator lost? See
   [The admin cannot sign in](backend/services/identity/README.md#the-admin-cannot-sign-in).
2. **Administration → Offices → Add office** for each location (e.g. `WDH` Deeds Registry ·
   Windhoek). Users are invited into an office, so this comes first.
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
| One service only | `npm run dev:identity`, `dev:edrms`, `dev:bpm`, `dev:intake`, `dev:gateway` |
| Everything in containers | `docker compose up -d --build` (see [backend/README.md](backend/README.md)) |

Frontend: `npm start` (development server), `npm run build` (production build), in `angular-app/`.
