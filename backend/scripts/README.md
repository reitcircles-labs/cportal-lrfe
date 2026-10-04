# backend/scripts

| Script | Run with (from `backend/`) | What it does |
|---|---|---|
| `dev.js` | `npm run dev` | Starts NATS, all five services and the API docs in one terminal; the services use NATS as their event bus |
| `nats.js` | `npm run nats` | Starts a local NATS server (port 4222, monitoring 8222, JetStream on); the first run downloads it into `backend/.tools/`, checked against the release's SHA-256 |
| `bao.js` | `npm run bao` (asks: development or production?) · `-- --dev` · `-- --prod` | Development: a local OpenBao vault on http://127.0.0.1:8200, data in `~/data/cportal-lrfe/openbao` (outside git); the first run downloads it into `backend/.tools/`, checked against the release's SHA-256, and initialises it. Production: refuses; see [OpenBao: installation rules](#openbao-installation-rules) |
| `openapi.js` | `npm run docs` · `npm run docs:check` | Generates `services/<name>/docs/openapi.yaml` · checks they are up to date |
| `docs-server.js` | `npm run docs:serve` | Swagger UI for the API docs on http://localhost:3510 |
| `remoteConnect.sh` | `./scripts/remoteConnect.sh 4200 3510` **on your laptop** | Opens the server's ports on your laptop over SSH, to test the app remotely |

## remoteConnect.sh: test the app from your laptop

The app and the services listen on the server's `localhost` only (they are not open to the
internet). This script forwards the ports you name over one SSH connection, so
`http://localhost:<port>` on your laptop reaches the same port on the server.

### One-time setup on the laptop

1. Copy `remoteConnect.sh` to your laptop (it is not run on the server) and make it runnable:
   `chmod +x remoteConnect.sh`. macOS and Linux run it as it is; on Windows use Git Bash or WSL.
2. Put your SSH key on the laptop and make it private: `chmod 600 ~/.ssh/<key>`. The script
   refuses a key that other users can read.
3. Create the config file and fill it in:
   ```bash
   ./remoteConnect.sh --setup     # creates ~/.config/remote-connect/config (private to you)
   ```
   ```ini
   REMOTE=<user>@<server address>
   SSH_PORT=<ssh port>
   SSH_KEY=~/.ssh/<key>
   HOST_KEY=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPZ3VxFKj6iMNHAXNx1kYVkY6FswqZ6rrPfHEWIv5aBB
   ```
   Ask the server's administrator for `REMOTE`, `SSH_PORT` and your key; they are deliberately
   not in the repository. `HOST_KEY` above is the server's public host key. Its fingerprint is
   `SHA256:WCoYtQqsLIliPwfNolgul92sDCcuSgsJyC8zO6FMAH8` (ED25519); the administrator can confirm it
   with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.

### Each time

1. **On the server**, start what you want to reach:
   ```bash
   cd backend && npm run dev                 # NATS + services + API docs (4222, 3500–3504, 3510)
   cd angular-app && npx ng serve            # the app (4200)
   ```
2. **On the laptop**, connect and keep the window open:
   ```bash
   ./remoteConnect.sh 4200 3510
   ```
   It prints the URLs to open, e.g. http://localhost:4200 (the app) and http://localhost:3510
   (the API docs). **Ctrl+C** disconnects.

### Which ports

| Port | What | Forward it when |
|---|---|---|
| **4200** | the app (`ng serve`) | always: this alone runs the app, since `ng serve` passes `/api` to the gateway on the server |
| 3510 | API docs (Swagger UI) | you want to browse or try the API |
| 3500 | gateway | you call the API directly (curl, Postman) |
| 3501–3504 | identity, edrms, bpm, intake | debugging one service directly |

### Options

```bash
./remoteConnect.sh 4200 3510              # several ports at once
./remoteConnect.sh 8080:4200              # LAPTOP_PORT:SERVER_PORT, when 4200 is already used on the laptop
SSH_KEY=~/keys/other ./remoteConnect.sh 4200             # override a config value for one run
DRY_RUN=1 ./remoteConnect.sh 4200 3510    # print the ssh command, do not connect
```

`REMOTE`, `SSH_PORT`, `SSH_KEY` and `HOST_KEY` set in the environment override the config file.
The config is only read as `KEY=VALUE` lines, never run as a script.

### What the script does to keep the connection safe

- **Forwards are bound to `127.0.0.1` on the laptop**, so nobody else on the same Wi-Fi or office
  network can use them, whatever the laptop's own ssh settings say (`GatewayPorts`).
- **They reach only the server's `127.0.0.1`**, i.e. the local services, not other machines.
- **The server's host key is pinned.** A first connection is not trusted blindly, and a changed
  key stops the connection (`Host key verification failed`) instead of being accepted.
- **Only the configured key is offered** (`IdentitiesOnly`); your ssh agent and X11 are not
  forwarded to the server.
- It refuses a key readable by other users, laptop ports below 1024 (which would need root),
  running as root, and server addresses containing unexpected characters.

### When it does not work

| Symptom | Cause and fix |
|---|---|
| `bind [127.0.0.1]:4200: Address already in use` and the script stops | That port is in use on the laptop (often a local `ng serve`). Stop it, or use another laptop port: `./remoteConnect.sh 8080:4200` |
| `No server configured` | Run `./remoteConnect.sh --setup` and fill in the config file |
| `SSH key not found` / `can be read by other users` | Check `SSH_KEY` in the config; `chmod 600` the key |
| `No HOST_KEY configured` | Add the `HOST_KEY` line from the setup above |
| **`Host key verification failed`** / `host key … has changed` | **Stop. Do not remove or replace the key**, even if ssh suggests it: either the server was reinstalled or someone is intercepting the connection. Ask the administrator for the current host key fingerprint and compare. |
| `Permission denied (publickey)` | Wrong key, or it is not authorised on the server |
| The page does not load, or "connection refused" in the ssh window | Nothing is running on that port on the server: start it (step 1) |
| The app loads but sign-in fails | The backend is not running on the server: `cd backend && npm run dev` |
| The connection drops after a while | The script notices within about a minute and exits; run it again |

