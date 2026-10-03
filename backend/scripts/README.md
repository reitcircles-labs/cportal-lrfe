# backend/scripts

| Script | Run with (from `backend/`) | What it does |
|---|---|---|
| `dev.js` | `npm run dev` | Starts NATS, all five services and the API docs in one terminal; the services use NATS as their event bus |
| `nats.js` | `npm run nats` | Starts a local NATS server (port 4222, monitoring 8222, JetStream on); the first run downloads it into `backend/.tools/`, checked against the release's SHA-256 |
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
