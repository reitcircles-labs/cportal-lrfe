# backend/scripts

| Script | Run with (from `backend/`) | What it does |
|---|---|---|
| `dev.js` | `npm run dev` | Starts all five services and the API docs in one terminal |
| `openapi.js` | `npm run docs` · `npm run docs:check` | Generates `services/<name>/docs/openapi.yaml` · checks they are up to date |
| `docs-server.js` | `npm run docs:serve` | Swagger UI for the API docs on http://localhost:3510 |
| `remoteConnect.sh` | `./scripts/remoteConnect.sh 4200 3510` **on your laptop** | Opens the server's ports on your laptop over SSH, to test the app remotely |

## remoteConnect.sh: test the app from your laptop

The app and the services listen on the server's `localhost` only (they are not open to the
internet). This script forwards the ports you name over one SSH connection, so
`http://localhost:<port>` on your laptop reaches the same port on the server.

### One-time setup on the laptop

1. Copy `remoteConnect.sh` to your laptop (it is not run on the server).
2. Put the server's SSH key at `~/.ssh/id_rsa_oc` (or point `SSH_KEY` at it, see below) and make
   it private: `chmod 600 ~/.ssh/id_rsa_oc`.
3. Make the script runnable: `chmod +x remoteConnect.sh`.

macOS and Linux run it as it is; on Windows use Git Bash or WSL.

### Each time

1. **On the server**, start what you want to reach:
   ```bash
   cd backend && npm run dev                 # services + API docs (3500–3504, 3510)
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
SSH_KEY=~/keys/server.pem ./remoteConnect.sh 4200        # another key
DRY_RUN=1 ./remoteConnect.sh 4200 3510    # print the ssh command, do not connect
```

| Variable | Default |
|---|---|
| `SSH_KEY` | `~/.ssh/id_rsa_oc` |
| `SSH_PORT` | `2222` |
| `REMOTE` | `openclawuser@95.216.13.114` |

### When it does not work

| Symptom | Cause and fix |
|---|---|
| `bind [127.0.0.1]:4200: Address already in use` and the script stops | That port is in use on the laptop (often a local `ng serve`). Stop it, or use another laptop port: `./remoteConnect.sh 8080:4200` |
| `SSH key not found` | Put the key at `~/.ssh/id_rsa_oc` or set `SSH_KEY` |
| `Permission denied (publickey)` | Wrong key, or it is not authorised on the server |
| `UNPROTECTED PRIVATE KEY FILE` | `chmod 600` the key |
| The page does not load, or "connection refused" in the ssh window | Nothing is running on that port on the server: start it (step 1) |
| The app loads but sign-in fails | The backend is not running on the server: `cd backend && npm run dev` |
| The connection drops after a while | The script notices within about a minute and exits; run it again |

The sign-in cookie works because the browser sees `http://localhost`, as in local development.
Use the app at `localhost`, not at the server's address.