The sign-in cookie works because the browser sees `http://localhost`, as in local development.
Use the app at `localhost`, not at the server's address.

## OpenBao: installation rules

OpenBao (the open-source fork of HashiCorp Vault) is the project's secrets vault: it will hold the
services' secrets and the keys that encrypt stored documents. These rules decide **who may run it,
where its data lives and how it is backed up**. `bao.js` installs it for development only; a
production installation is done by an administrator, following the production rules below.

### Development: `npm run bao -- --dev`

| What | Where / how |
|---|---|
| Program | OpenBao 2.7.1, downloaded on the first run into `backend/.tools/openbao-2.7.1/` (git-ignored), checked against the release's SHA-256 checksums |
| Runs as | Your own user. Fine for development only |
| Address | `http://127.0.0.1:8200` (`BAO_PORT` for another port), no TLS: reachable from this server only |
| Data | Integrated Raft storage in `~/data/cportal-lrfe/openbao` (`BAO_DATA_DIR`), outside git, folder `0700`, files `0600` |
| Unseal key and root token | `dev-init.json` in the data folder, written on the first start and used to unseal on later starts. **Development only:** never copy it elsewhere, never use this setup for real secrets |

Using the command line while it runs:

```bash
export BAO_ADDR=http://127.0.0.1:8200
export BAO_TOKEN=$(node -p "require(process.env.HOME + '/data/cportal-lrfe/openbao/dev-init.json').rootToken")
.tools/openbao-2.7.1/bao status
```

Ctrl+C stops it. To start over on a development system, stop it and delete the data folder.

### Memory locking and swap

OpenBao 2.x never locks its memory: mlock was removed in OpenBao 2.0, and the `disable_mlock`
setting is obsolete (it only logs "unknown or unsupported field"). Vault's advice for integrated
storage was `disable_mlock = true` anyway. The consequence: **on a machine with swap, key material
can be written to swap.** Acceptable for development; in production use encrypted swap or no swap.

### Production rules

`npm run bao -- --prod` refuses to install. In production:

1. **Never run OpenBao as the same user as the portal.** Anything running as the same user (the
   services, a shell) could read OpenBao's data folder, configuration and process. An administrator
   creates a dedicated `openbao` user with no login shell, and runs OpenBao as a system service
   (systemd) under that user, started at boot.
2. **TLS on the listener**, with a certificate the services trust. Listen only where the services
   can reach it, never on the internet.
3. **Data folder owned by `openbao`, mode `0700`**, on an encrypted disk (LUKS). Swap encrypted or
   off (see above).
4. **Unseal keys split among named people** (Shamir, e.g. 5 shares, any 3 unseal), each kept by a
   different person, or automatic unsealing by a hardware security module (PKCS#11). Unseal keys are
   **never** stored with the data, the configuration or the backups. Write down who holds them and
   what to do after a restart (OpenBao starts sealed).
5. **Root token only for the initial setup**, then revoked; administrators and services get their
   own logins and policies. Turn on an audit device and keep its log with the portal's audit trail.

### Storage: why not the portal's PostgreSQL

OpenBao keeps its data in **integrated Raft storage on its own disk**, as OpenBao recommends: no
extra software, and OpenBao encrypts everything before writing it. OpenBao can also store its data
in PostgreSQL, but **not in the portal's database**: if that database fails, the vault fails with
it and nothing can be decrypted, not even from backups; and the portal's database administrators
would control the vault's storage (they could delete it, making every document unreadable). If
PostgreSQL is ever wanted, it must be a separate cluster with its own backups.

### Backups

| Do | Do not |
|---|---|
| `bao operator raft snapshot save <file>`: a consistent snapshot, taken while OpenBao runs | `tar.gz` of the live data folder: the database files are open and changing; the copy may not restore |
| Run it from cron with a token that may only take snapshots; check it with `bao operator raft snapshot inspect` | Keep the only copy on the same server |
| Copy snapshots off-site, ideally to storage that cannot be overwritten; keep a history (e.g. 30 daily, 12 monthly, 7 yearly) | Keep the unseal keys next to the snapshots: a snapshot with its unseal keys gives access to everything |
| Back up the configuration file and TLS certificates with the server's configuration | |
| **Restore drill**, e.g. monthly: restore the latest snapshot into a throwaway OpenBao (`bao operator raft snapshot restore <file>`), unseal it, decrypt a sample document | Assume a backup works before it has been restored |

```bash
# cron, e.g. 15 2 * * *  (production: runs as the openbao user, with TLS)
f=/var/backups/openbao/bao-$(date +%F).snap
bao operator raft snapshot save "$f" && bao operator raft snapshot inspect "$f" >/dev/null
```

### One node, and moving to three

`bao.js` runs a single node: no high availability. If OpenBao or its server is down, no document
can be stored or opened, and if the server is lost, only the off-site snapshots remain. Production
should run three OpenBao nodes (ideally across two sites); Raft lets nodes join the existing
cluster (`bao operator raft join`), so a single node can grow without starting over.

References: [OpenBao storage](https://openbao.org/docs/configuration/storage/),
[integrated storage (Raft)](https://openbao.org/docs/configuration/storage/raft/),
[mlock removal](https://openbao.org/docs/rfcs/mlock-removal).
